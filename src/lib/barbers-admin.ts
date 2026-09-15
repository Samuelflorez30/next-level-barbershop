/**
 * Gestión de barberos desde el panel (solo admin): alta, edición,
 * activar/desactivar y contraseña de rescate.
 *
 * No existe "borrar barbero": un barbero inactivo conserva citas e
 * historial, pero no aparece en la web, no recibe reservas y no puede
 * iniciar sesión (ver `authenticate` en src/lib/auth.ts).
 *
 * Los usuarios existentes NUNCA se tocan desde aquí: solo se crean
 * credenciales para barberos nuevos, y `resetBarberPassword` es una acción
 * explícita y confirmada del admin sobre un barbero concreto.
 */
import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { z } from 'astro/zod';
import { db as defaultDb, type Database } from '../db/client';
import { isUniqueViolation } from '../db/errors';
import { barberSchedules, barberServices, barbers, services, users, type Barber } from '../db/schema';
import { invalidateUserSessions } from './auth';
import { DEFAULT_BARBER_ROLE, WEEKLY_SCHEDULE } from './barber-defaults';
import { USERNAME_PATTERN, slugFromName, usernameFromName, withUniqueSuffix } from './barber-names';
import { PanelError } from './panel';
import { generateTemporaryPassword, hashPassword } from './password';

// ---------------------------------------------------------------------------
// Validación (mensajes en español: se muestran junto al campo en el panel)
// ---------------------------------------------------------------------------

const nameField = z
  .string('Escribe el nombre del barbero.')
  .trim()
  .min(2, 'El nombre debe tener al menos 2 letras.')
  .max(80, 'El nombre no puede pasar de 80 caracteres.');

/** Vacío → "Master Barber". */
const roleField = z
  .string('El rol debe ser texto.')
  .trim()
  .max(60, 'El rol no puede pasar de 60 caracteres.')
  .transform((v) => v || DEFAULT_BARBER_ROLE);

/** Opcional; vacío → null. */
const quoteField = z
  .string('La frase debe ser texto.')
  .trim()
  .max(160, 'La frase no puede pasar de 160 caracteres.')
  .nullable()
  .transform((v) => v || null);

/**
 * Acepta "314 291 5681", "+57 314 291 5681", "3142915681"… y guarda solo
 * dígitos. Si son 10 dígitos (celular colombiano) antepone el 57.
 */
const phoneField = z.string('Escribe el número de WhatsApp.').trim().transform((raw, ctx) => {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) {
    ctx.addIssue({ code: 'custom', message: 'El WhatsApp debe tener entre 10 y 15 dígitos (ej. 314 291 5681).' });
    return z.NEVER;
  }
  return digits.length === 10 ? `57${digits}` : digits;
});

/** Ruta dentro de /public ("/carlos.jpg") o URL http(s). Vacío → null. */
const photoUrlField = z
  .string('La foto debe ser texto.')
  .trim()
  .max(500, 'La ruta de la foto es demasiado larga.')
  .nullable()
  .transform((v) => v || null)
  .refine(
    (v) => v === null || (v.startsWith('/') && !v.startsWith('//')) || /^https?:\/\/\S+$/i.test(v),
    'Escribe una ruta que empiece por "/" (ej. /carlos.jpg) o una dirección completa (https://…).',
  );

const serviceIdsField = z
  .array(z.number().int().positive(), 'Los servicios deben ser una lista de ids.')
  .max(100, 'Demasiados servicios.');

const usernameField = z
  .string('El usuario debe ser texto.')
  .trim()
  .toLowerCase()
  .regex(USERNAME_PATTERN, 'El usuario solo puede tener letras y números, sin espacios ni tildes (2 a 40 caracteres).');

const createSchema = z.object({
  name: nameField,
  role: roleField.optional(),
  quote: quoteField.optional(),
  phoneWhatsapp: phoneField,
  photoUrl: photoUrlField.optional(),
  /** Si no se envía, ofrece todos los servicios activos. */
  serviceIds: serviceIdsField.optional(),
  /** Si no se envía, se deriva del nombre (con sufijo 2, 3… si ya existe). */
  username: usernameField.optional(),
});

const updateSchema = z.object({
  name: nameField.optional(),
  role: roleField.optional(),
  quote: quoteField.optional(),
  phoneWhatsapp: phoneField.optional(),
  photoUrl: photoUrlField.optional(),
  serviceIds: serviceIdsField.optional(),
});

export type CreateBarberInput = z.input<typeof createSchema>;
export type UpdateBarberInput = z.input<typeof updateSchema>;

export type FieldErrors = Record<string, string[] | undefined>;

/** Cliente dentro de `database.transaction(async (tx) => …)`. */
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

function validationError(fieldErrors: FieldErrors): PanelError {
  return new PanelError(422, 'VALIDATION_ERROR', 'Revisa los campos marcados.', fieldErrors);
}

