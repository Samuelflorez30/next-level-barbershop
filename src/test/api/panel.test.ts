/**
 * Autenticación y autorización del panel: un barbero solo toca lo suyo sin
 * importar lo que envíe; el admin puede tocar a cualquiera. Los handlers se
 * llaman con `locals.user` ya resuelto (lo que hace el middleware).
 */
import type { APIContext } from 'astro';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dbFile = await vi.hoisted(async () => {
  const { useTempDatabase } = await import('../db');
  return useTempDatabase();
});

import { eq } from 'drizzle-orm';
import { db, libsqlClient } from '../../db/client';
import { appointments, barberSchedules, barberTimeOff, users, type Barber, type Service } from '../../db/schema';
import { migrateTestDb, removeTempDatabase, seedFixtures, seedUser, truncateAll } from '../db';
import { authenticate, createSession, invalidateSession, validateSession, type SessionUser } from '../../lib/auth';
import { computeAvailableSlots } from '../../lib/availability';
import { bogotaToUtc } from '../../lib/time';
import { POST as login } from '../../pages/api/auth/login';
import { GET as getAppointments } from '../../pages/api/panel/appointments';
import { PATCH as patchAppointment } from '../../pages/api/panel/appointments/[id]';
import { GET as getSchedules, PUT as putSchedules, POST as postSchedule } from '../../pages/api/panel/schedules';
import { DELETE as deleteSchedule } from '../../pages/api/panel/schedules/[id]';
import { GET as getTimeOff, POST as postTimeOff } from '../../pages/api/panel/time-off';
import { DELETE as deleteTimeOff } from '../../pages/api/panel/time-off/[id]';

const BASE = 'http://localhost/api/panel';
const WEDNESDAY = '2026-10-14';

function ctx(partial: { user?: SessionUser | null; url?: string; body?: unknown; method?: string; params?: Record<string, string> }): APIContext {
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
    locals: { user: partial.user ?? null, sessionToken: null },
  } as unknown as APIContext;
}

const asJson = async (res: Response) => ({ status: res.status, body: await res.json() });

let a: { barber: Barber; service: Service };
let b: { barber: Barber; service: Service };
let barberUser: SessionUser;
let adminUser: SessionUser;

beforeAll(async () => {
  await migrateTestDb(db);
});
afterAll(() => {
  libsqlClient.close();
  removeTempDatabase(dbFile);
});
beforeEach(async () => {
  await truncateAll(db);
  a = await seedFixtures(db);
  b = await seedFixtures(db);
  const bu = await seedUser(db, { username: 'barberoa', password: 'secreto123', role: 'barber', barberId: a.barber.id });
  const au = await seedUser(db, { username: 'admin@test.com', password: 'admin123', role: 'admin' });
  barberUser = { id: bu.id, username: bu.username, role: 'barber', barberId: a.barber.id };
  adminUser = { id: au.id, username: au.username, role: 'admin', barberId: null };
});

async function book(barber: Barber, service: Service, time: string, name = 'Cliente') {
  const [row] = await db
    .insert(appointments)
    .values({
      barberId: barber.id,
      serviceId: service.id,
      clientName: name,
      clientPhone: '573000000000',
      startDatetime: bogotaToUtc(WEDNESDAY, time),
      endDatetime: bogotaToUtc(WEDNESDAY, `${String(Number(time.slice(0, 2)) + 1).padStart(2, '0')}:00`),
      price: 30000,
      status: 'confirmed',
      confirmationToken: crypto.randomUUID(),
    })
    .returning();
  return row;
}

