/**
 * Gestión de barberos desde el panel (solo admin) y "Mi cuenta".
 *
 * La base arranca como producción: 4 barberos con su usuario + 1 admin.
 * Ninguna operación de esta función puede tocar las contraseñas de esos 5
 * usuarios; `afterEach` y el último test lo comprueban con sus hashes.
 */
import type { APIContext, AstroGlobal } from 'astro';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dbFile = await vi.hoisted(async () => {
  const { useTempDatabase } = await import('../db');
  return useTempDatabase();
});

import { asc, eq, inArray } from 'drizzle-orm';
import { db, libsqlClient } from '../../db/client';
import { barberSchedules, barberServices, barbers, services, users, type Barber, type Service } from '../../db/schema';
import { migrateTestDb, removeTempDatabase, truncateAll } from '../db';
import { authenticate, createSession, validateSession, type SessionUser } from '../../lib/auth';
import { computeAvailableSlots } from '../../lib/availability';
import { DEFAULT_BARBER_ROLE, WEEKLY_SCHEDULE } from '../../lib/barber-defaults';
import { initials, slugFromName, usernameFromName, withUniqueSuffix } from '../../lib/barber-names';
import { getAdminPanelContext } from '../../lib/panel-page';
import { hashPassword } from '../../lib/password';
import { bogotaToUtc } from '../../lib/time';
import { GET as listBarbers, POST as postBarber } from '../../pages/api/panel/barbers/index';
import { PATCH as patchBarber } from '../../pages/api/panel/barbers/[id]';
import { POST as resetPassword } from '../../pages/api/panel/barbers/[id]/reset-password';
import { POST as changeOwnPassword } from '../../pages/api/panel/account/password';
import { GET as publicBarbers } from '../../pages/api/barbers';
import { POST as postAppointment } from '../../pages/api/appointments';

const BASE = 'http://localhost/api/panel/barbers';