function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.output<T> {
  const result = schema.safeParse(raw);
  if (!result.success) throw validationError(z.flattenError(result.error).fieldErrors as FieldErrors);
  return result.data;
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

export interface AdminBarber extends Barber {
  /** Ids de servicios con `isOffered = true`. */
  serviceIds: number[];
  servicesCount: number;
  /** Usuario de login del barbero (null si no tiene cuenta). */
  username: string | null;
}

function toAdminBarber(row: Barber & { barberServices: { serviceId: number; isOffered: boolean }[]; user: { username: string } | null }): AdminBarber {
  const { barberServices: offerings, user, ...barber } = row;
  const serviceIds = offerings.filter((o) => o.isOffered).map((o) => o.serviceId);
  return { ...barber, serviceIds, servicesCount: serviceIds.length, username: user?.username ?? null };
}

const withDetails = {
  barberServices: { columns: { serviceId: true, isOffered: true } },
  user: { columns: { username: true } },
} as const;

/** Todos los barberos (activos primero, luego por orden de aparición) con conteo de servicios. */
export async function listBarbersAdmin(database: Database = defaultDb): Promise<AdminBarber[]> {
  const rows = await database.query.barbers.findMany({
    with: withDetails,
    orderBy: [asc(barbers.displayOrder), asc(barbers.id)],
  });
  return rows.map(toAdminBarber).sort((a, b) => Number(b.isActive) - Number(a.isActive));
}

export async function getBarberAdmin(id: number, database: Database = defaultDb): Promise<AdminBarber> {
  const row = await database.query.barbers.findFirst({ where: eq(barbers.id, id), with: withDetails });
  if (!row) throw new PanelError(404, 'BARBER_NOT_FOUND', 'Barbero no encontrado.');
  return toAdminBarber(row);
}

/** Servicios activos, para los checkboxes del formulario. */
export function listActiveServices(database: Database = defaultDb) {
  return database.query.services.findMany({
    columns: { id: true, name: true, defaultPrice: true },
    where: eq(services.isActive, true),
    orderBy: [asc(services.displayOrder), asc(services.id)],
  });
}

/** Usuarios ya tomados, para sugerir en el formulario un usuario libre. */
export async function listUsernames(database: Database = defaultDb): Promise<string[]> {
  const rows = await database.select({ username: users.username }).from(users);
  return rows.map((r) => r.username);
}

/** Verifica que todos los ids existan; sin lista → todos los servicios activos. */
async function resolveServiceIds(requested: number[] | undefined, database: Database): Promise<number[]> {
  if (requested === undefined) return (await listActiveServices(database)).map((s) => s.id);
  const unique = [...new Set(requested)];
  if (unique.length === 0) return [];
  const found = await database.query.services.findMany({
    columns: { id: true },
    where: inArray(services.id, unique),
  });
  if (found.length !== unique.length) {
    throw validationError({ serviceIds: ['Alguno de los servicios seleccionados no existe.'] });
  }
  return unique;
}

// ---------------------------------------------------------------------------
// Alta
// ---------------------------------------------------------------------------

export interface Credentials {
  username: string;
  password: string;
}

/**
 * Crea el barbero completo en UNA transacción: fila en `barbers`, sus
 * `barber_services`, el horario semanal por defecto y su usuario del panel
 * con contraseña temporal. Devuelve las credenciales (la contraseña solo se
 * muestra esta vez: en la DB queda el hash).
 */
export async function createBarber(
  raw: unknown,
  database: Database = defaultDb,
): Promise<{ barber: AdminBarber; credentials: Credentials }> {
  const input = parse(createSchema, raw);
  const serviceIds = await resolveServiceIds(input.serviceIds, database);

  // El hash (bcrypt) es lento a propósito: se calcula fuera de la transacción.
  const password = generateTemporaryPassword();
  const passwordHash = await hashPassword(password);

  let barberId: number;
  let username: string;
  try {
    ({ barberId, username } = await database.transaction(async (tx) => {
      const takenUsernames = new Set((await tx.select({ username: users.username }).from(users)).map((r) => r.username));
      const takenSlugs = new Set((await tx.select({ slug: barbers.slug }).from(barbers)).map((r) => r.slug));

      let chosen: string;
      if (input.username) {
        if (takenUsernames.has(input.username)) {
          const suggestion = withUniqueSuffix(input.username, (c) => takenUsernames.has(c));
          throw validationError({ username: [`Ese usuario ya existe. Prueba con "${suggestion}".`] });
        }
        chosen = input.username;
      } else {
        chosen = withUniqueSuffix(usernameFromName(input.name), (c) => takenUsernames.has(c));
      }
      const slug = withUniqueSuffix(slugFromName(input.name), (c) => takenSlugs.has(c));

      // El nuevo va al final del equipo.
      const [{ maxOrder }] = await tx
        .select({ maxOrder: sql<number>`coalesce(max(${barbers.displayOrder}), 0)` })
        .from(barbers);

      const [barber] = await tx
        .insert(barbers)
        .values({
          name: input.name,
          slug,
          role: input.role ?? DEFAULT_BARBER_ROLE,
          quote: input.quote ?? null,
          phoneWhatsapp: input.phoneWhatsapp,
          photoUrl: input.photoUrl ?? null,
          displayOrder: Number(maxOrder) + 1,
        })
        .returning();

      if (serviceIds.length > 0) {
        await tx.insert(barberServices).values(serviceIds.map((serviceId) => ({ barberId: barber.id, serviceId })));
      }
      await tx.insert(barberSchedules).values(WEEKLY_SCHEDULE.map((s) => ({ barberId: barber.id, ...s })));
      await tx.insert(users).values({ username: chosen, passwordHash, role: 'barber', barberId: barber.id });

      return { barberId: barber.id, username: chosen };
    }));
  } catch (err) {
    // Carrera entre dos altas simultáneas con el mismo usuario/slug.
    if (isUniqueViolation(err)) {
      throw new PanelError(409, 'ALREADY_EXISTS', 'Ese usuario o nombre acaba de ser registrado. Intenta de nuevo.');
    }
    throw err;
  }

  const barber = await getBarberAdmin(barberId, database);
  return { barber, credentials: { username, password } };
}

// ---------------------------------------------------------------------------
// Edición
// ---------------------------------------------------------------------------

/**
 * Sincroniza `barber_services` sin borrar filas: los marcados se insertan
 * (o se vuelven a ofrecer) y los desmarcados quedan con `isOffered = false`,
 * conservando precio/duración personalizados si los hubiera.
 */
async function syncBarberServices(tx: Tx, barberId: number, serviceIds: number[]) {
  if (serviceIds.length > 0) {
    await tx
      .insert(barberServices)
      .values(serviceIds.map((serviceId) => ({ barberId, serviceId })))
      .onConflictDoNothing();
    await tx
      .update(barberServices)
      .set({ isOffered: true })
      .where(and(eq(barberServices.barberId, barberId), inArray(barberServices.serviceId, serviceIds)));
  }
  await tx
    .update(barberServices)
    .set({ isOffered: false })
    .where(
      serviceIds.length > 0
        ? and(eq(barberServices.barberId, barberId), notInArray(barberServices.serviceId, serviceIds))
        : eq(barberServices.barberId, barberId),
    );
}

/** Edita datos y/o servicios. Solo toca los campos presentes en `raw`. */
export async function updateBarber(id: number, raw: unknown, database: Database = defaultDb): Promise<AdminBarber> {
  const patch = parse(updateSchema, raw);
  await getBarberAdmin(id, database); // 404 si no existe

  const { serviceIds, ...fields } = patch;
  const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  if (serviceIds !== undefined) await resolveServiceIds(serviceIds, database);

  await database.transaction(async (tx) => {
    if (Object.keys(set).length > 0) await tx.update(barbers).set(set).where(eq(barbers.id, id));
    if (serviceIds !== undefined) await syncBarberServices(tx, id, [...new Set(serviceIds)]);
  });
  return getBarberAdmin(id, database);
}

/**
 * Activa o desactiva. Al desactivar se cierran sus sesiones del panel; la
 * contraseña no se toca, así que al reactivarlo entra con la misma.
 */
export async function setBarberActive(id: number, isActive: boolean, database: Database = defaultDb): Promise<AdminBarber> {
  await getBarberAdmin(id, database);
  await database.update(barbers).set({ isActive }).where(eq(barbers.id, id));
  if (!isActive) {
    const user = await database.query.users.findFirst({ columns: { id: true }, where: eq(users.barberId, id) });
    if (user) await invalidateUserSessions(user.id, database);
  }
  return getBarberAdmin(id, database);
}

// ---------------------------------------------------------------------------
// Contraseña de rescate
// ---------------------------------------------------------------------------

/**
 * SOLO como rescate explícito del admin (botón con confirmación): genera una
 * contraseña temporal nueva y cierra las sesiones del barbero. Nunca se
 * llama de forma automática.
 */
export async function resetBarberPassword(id: number, database: Database = defaultDb): Promise<{ credentials: Credentials }> {
  await getBarberAdmin(id, database);
  const user = await database.query.users.findFirst({
    where: and(eq(users.barberId, id), eq(users.role, 'barber')),
  });
  if (!user) throw new PanelError(404, 'USER_NOT_FOUND', 'Este barbero no tiene usuario del panel.');

  const password = generateTemporaryPassword();
  const passwordHash = await hashPassword(password);
  await database.update(users).set({ passwordHash }).where(eq(users.id, user.id));
  await invalidateUserSessions(user.id, database);
  return { credentials: { username: user.username, password } };
}
