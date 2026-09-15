import { createHash, randomBytes } from 'node:crypto';
import { and, eq, lt, ne } from 'drizzle-orm';
import type { AstroCookies } from 'astro';
import { db as defaultDb, type Database } from '../db/client';
import { barbers, sessions, users, type Session, type User, type UserRole } from '../db/schema';
import { hashPassword, needsRehash, verifyPassword } from './password';

/** Usuario autenticado tal como lo expone el middleware en `Astro.locals.user`. */
export interface SessionUser {
  id: number;
  /** Nombre de usuario de login (los barberos usan uno simple; el admin puede usar su email). */
  username: string;
  role: UserRole;
  /** Null para admin. */
  barberId: number | null;
}

export const SESSION_COOKIE = 'nlb_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días
const SESSION_RENEW_BEFORE_MS = 15 * 24 * 60 * 60 * 1000; // renovar si quedan < 15 días

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function toSessionUser(user: User): SessionUser {
  return { id: user.id, username: user.username, role: user.role, barberId: user.barberId };
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/**
 * Verifica usuario + contraseña. Devuelve el usuario o null (mismo resultado
 * para "no existe", "contraseña incorrecta" y "barbero desactivado"). Si el
 * hash es scrypt heredado, lo migra a bcrypt de forma transparente.
 */
export async function authenticate(
  username: string,
  password: string,
  database: Database = defaultDb,
): Promise<User | null> {
  const normalized = username.trim().toLowerCase();
  const user = await database.query.users.findFirst({ where: eq(users.username, normalized) });
  if (!user) {
    // Coste comparable al de una verificación real para no filtrar si el usuario existe.
    await verifyPassword(password, '$2a$12$C6UzMDM.H6dfI/f/IKcEeO7ZKzZPr5wtmBl1Zf0bdrQvJQeVvsQPq');
    return null;
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return null;

  // Un barbero desactivado desde el panel no puede entrar (misma respuesta
  // que una contraseña incorrecta). Se reactiva sin tocar su contraseña.
  if (user.role === 'barber' && user.barberId !== null) {
    const barber = await database.query.barbers.findFirst({
      columns: { isActive: true },
      where: eq(barbers.id, user.barberId),
    });
    if (barber && !barber.isActive) return null;
  }

  if (needsRehash(user.passwordHash)) {
    const passwordHash = await hashPassword(password);
    await database.update(users).set({ passwordHash }).where(eq(users.id, user.id));
  }
  return user;
}

// ---------------------------------------------------------------------------
// Sesiones
// ---------------------------------------------------------------------------

export async function createSession(
  userId: number,
  database: Database = defaultDb,
): Promise<{ token: string; session: Session }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const [session] = await database
    .insert(sessions)
    .values({ id: hashToken(token), userId, expiresAt })
    .returning();
  return { token, session };
}

/**
 * Valida el token de la cookie. Devuelve sesión + usuario, o null si no
 * existe o expiró (las expiradas se borran). Renueva la expiración cuando
 * queda menos de la mitad de la vida útil.
 */
export async function validateSession(
  token: string,
  database: Database = defaultDb,
): Promise<{ session: Session; user: SessionUser } | null> {
  const id = hashToken(token);
  const row = await database.query.sessions.findFirst({
    where: eq(sessions.id, id),
    with: { user: true },
  });
  if (!row) return null;

  if (row.expiresAt.getTime() <= Date.now()) {
    await database.delete(sessions).where(eq(sessions.id, id));
    return null;
  }

  let session: Session = row;
  if (row.expiresAt.getTime() - Date.now() < SESSION_RENEW_BEFORE_MS) {
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await database.update(sessions).set({ expiresAt }).where(eq(sessions.id, id));
    session = { ...row, expiresAt };
  }

  return { session, user: toSessionUser(row.user) };
}

export async function invalidateSession(token: string, database: Database = defaultDb) {
  await database.delete(sessions).where(eq(sessions.id, hashToken(token)));
}

/** Cierra todas las sesiones de un usuario (p. ej. al desactivarlo o resetear su contraseña). */
export async function invalidateUserSessions(userId: number, database: Database = defaultDb) {
  await database.delete(sessions).where(eq(sessions.userId, userId));
}

/** Cierra las demás sesiones de un usuario conservando la del token indicado. */
export async function invalidateOtherUserSessions(
  userId: number,
  keepToken: string,
  database: Database = defaultDb,
) {
  await database
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.id, hashToken(keepToken))));
}

export type ChangePasswordResult = { ok: true } | { ok: false; code: 'WRONG_PASSWORD' | 'USER_NOT_FOUND' };

/**
 * Cambio de contraseña desde "Mi cuenta": exige la contraseña actual y, al
 * cambiarla, cierra las demás sesiones del usuario conservando la actual
 * (`keepToken`) para no expulsarlo en el acto.
 */
export async function changePassword(
  userId: number,
  currentPassword: string,
  newPassword: string,
  keepToken: string | null,
  database: Database = defaultDb,
): Promise<ChangePasswordResult> {
  const user = await database.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return { ok: false, code: 'USER_NOT_FOUND' };
  if (!(await verifyPassword(currentPassword, user.passwordHash))) return { ok: false, code: 'WRONG_PASSWORD' };

  const passwordHash = await hashPassword(newPassword);
  await database.update(users).set({ passwordHash }).where(eq(users.id, userId));
  if (keepToken) await invalidateOtherUserSessions(userId, keepToken, database);
  else await invalidateUserSessions(userId, database);
  return { ok: true };
}

/** Limpieza oportunista de sesiones vencidas. */
export async function deleteExpiredSessions(database: Database = defaultDb) {
  await database.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}

// ---------------------------------------------------------------------------
// Cookie
// ---------------------------------------------------------------------------

export function setSessionCookie(cookies: AstroCookies, token: string, expiresAt: Date) {
  cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: import.meta.env.PROD,
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(cookies: AstroCookies) {
  cookies.delete(SESSION_COOKIE, { path: '/' });
}