function ctx(partial: {
  user?: SessionUser | null;
  sessionToken?: string | null;
  url?: string;
  body?: unknown;
  method?: string;
  params?: Record<string, string>;
}): APIContext {
  const url = new URL(partial.url ?? BASE);
  const request = new Request(url, {
    method: partial.method ?? (partial.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    body: partial.body ? JSON.stringify(partial.body) : undefined,
  });
  return {
    url,
    request,
    params: partial.params ?? {},
    locals: { user: partial.user ?? null, sessionToken: partial.sessionToken ?? null },
  } as unknown as APIContext;
}

const asJson = async (res: Response) => ({ status: res.status, body: await res.json() });

const create = async (user: SessionUser | null, body: unknown) => asJson(await postBarber(ctx({ user, body })));
const patch = async (user: SessionUser | null, id: number, body: unknown) =>
  asJson(await patchBarber(ctx({ user, method: 'PATCH', params: { id: String(id) }, body })));
const reset = async (user: SessionUser | null, id: number) =>
  asJson(await resetPassword(ctx({ user, method: 'POST', params: { id: String(id) } })));

async function listPublic(serviceId?: number) {
  const url = serviceId ? `http://localhost/api/barbers?serviceId=${serviceId}` : 'http://localhost/api/barbers';
  const res = await asJson(await publicBarbers(ctx({ url })));
  return res.body.barbers as { id: number; name: string; photoUrl: string | null }[];
}

/** Astro mínimo para probar la protección de las páginas /panel/barberos/*. */
function fakeAstro(user: SessionUser | null, url = 'http://localhost/panel/barberos'): AstroGlobal {
  return {
    locals: { user, sessionToken: null },
    url: new URL(url),
    redirect: (path: string, status = 302) => new Response(null, { status, headers: { Location: path } }),
  } as unknown as AstroGlobal;
}

// ---------------------------------------------------------------------------
// Fixture: producción en pequeño (4 barberos + admin, 3 servicios)
// ---------------------------------------------------------------------------
const EXISTING = [
  { username: 'reservasnextlevel@gmail.com', role: 'admin', name: null, password: 'admin-secreta' },
  { username: 'oswaravendano', role: 'barber', name: 'Oswar Avendaño', password: 'oswar-secreta' },
  { username: 'stiventapia', role: 'barber', name: 'Stiven Tapia', password: 'stiven-secreta' },
  { username: 'jesusmontoya', role: 'barber', name: 'Jesus Montoya', password: 'montoya-secreta' },
  { username: 'jesustoro', role: 'barber', name: 'Jesus Toro', password: 'toro-secreta' },
] as const;

const existingHashes = new Map<string, string>();
let serviceRows: Service[];
let oswar: Barber;
let adminUser: SessionUser;
let oswarUser: SessionUser;

beforeAll(async () => {
  await migrateTestDb(db);
  // bcrypt es lento: se calcula una vez y se reutiliza en cada beforeEach.
  for (const u of EXISTING) existingHashes.set(u.username, await hashPassword(u.password));
});
afterAll(() => {
  libsqlClient.close();
  removeTempDatabase(dbFile);
});

beforeEach(async () => {
  await truncateAll(db);
  serviceRows = await db
    .insert(services)
    .values([
      { name: 'Corte Básico', slug: 'corte-basico', defaultPrice: 30000, displayOrder: 1 },
      { name: 'Corte Premium', slug: 'corte-premium', defaultPrice: 40000, displayOrder: 2 },
      { name: 'Servicio retirado', slug: 'retirado', defaultPrice: 10000, displayOrder: 3, isActive: false },
    ])
    .returning();

  let order = 0;
  for (const u of EXISTING) {
    let barberId: number | null = null;
    if (u.role === 'barber') {
      const [b] = await db
        .insert(barbers)
        .values({ name: u.name!, slug: slugFromName(u.name!), role: DEFAULT_BARBER_ROLE, phoneWhatsapp: '573000000000', displayOrder: ++order })
        .returning();
      barberId = b.id;
      await db.insert(barberServices).values(serviceRows.filter((s) => s.isActive).map((s) => ({ barberId: b.id, serviceId: s.id })));
      await db.insert(barberSchedules).values(WEEKLY_SCHEDULE.map((s) => ({ barberId: b.id, ...s })));
    }
    const [user] = await db
      .insert(users)
      .values({ username: u.username, role: u.role, barberId, passwordHash: existingHashes.get(u.username)! })
      .returning();
    if (u.role === 'admin') adminUser = { id: user.id, username: user.username, role: 'admin', barberId: null };
    if (u.username === 'oswaravendano') {
      oswarUser = { id: user.id, username: user.username, role: 'barber', barberId };
      oswar = (await db.query.barbers.findFirst({ where: eq(barbers.id, barberId!) }))!;
    }
  }
});

/** Ninguna operación de esta función toca las contraseñas de los usuarios existentes. */
async function expectExistingPasswordsUntouched() {
  const rows = await db.query.users.findMany({
    where: inArray(users.username, EXISTING.map((u) => u.username)),
  });
  expect(rows).toHaveLength(EXISTING.length);
  for (const row of rows) expect(row.passwordHash).toBe(existingHashes.get(row.username));
}
afterEach(expectExistingPasswordsUntouched);

const activeServiceIds = () => serviceRows.filter((s) => s.isActive).map((s) => s.id);

// ---------------------------------------------------------------------------
describe('derivación de usuario y slug', () => {
  it('sin tildes, minúsculas, solo letras y números; sufijo 2, 3… si ya existe', () => {
    expect(usernameFromName('Carlos Pérez')).toBe('carlosperez');
    expect(slugFromName('Carlos Pérez')).toBe('carlos-perez');
    expect(usernameFromName('  José  Muñoz-Díaz 2 ')).toBe('josemunozdiaz2');
    expect(slugFromName('  José  Muñoz-Díaz 2 ')).toBe('jose-munoz-diaz-2');
    expect(usernameFromName('漢字')).toBe('barbero');

    const taken = new Set(['carlosperez', 'carlosperez2']);
    expect(withUniqueSuffix('carlosperez', (c) => taken.has(c))).toBe('carlosperez3');
    expect(withUniqueSuffix('libre', (c) => taken.has(c))).toBe('libre');

    expect(initials('Oswar Avendaño')).toBe('OA');
    expect(initials('Stiven')).toBe('S');
    expect(initials('Jesús David Toro')).toBe('JT');
  });
});

// ---------------------------------------------------------------------------
describe('crear barbero (POST /api/panel/barbers)', () => {
  it('crea barbero + servicios + horario + usuario en una transacción y devuelve credenciales', async () => {
    const res = await create(adminUser, { name: 'Carlos Pérez', phoneWhatsapp: '314 291 5681', quote: '  Estilo con navaja  ' });
    expect(res.status).toBe(201);
    const { barber, credentials } = res.body;

    // barbers
    const row = (await db.query.barbers.findFirst({ where: eq(barbers.id, barber.id) }))!;
    expect(row).toMatchObject({
      name: 'Carlos Pérez',
      slug: 'carlos-perez',
      role: DEFAULT_BARBER_ROLE,
      quote: 'Estilo con navaja',
      phoneWhatsapp: '573142915681', // normalizado: 10 dígitos → 57 + número
      photoUrl: null,
      bufferMinutes: 0,
      isActive: true,
      displayOrder: 5, // el nuevo va al final (los 4 existentes tienen 1..4)
    });

    // barber_services: todos los servicios activos (no el retirado)
    const offered = await db.query.barberServices.findMany({ where: eq(barberServices.barberId, barber.id) });
    expect(offered.map((o) => o.serviceId).sort()).toEqual(activeServiceIds().sort());
    expect(offered.every((o) => o.isOffered)).toBe(true);
    expect(barber.servicesCount).toBe(activeServiceIds().length);

    // barber_schedules: el horario semanal por defecto (compartido con el seed)
    const schedule = await db.query.barberSchedules.findMany({
      where: eq(barberSchedules.barberId, barber.id),
      orderBy: [asc(barberSchedules.dayOfWeek)],
    });
    expect(schedule.map(({ dayOfWeek, startTime, endTime }) => ({ dayOfWeek, startTime, endTime }))).toEqual(WEEKLY_SCHEDULE);

    // users: rol barber vinculado, y las credenciales devueltas funcionan
    const user = (await db.query.users.findFirst({ where: eq(users.barberId, barber.id) }))!;
    expect(user).toMatchObject({ username: 'carlosperez', role: 'barber' });
    expect(credentials.username).toBe('carlosperez');
    expect(barber.username).toBe('carlosperez');
    expect(credentials.password).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(user.passwordHash).not.toBe(credentials.password); // solo se guarda el hash
    expect((await authenticate('carlosperez', credentials.password))?.id).toBe(user.id);

    // aparece de inmediato en la web pública y acepta reservas
    expect((await listPublic()).map((b) => b.name)).toContain('Carlos Pérez');
    const slots = await computeAvailableSlots({ barberId: barber.id, serviceId: activeServiceIds()[0], date: '2026-10-14' }, db);
    expect(slots[0]?.startLocal).toBe('09:00');
  });

  it('serviceIds explícitos: ofrece solo esos; lista vacía → ninguno', async () => {
    const [basic] = activeServiceIds();
    const one = await create(adminUser, { name: 'Solo Básico', phoneWhatsapp: '3001112233', serviceIds: [basic] });
    expect(one.status).toBe(201);
    expect(one.body.barber.serviceIds).toEqual([basic]);

    const none = await create(adminUser, { name: 'Sin Servicios', phoneWhatsapp: '3001112234', serviceIds: [] });
    expect(none.body.barber.servicesCount).toBe(0);

    const unknown = await create(adminUser, { name: 'Servicio Raro', phoneWhatsapp: '3001112235', serviceIds: [9999] });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.details.serviceIds).toBeDefined();
  });

  it('colisión de nombre → usuario "carlosperez2" y slug "carlos-perez2"', async () => {
    const first = await create(adminUser, { name: 'Carlos Pérez', phoneWhatsapp: '3142915681' });
    const second = await create(adminUser, { name: 'Carlos Perez', phoneWhatsapp: '3142915682' });
    const third = await create(adminUser, { name: 'CARLOS PÉREZ', phoneWhatsapp: '3142915683' });
    expect(first.body.credentials.username).toBe('carlosperez');
    expect(second.body.credentials.username).toBe('carlosperez2');
    expect(second.body.barber.slug).toBe('carlos-perez2');
    expect(third.body.credentials.username).toBe('carlosperez3');
    expect(third.body.barber.slug).toBe('carlos-perez3');

    // También contra un usuario existente del seed
    const oswar2 = await create(adminUser, { name: 'Oswar Avendaño', phoneWhatsapp: '3142915684' });
    expect(oswar2.body.credentials.username).toBe('oswaravendano2');
  });

  it('username elegido por el admin: se respeta (normalizado) y, si ya existe, 422 con error en el campo', async () => {
    const taken = await create(adminUser, { name: 'Otro Oswar', phoneWhatsapp: '3142915681', username: 'oswaravendano' });
    expect(taken.status).toBe(422);
    expect(taken.body.error.details.username[0]).toContain('oswaravendano2');
    expect(await db.query.barbers.findFirst({ where: eq(barbers.name, 'Otro Oswar') })).toBeUndefined(); // no se creó nada

    const custom = await create(adminUser, { name: 'Otro Oswar', phoneWhatsapp: '3142915681', username: ' ElOswar ' });
    expect(custom.status).toBe(201);
    expect(custom.body.credentials.username).toBe('eloswar');

    const invalid = await create(adminUser, { name: 'Otro Oswar', phoneWhatsapp: '3142915681', username: 'el oswar!' });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.details.username).toBeDefined();
  });

  it('valida campos con mensajes por campo en español', async () => {
    const res = await create(adminUser, {
      name: 'C',
      phoneWhatsapp: '12',
      photoUrl: 'carlos.jpg',
      quote: 'x'.repeat(161),
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(res.body.error.details).sort()).toEqual(['name', 'phoneWhatsapp', 'photoUrl', 'quote']);
    expect(res.body.error.details.name[0]).toMatch(/al menos 2/);
    expect(res.body.error.details.phoneWhatsapp[0]).toMatch(/10 y 15 dígitos/);

    const missing = await create(adminUser, {});
    expect(missing.status).toBe(422);
    expect(Object.keys(missing.body.error.details).sort()).toEqual(['name', 'phoneWhatsapp']);
  });

  it('WhatsApp: acepta formatos con espacios/+57 y guarda solo dígitos; rol vacío → "Master Barber"; foto por ruta o URL', async () => {
    const withPrefix = await create(adminUser, { name: 'Con Prefijo', phoneWhatsapp: '+57 314 291 5681', role: '', photoUrl: '/carlos.jpg' });
    expect(withPrefix.status).toBe(201);
    expect(withPrefix.body.barber).toMatchObject({ phoneWhatsapp: '573142915681', role: DEFAULT_BARBER_ROLE, photoUrl: '/carlos.jpg' });

    const withUrl = await create(adminUser, { name: 'Con Url', phoneWhatsapp: '3142915682', role: 'Barbero Junior', photoUrl: 'https://cdn.example.com/f.jpg' });
    expect(withUrl.body.barber).toMatchObject({ role: 'Barbero Junior', photoUrl: 'https://cdn.example.com/f.jpg' });

    const badPhoto = await create(adminUser, { name: 'Foto Mala', phoneWhatsapp: '3142915683', photoUrl: '//evil.com/x.jpg' });
    expect(badPhoto.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
describe('autorización', () => {
  it('un usuario con rol barbero recibe 403 en todos los endpoints nuevos', async () => {
    expect((await listBarbers(ctx({ user: oswarUser }))).status).toBe(403);
    expect((await create(oswarUser, { name: 'Intruso', phoneWhatsapp: '3001112233' })).status).toBe(403);
    expect((await patch(oswarUser, oswar.id, { name: 'Yo mismo' })).status).toBe(403);
    expect((await patch(oswarUser, oswar.id, { isActive: false })).status).toBe(403);
    expect((await reset(oswarUser, oswar.id)).status).toBe(403);
    // nada cambió
    expect((await db.query.barbers.findFirst({ where: eq(barbers.id, oswar.id) }))?.name).toBe('Oswar Avendaño');
    expect(await db.query.barbers.findFirst({ where: eq(barbers.name, 'Intruso') })).toBeUndefined();
  });

  it('sin sesión → 403 (defensa en profundidad; el middleware ya da 401)', async () => {
    expect((await listBarbers(ctx({ user: null }))).status).toBe(403);
    expect((await create(null, { name: 'Nadie', phoneWhatsapp: '3001112233' })).status).toBe(403);
  });

  it('páginas /panel/barberos/*: el barbero es redirigido a /panel; el admin obtiene el contexto', async () => {
    const redirected = await getAdminPanelContext(fakeAstro(oswarUser));
    expect(redirected).toBeInstanceOf(Response);
    expect((redirected as Response).status).toBe(302);
    expect((redirected as Response).headers.get('Location')).toBe('/panel');

    const allowed = await getAdminPanelContext(fakeAstro(adminUser));
    expect(allowed).not.toBeInstanceOf(Response);
    expect((allowed as { user: SessionUser }).user.role).toBe('admin');

    const anonymous = await getAdminPanelContext(fakeAstro(null));
    expect((anonymous as Response).headers.get('Location')).toBe('/login');
  });

  it('admin: GET lista todos (activos e inactivos) con conteo de servicios y usuario', async () => {
    await patch(adminUser, oswar.id, { isActive: false });
    const res = await asJson(await listBarbers(ctx({ user: adminUser })));
    expect(res.status).toBe(200);
    expect(res.body.barbers).toHaveLength(4);
    expect(res.body.barbers.at(-1)).toMatchObject({ id: oswar.id, isActive: false, servicesCount: 2, username: 'oswaravendano' }); // inactivo al final
  });
});

// ---------------------------------------------------------------------------
describe('editar (PATCH /api/panel/barbers/:id)', () => {
  it('edita datos y sincroniza servicios sin borrar filas (desmarcar → isOffered=false)', async () => {
    const [basic, premium] = activeServiceIds();

    const res = await patch(adminUser, oswar.id, {
      name: 'Oswar A.',
      phoneWhatsapp: '319 000 0000',
      quote: '',
      photoUrl: '/oswar2.jpg',
      serviceIds: [basic],
    });
    expect(res.status).toBe(200);
    expect(res.body.barber).toMatchObject({ name: 'Oswar A.', phoneWhatsapp: '573190000000', quote: null, photoUrl: '/oswar2.jpg', serviceIds: [basic] });

    const rows = await db.query.barberServices.findMany({ where: eq(barberServices.barberId, oswar.id) });
    expect(rows).toHaveLength(2); // la fila del premium sigue existiendo
    expect(rows.find((r) => r.serviceId === premium)?.isOffered).toBe(false);
    expect((await listPublic(premium)).map((b) => b.id)).not.toContain(oswar.id);
    expect((await listPublic(basic)).map((b) => b.id)).toContain(oswar.id);

    // volver a marcar → isOffered=true, misma fila
    await patch(adminUser, oswar.id, { serviceIds: [basic, premium] });
    const again = await db.query.barberServices.findMany({ where: eq(barberServices.barberId, oswar.id) });
    expect(again).toHaveLength(2);
    expect(again.every((r) => r.isOffered)).toBe(true);
    expect((await listPublic(premium)).map((b) => b.id)).toContain(oswar.id);
  });

  it('PATCH parcial no toca los campos ausentes; valida los presentes; 404 si no existe', async () => {
    const ok = await patch(adminUser, oswar.id, { role: 'Head Barber' });
    expect(ok.body.barber).toMatchObject({ role: 'Head Barber', name: 'Oswar Avendaño', phoneWhatsapp: '573000000000' });

    const bad = await patch(adminUser, oswar.id, { phoneWhatsapp: 'abc' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.phoneWhatsapp).toBeDefined();

    expect((await patch(adminUser, 9999, { name: 'Fantasma' })).status).toBe(404);
    expect((await patch(adminUser, oswar.id, { isActive: 'sí' })).status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
describe('activar / desactivar', () => {
  it('desactivar: no puede iniciar sesión, /api/barbers no lo lista, sesiones cerradas y sin reservas; reactivar restaura con la misma contraseña', async () => {
    const { token } = await createSession(oswarUser.id);
    const [basic] = activeServiceIds();
    expect((await authenticate('oswaravendano', 'oswar-secreta'))?.id).toBe(oswarUser.id);
    expect((await listPublic()).map((b) => b.id)).toContain(oswar.id);

    const off = await patch(adminUser, oswar.id, { isActive: false });
    expect(off.status).toBe(200);
    expect(off.body.barber.isActive).toBe(false);

    expect(await authenticate('oswaravendano', 'oswar-secreta')).toBeNull(); // como contraseña incorrecta
    expect(await validateSession(token)).toBeNull(); // sesión cerrada
    expect((await listPublic()).map((b) => b.id)).not.toContain(oswar.id);
    expect((await listPublic(basic)).map((b) => b.id)).not.toContain(oswar.id);
    expect(await computeAvailableSlots({ barberId: oswar.id, serviceId: basic, date: '2026-10-14' }, db)).toEqual([]);
    const booking = await postAppointment(
      ctx({
        url: 'http://localhost/api/appointments',
        body: {
          barberId: oswar.id,
          serviceId: basic,
          startDatetime: bogotaToUtc('2026-10-14', '10:00').toISOString(),
          clientName: 'Cliente',
          clientPhone: '573001234567',
        },
      }),
    );
    expect(booking.status).toBe(404);

    // el admin sigue viéndolo en su lista (para reactivarlo)
    const admin = await asJson(await listBarbers(ctx({ user: adminUser })));
    expect(admin.body.barbers.find((b: { id: number }) => b.id === oswar.id)?.isActive).toBe(false);

    const on = await patch(adminUser, oswar.id, { isActive: true });
    expect(on.body.barber.isActive).toBe(true);
    expect((await authenticate('oswaravendano', 'oswar-secreta'))?.id).toBe(oswarUser.id);
    expect((await listPublic()).map((b) => b.id)).toContain(oswar.id);
  });

  it('la web pública (Team.astro) solo consulta barberos activos', () => {
    const source = readFileSync(new URL('../../components/Team.astro', import.meta.url), 'utf8');
    expect(source).toMatch(/where:\s*eq\(barbers\.isActive,\s*true\)/);
  });
});

// ---------------------------------------------------------------------------
describe('contraseña de rescate (POST /api/panel/barbers/:id/reset-password)', () => {
  it('genera una temporal nueva SOLO para ese barbero; la anterior deja de servir y se cierran sus sesiones', async () => {
    const created = await create(adminUser, { name: 'Carlos Pérez', phoneWhatsapp: '3142915681' });
    const { id } = created.body.barber;
    const old = created.body.credentials.password;
    const { token } = await createSession((await db.query.users.findFirst({ where: eq(users.barberId, id) }))!.id);

    const res = await reset(adminUser, id);
    expect(res.status).toBe(200);
    expect(res.body.credentials.username).toBe('carlosperez');
    expect(res.body.credentials.password).not.toBe(old);

    expect(await authenticate('carlosperez', old)).toBeNull();
    expect(await authenticate('carlosperez', res.body.credentials.password)).not.toBeNull();
    expect(await validateSession(token)).toBeNull();
    // los demás usuarios quedan intactos (afterEach lo verifica con los hashes)
  });

  it('404 si el barbero no existe o no tiene usuario', async () => {
    expect((await reset(adminUser, 9999)).status).toBe(404);
    const [orphan] = await db
      .insert(barbers)
      .values({ name: 'Sin Usuario', slug: 'sin-usuario', role: DEFAULT_BARBER_ROLE, phoneWhatsapp: '573000000001' })
      .returning();
    const res = await reset(adminUser, orphan.id);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
describe('Mi cuenta (POST /api/panel/account/password)', () => {
  async function newBarberWithSessions() {
    const created = await create(adminUser, { name: 'Carlos Pérez', phoneWhatsapp: '3142915681' });
    const user = (await db.query.users.findFirst({ where: eq(users.barberId, created.body.barber.id) }))!;
    const sessionUser: SessionUser = { id: user.id, username: user.username, role: 'barber', barberId: user.barberId };
    const current = await createSession(user.id);
    const other = await createSession(user.id);
    return { sessionUser, password: created.body.credentials.password as string, current, other };
  }
  const change = async (user: SessionUser, sessionToken: string | null, body: unknown) =>
    asJson(await changeOwnPassword(ctx({ user, sessionToken, url: 'http://localhost/api/panel/account/password', body })));

  it('cambia la contraseña: la anterior deja de funcionar, la sesión actual sigue viva y las demás se cierran', async () => {
    const { sessionUser, password, current, other } = await newBarberWithSessions();

    const res = await change(sessionUser, current.token, { currentPassword: password, newPassword: 'nueva-clave-123', confirmPassword: 'nueva-clave-123' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    expect(await authenticate('carlosperez', password)).toBeNull();
    expect((await authenticate('carlosperez', 'nueva-clave-123'))?.id).toBe(sessionUser.id);
    expect(await validateSession(current.token)).not.toBeNull();
    expect(await validateSession(other.token)).toBeNull();
  });

  it('valida: actual incorrecta, nueva corta o igual a la actual, confirmación distinta', async () => {
    const { sessionUser, password, current } = await newBarberWithSessions();

    const wrong = await change(sessionUser, current.token, { currentPassword: 'mala', newPassword: 'nueva-clave-123', confirmPassword: 'nueva-clave-123' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.details.currentPassword).toBeDefined();

    const short = await change(sessionUser, current.token, { currentPassword: password, newPassword: 'corta', confirmPassword: 'corta' });
    expect(short.status).toBe(422);
    expect(short.body.error.details.newPassword[0]).toMatch(/al menos 8/);

    const same = await change(sessionUser, current.token, { currentPassword: password, newPassword: password, confirmPassword: password });
    expect(same.status).toBe(422);
    expect(same.body.error.details.newPassword).toBeDefined();

    const mismatch = await change(sessionUser, current.token, { currentPassword: password, newPassword: 'nueva-clave-123', confirmPassword: 'otra-clave-123' });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.details.confirmPassword).toBeDefined();

    // nada cambió y la sesión sigue viva
    expect((await authenticate('carlosperez', password))?.id).toBe(sessionUser.id);
    expect(await validateSession(current.token)).not.toBeNull();
    expect((await change(sessionUser, current.token, {})).status).toBe(422);
  });

  it('funciona igual para un usuario admin', async () => {
    const [extraAdmin] = await db
      .insert(users)
      .values({ username: 'admin2@test.com', role: 'admin', barberId: null, passwordHash: await hashPassword('admin2-clave') })
      .returning();
    const admin2: SessionUser = { id: extraAdmin.id, username: extraAdmin.username, role: 'admin', barberId: null };
    const { token } = await createSession(admin2.id);

    const res = await change(admin2, token, { currentPassword: 'admin2-clave', newPassword: 'admin2-nueva-clave', confirmPassword: 'admin2-nueva-clave' });
    expect(res.status).toBe(200);
    expect(await authenticate('admin2@test.com', 'admin2-clave')).toBeNull();
    expect((await authenticate('admin2@test.com', 'admin2-nueva-clave'))?.id).toBe(admin2.id);
    expect(await validateSession(token)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('los usuarios existentes no se tocan', () => {
  it('tras crear, editar, resetear, desactivar y cambiar contraseñas, los 5 usuarios existentes conservan exactamente el mismo password_hash', async () => {
    const created = await create(adminUser, { name: 'Prueba Temporal', phoneWhatsapp: '3009998877' });
    const { id } = created.body.barber;
    await patch(adminUser, id, { name: 'Prueba Editada', serviceIds: [] });
    const reset1 = await reset(adminUser, id);
    const user = (await db.query.users.findFirst({ where: eq(users.barberId, id) }))!;
    const { token } = await createSession(user.id);
    await changeOwnPassword(
      ctx({
        user: { id: user.id, username: user.username, role: 'barber', barberId: id },
        sessionToken: token,
        url: 'http://localhost/api/panel/account/password',
        body: { currentPassword: reset1.body.credentials.password, newPassword: 'clave-definitiva', confirmPassword: 'clave-definitiva' },
      }),
    );
    await patch(adminUser, id, { isActive: false });
    await patch(adminUser, id, { isActive: true });
    await patch(adminUser, id, { isActive: false });

    // assert explícito (además del afterEach)
    await expectExistingPasswordsUntouched();
    for (const u of EXISTING) {
      const row = (await db.query.users.findFirst({ where: eq(users.username, u.username) }))!;
      expect(row.passwordHash).toBe(existingHashes.get(u.username));
    }
    expect((await authenticate('oswaravendano', 'oswar-secreta'))?.id).toBe(oswarUser.id);
    expect((await authenticate('reservasnextlevel@gmail.com', 'admin-secreta'))?.id).toBe(adminUser.id);
  });
});