// ---------------------------------------------------------------------------
describe('autenticación', () => {
  it('authenticate acepta usuario simple (barbero) o email (admin) y rechaza incorrectas / desconocidas', async () => {
    expect((await authenticate('barberoa', 'secreto123'))?.id).toBe(barberUser.id);
    expect(await authenticate(' BarberoA ', 'secreto123')).not.toBeNull(); // normalizado (trim + minúsculas)
    expect((await authenticate('admin@test.com', 'admin123'))?.id).toBe(adminUser.id);
    expect(await authenticate('barberoa', 'mala')).toBeNull();
    expect(await authenticate('nadie', 'x')).toBeNull();
  });

  it('migra hashes scrypt heredados (seed de Fase 1) a bcrypt en el primer login', async () => {
    // hash scrypt de "legacy" generado con el helper antiguo
    const { scrypt: scryptCb, randomBytes } = await import('node:crypto');
    const { promisify } = await import('node:util');
    const salt = randomBytes(16);
    const derived = (await promisify(scryptCb)('legacy', salt, 64)) as Buffer;
    const legacyHash = `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
    await db.update(users).set({ passwordHash: legacyHash }).where(eq(users.id, barberUser.id));

    expect(await authenticate('barberoa', 'legacy')).not.toBeNull();
    const after = await db.query.users.findFirst({ where: eq(users.id, barberUser.id) });
    expect(after!.passwordHash.startsWith('$2')).toBe(true);
    expect(await authenticate('barberoa', 'legacy')).not.toBeNull(); // sigue funcionando con bcrypt
  });

  it('sesiones: crear, validar, invalidar y expirar', async () => {
    const { token, session } = await createSession(barberUser.id);
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const valid = await validateSession(token);
    expect(valid?.user).toEqual(barberUser);
    expect(await validateSession('token-falso')).toBeNull();

    await invalidateSession(token);
    expect(await validateSession(token)).toBeNull();

    const expired = await createSession(barberUser.id);
    const { sessions } = await import('../../db/schema');
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.userId, barberUser.id));
    expect(await validateSession(expired.token)).toBeNull();
  });

  it('POST /api/auth/login (JSON) responde 401 o 200 y fija la cookie httpOnly', async () => {
    const set = vi.fn();
    const call = (body: unknown) =>
      login({ ...ctx({ body, url: 'http://localhost/api/auth/login' }), cookies: { set, delete: vi.fn(), get: () => undefined } } as unknown as APIContext);

    expect((await call({ username: 'barberoa', password: 'mala' })).status).toBe(401);
    expect((await call({ username: '', password: '' })).status).toBe(400);
    expect((await call({ email: 'barberoa', password: 'secreto123' })).status).toBe(400); // el campo ahora es username

    const ok = await asJson(await call({ username: 'barberoa', password: 'secreto123' }));
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ role: 'barber', barberId: a.barber.id });
    expect(set).toHaveBeenCalledWith('nlb_session', expect.any(String), expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }));
  });

  it('POST /api/auth/login (formulario) redirige a next o a /login?error', async () => {
    const set = vi.fn();
    const form = (fields: Record<string, string>) => {
      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      });
      return login({ request, cookies: { set, delete: vi.fn(), get: () => undefined }, locals: {} } as unknown as APIContext);
    };
    const bad = await form({ username: 'barberoa', password: 'mala', next: '/panel/horario' });
    expect(bad.status).toBe(303);
    expect(bad.headers.get('Location')).toContain('/login?error=credentials');

    const good = await form({ username: 'barberoa', password: 'secreto123', next: '/panel/horario' });
    expect(good.status).toBe(303);
    expect(good.headers.get('Location')).toBe('/panel/horario');

    // open redirect bloqueado
    const evil = await form({ username: 'barberoa', password: 'secreto123', next: 'https://evil.com' });
    expect(evil.headers.get('Location')).toBe('/panel');
  });
});

// ---------------------------------------------------------------------------
describe('horario (schedules)', () => {
  const week = (start: string, end: string) => Array.from({ length: 7 }, (_, d) => ({ dayOfWeek: d, ranges: [{ startTime: start, endTime: end }] }));

  it('sin usuario → 403 (defensa en profundidad; el middleware ya da 401)', async () => {
    expect((await getSchedules(ctx({ user: null }))).status).toBe(403);
  });

  it('barbero: GET devuelve su horario aunque pida el de otro', async () => {
    const res = await asJson(await getSchedules(ctx({ user: barberUser, url: `${BASE}/schedules?barberId=${b.barber.id}` })));
    expect(res.status).toBe(200);
    expect(res.body.barberId).toBe(a.barber.id);
    expect(res.body.schedules.every((s: { barberId: number }) => s.barberId === a.barber.id)).toBe(true);
  });

  it('barbero: PUT con barberId ajeno en el body modifica SOLO el suyo', async () => {
    const res = await asJson(
      await putSchedules(ctx({ user: barberUser, method: 'PUT', body: { barberId: b.barber.id, days: week('10:00', '18:00') } })),
    );
    expect(res.status).toBe(200);
    expect(res.body.barberId).toBe(a.barber.id);

    const own = await db.query.barberSchedules.findMany({ where: eq(barberSchedules.barberId, a.barber.id) });
    const other = await db.query.barberSchedules.findMany({ where: eq(barberSchedules.barberId, b.barber.id) });
    expect(own.every((s) => s.startTime === '10:00' && s.endTime === '18:00')).toBe(true);
    expect(other.every((s) => s.startTime === '09:00' && s.endTime === '21:00')).toBe(true);
  });

  it('admin: PUT modifica al barbero indicado y exige barberId', async () => {
    const res = await asJson(await putSchedules(ctx({ user: adminUser, method: 'PUT', body: { barberId: b.barber.id, days: week('12:00', '20:00') } })));
    expect(res.status).toBe(200);
    const other = await db.query.barberSchedules.findMany({ where: eq(barberSchedules.barberId, b.barber.id) });
    expect(other.every((s) => s.startTime === '12:00')).toBe(true);

    const missing = await putSchedules(ctx({ user: adminUser, method: 'PUT', body: { days: week('12:00', '20:00') } }));
    expect(missing.status).toBe(400);
    const unknown = await putSchedules(ctx({ user: adminUser, method: 'PUT', body: { barberId: 9999, days: [] } }));
    expect(unknown.status).toBe(404);
  });

  it('cambiar el horario cambia la disponibilidad pública', async () => {
    const before = await computeAvailableSlots({ barberId: a.barber.id, serviceId: a.service.id, date: WEDNESDAY }, db);
    expect(before[0].startLocal).toBe('09:00');

    // Miércoles (day 2) solo de 14:00 a 17:00; el resto igual.
    const days = week('09:00', '21:00');
    days[2] = { dayOfWeek: 2, ranges: [{ startTime: '14:00', endTime: '17:00' }] };
    await putSchedules(ctx({ user: barberUser, method: 'PUT', body: { days } }));

    const after = await computeAvailableSlots({ barberId: a.barber.id, serviceId: a.service.id, date: WEDNESDAY }, db);
    expect(after.map((s) => s.startLocal)).toEqual(['14:00', '15:00', '16:00']);

    // Día cerrado (sin franjas) → sin slots
    days[2] = { dayOfWeek: 2, ranges: [] };
    await putSchedules(ctx({ user: barberUser, method: 'PUT', body: { days } }));
    expect(await computeAvailableSlots({ barberId: a.barber.id, serviceId: a.service.id, date: WEDNESDAY }, db)).toEqual([]);
  });

  it('valida franjas: formato, orden y solapes', async () => {
    const bad = (ranges: { startTime: string; endTime: string }[]) =>
      putSchedules(ctx({ user: barberUser, method: 'PUT', body: { days: [{ dayOfWeek: 0, ranges }] } }));
    expect((await bad([{ startTime: '9:00', endTime: '21:00' }])).status).toBe(422);
    expect((await bad([{ startTime: '18:00', endTime: '09:00' }])).status).toBe(422);
    expect((await bad([{ startTime: '09:00', endTime: '13:00' }, { startTime: '12:00', endTime: '18:00' }])).status).toBe(422);
    // turno partido válido
    expect((await bad([{ startTime: '09:00', endTime: '13:00' }, { startTime: '14:00', endTime: '18:00' }])).status).toBe(200);
  });

  it('POST/DELETE de una franja individual respetan el dueño', async () => {
    const created = await asJson(await postSchedule(ctx({ user: barberUser, body: { barberId: b.barber.id, dayOfWeek: 0, startTime: '21:00', endTime: '22:00' } })));
    expect(created.status).toBe(201);
    expect(created.body.schedule.barberId).toBe(a.barber.id); // no el de b

    const otherRow = (await db.query.barberSchedules.findFirst({ where: eq(barberSchedules.barberId, b.barber.id) }))!;
    expect((await deleteSchedule(ctx({ user: barberUser, method: 'DELETE', params: { id: String(otherRow.id) } }))).status).toBe(403);
    expect((await deleteSchedule(ctx({ user: adminUser, method: 'DELETE', params: { id: String(otherRow.id) } }))).status).toBe(200);
    expect((await deleteSchedule(ctx({ user: barberUser, method: 'DELETE', params: { id: String(created.body.schedule.id) } }))).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe('días libres (time-off)', () => {
  it('barbero: crea solo para sí mismo aunque envíe otro barberId; no puede crear globales', async () => {
    const res = await asJson(
      await postTimeOff(ctx({ user: barberUser, body: { barberId: b.barber.id, startLocal: '2026-10-14T12:00', endLocal: '2026-10-14T15:00', reason: 'Almuerzo' } })),
    );
    expect(res.status).toBe(201);
    expect(res.body.timeOff.barberId).toBe(a.barber.id);

    const global = await asJson(await postTimeOff(ctx({ user: barberUser, body: { barberId: null, startLocal: '2026-10-14T12:00', endLocal: '2026-10-14T15:00' } })));
    expect(global.body.timeOff.barberId).toBe(a.barber.id); // barberId null se ignora

    // y afecta su disponibilidad
    const slots = await computeAvailableSlots({ barberId: a.barber.id, serviceId: a.service.id, date: WEDNESDAY }, db);
    expect(slots.map((s) => s.startLocal)).not.toContain('12:00');
    expect(slots.map((s) => s.startLocal)).toContain('11:00');
  });

  it('admin: crea para cualquier barbero o un cierre global', async () => {
    const forB = await asJson(await postTimeOff(ctx({ user: adminUser, body: { barberId: b.barber.id, startLocal: '2026-10-14T09:00', endLocal: '2026-10-14T21:00' } })));
    expect(forB.body.timeOff.barberId).toBe(b.barber.id);

    const global = await asJson(await postTimeOff(ctx({ user: adminUser, body: { barberId: null, startLocal: '2026-10-15T00:00', endLocal: '2026-10-16T00:00', reason: 'Festivo' } })));
    expect(global.status).toBe(201);
    expect(global.body.timeOff.barberId).toBeNull();

    for (const x of [a, b]) {
      expect(await computeAvailableSlots({ barberId: x.barber.id, serviceId: x.service.id, date: '2026-10-15' }, db)).toEqual([]);
    }
  });

  it('GET: barbero ve los suyos + globales; admin sin barberId ve todos', async () => {
    await db.insert(barberTimeOff).values([
      { barberId: a.barber.id, startDatetime: bogotaToUtc('2030-01-01', '09:00'), endDatetime: bogotaToUtc('2030-01-01', '12:00') },
      { barberId: b.barber.id, startDatetime: bogotaToUtc('2030-01-02', '09:00'), endDatetime: bogotaToUtc('2030-01-02', '12:00') },
      { barberId: null, startDatetime: bogotaToUtc('2030-01-03', '09:00'), endDatetime: bogotaToUtc('2030-01-03', '12:00') },
    ]);
    const mine = await asJson(await getTimeOff(ctx({ user: barberUser, url: `${BASE}/time-off?barberId=${b.barber.id}` })));
    expect(mine.body.timeOff.map((t: { barberId: number | null }) => t.barberId).sort()).toEqual([a.barber.id, null].sort());

    const all = await asJson(await getTimeOff(ctx({ user: adminUser, url: `${BASE}/time-off` })));
    expect(all.body.timeOff).toHaveLength(3);
  });

  it('DELETE: barbero no borra ajenos ni globales; admin sí', async () => {
    const [own] = await db.insert(barberTimeOff).values({ barberId: a.barber.id, startDatetime: new Date(), endDatetime: new Date(Date.now() + 3600e3) }).returning();
    const [other] = await db.insert(barberTimeOff).values({ barberId: b.barber.id, startDatetime: new Date(), endDatetime: new Date(Date.now() + 3600e3) }).returning();
    const [global] = await db.insert(barberTimeOff).values({ barberId: null, startDatetime: new Date(), endDatetime: new Date(Date.now() + 3600e3) }).returning();

    const del = (user: SessionUser, id: number) => deleteTimeOff(ctx({ user, method: 'DELETE', params: { id: String(id) } }));
    expect((await del(barberUser, other.id)).status).toBe(403);
    expect((await del(barberUser, global.id)).status).toBe(403);
    expect((await del(barberUser, own.id)).status).toBe(200);
    expect((await del(adminUser, other.id)).status).toBe(200);
    expect((await del(adminUser, global.id)).status).toBe(200);
    expect((await del(adminUser, 9999)).status).toBe(404);
  });

  it('valida fechas', async () => {
    const bad = await postTimeOff(ctx({ user: barberUser, body: { startLocal: '2026-10-14T15:00', endLocal: '2026-10-14T12:00' } }));
    expect(bad.status).toBe(422);
    const malformed = await postTimeOff(ctx({ user: barberUser, body: { startLocal: 'ayer', endLocal: 'hoy' } }));
    expect(malformed.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
describe('citas', () => {
  it('barbero: GET lista solo sus citas aunque pida las de otro', async () => {
    await book(a.barber, a.service, '10:00', 'De A');
    await book(b.barber, b.service, '10:00', 'De B');
    const res = await asJson(await getAppointments(ctx({ user: barberUser, url: `${BASE}/appointments?barberId=${b.barber.id}` })));
    expect(res.body.appointments).toHaveLength(1);
    expect(res.body.appointments[0].clientName).toBe('De A');
  });

  it('admin: GET lista todas, o filtra por barbero/estado/fecha', async () => {
    await book(a.barber, a.service, '10:00', 'De A');
    const ofB = await book(b.barber, b.service, '10:00', 'De B');
    await db.update(appointments).set({ status: 'completed' }).where(eq(appointments.id, ofB.id));

    expect((await asJson(await getAppointments(ctx({ user: adminUser, url: `${BASE}/appointments` })))).body.appointments).toHaveLength(2);
    expect((await asJson(await getAppointments(ctx({ user: adminUser, url: `${BASE}/appointments?barberId=${b.barber.id}` })))).body.appointments).toHaveLength(1);
    expect((await asJson(await getAppointments(ctx({ user: adminUser, url: `${BASE}/appointments?status=completed` })))).body.appointments[0].clientName).toBe('De B');
    expect((await asJson(await getAppointments(ctx({ user: adminUser, url: `${BASE}/appointments?from=2026-10-15` })))).body.appointments).toHaveLength(0);
    expect((await asJson(await getAppointments(ctx({ user: adminUser, url: `${BASE}/appointments?from=2026-10-14&to=2026-10-14` })))).body.appointments).toHaveLength(2);
    expect((await getAppointments(ctx({ user: adminUser, url: `${BASE}/appointments?status=raro` }))).status).toBe(400);
  });

  it('PATCH estado: barbero solo sus citas; admin cualquiera; estados válidos', async () => {
    const mine = await book(a.barber, a.service, '10:00');
    const theirs = await book(b.barber, b.service, '10:00');
    const patch = (user: SessionUser, id: number, body: unknown) =>
      patchAppointment(ctx({ user, method: 'PATCH', params: { id: String(id) }, body }));

    expect((await patch(barberUser, theirs.id, { status: 'completed' })).status).toBe(403);
    expect((await patch(barberUser, mine.id, { status: 'inventado' })).status).toBe(422);

    const done = await asJson(await patch(barberUser, mine.id, { status: 'completed' }));
    expect(done.status).toBe(200);
    expect(done.body.appointment.status).toBe('completed');

    const cancelled = await asJson(await patch(adminUser, theirs.id, { status: 'cancelled', reason: 'Cliente avisó' }));
    expect(cancelled.body.appointment.status).toBe('cancelled');
    expect(cancelled.body.appointment.cancellationReason).toBe('Cliente avisó');

    // cancelar libera el slot; volver a confirmar cuando otro ya lo tomó → 409
    await book(b.barber, b.service, '10:00', 'Nuevo');
    expect((await patch(adminUser, theirs.id, { status: 'confirmed' })).status).toBe(409);
  });
});
