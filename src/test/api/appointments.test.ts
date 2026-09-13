/**
 * Test de integración de la API de citas: llama a los handlers de Astro
 * directamente con Request/URL reales, contra una SQLite temporal migrada.
 */
import type { APIContext } from 'astro';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dbFile = await vi.hoisted(async () => {
  const { useTempDatabase } = await import('../db');
  return useTempDatabase();
});

import { db, libsqlClient } from '../../db/client';
import { barberTimeOff, type Barber, type Service } from '../../db/schema';
import { migrateTestDb, removeTempDatabase, seedFixtures, truncateAll } from '../db';
import { bogotaToUtc } from '../../lib/time';
import { GET as getAvailability } from '../../pages/api/availability';
import { POST as postAppointment } from '../../pages/api/appointments';
import { GET as getByToken, PATCH as patchByToken } from '../../pages/api/appointments/[token]';

const WEDNESDAY = '2026-10-14';
const at = (time: string) => bogotaToUtc(WEDNESDAY, time);

const BASE = 'http://localhost/api';

function ctx(partial: Partial<APIContext>): APIContext {
  return partial as APIContext;
}

async function availability(barberId: number, serviceId: number, date = WEDNESDAY) {
  const url = new URL(`${BASE}/availability?barberId=${barberId}&serviceId=${serviceId}&date=${date}`);
  const res = await getAvailability(ctx({ url }));
  return { status: res.status, body: await res.json() };
}

async function post(body: unknown) {
  const request = new Request(`${BASE}/appointments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const res = await postAppointment(ctx({ request }));
  return { status: res.status, body: await res.json() };
}

async function getAppointment(token: string) {
  const res = await getByToken(ctx({ params: { token } }));
  return { status: res.status, body: await res.json() };
}

async function patchAppointment(token: string, body: unknown) {
  const request = new Request(`${BASE}/appointments/${token}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await patchByToken(ctx({ params: { token }, request }));
  return { status: res.status, body: await res.json() };
}

function validBody(barber: Barber, service: Service, time = '10:00', extra: Record<string, unknown> = {}) {
  return {
    barberId: barber.id,
    serviceId: service.id,
    startDatetime: at(time).toISOString(),
    clientName: 'Juan Pérez',
    clientPhone: '573001234567',
    clientEmail: 'juan@example.com',
    clientNote: 'Sin nota',
    ...extra,
  };
}

let barber: Barber;
let service: Service;

beforeAll(async () => {
  await migrateTestDb(db);
});

afterAll(() => {
  libsqlClient.close();
  removeTempDatabase(dbFile);
});

beforeEach(async () => {
  await truncateAll(db);
  ({ barber, service } = await seedFixtures(db));
});

describe('GET /api/availability', () => {
  it('devuelve slots en punto con hora local y UTC', async () => {
    const { status, body } = await availability(barber.id, service.id);
    expect(status).toBe(200);
    expect(body.timezone).toBe('America/Bogota');
    expect(body.slots.map((s: { startLocal: string }) => s.startLocal)).toEqual([
      '09:00', '10:00', '11:00', '12:00', '13:00', '14:00',
      '15:00', '16:00', '17:00', '18:00', '19:00', '20:00',
    ]);
    expect(body.slots[0].start).toBe('2026-10-14T14:00:00.000Z');
    expect(body.slots[0].end).toBe('2026-10-14T15:00:00.000Z');
  });

  it('valida parámetros', async () => {
    const bad = await getAvailability(ctx({ url: new URL(`${BASE}/availability?barberId=x&serviceId=1&date=2026-10-14`) }));
    expect(bad.status).toBe(400);
    const badDate = await getAvailability(ctx({ url: new URL(`${BASE}/availability?barberId=1&serviceId=1&date=2026-13-40`) }));
    expect(badDate.status).toBe(400);
    const missing = await getAvailability(ctx({ url: new URL(`${BASE}/availability?serviceId=1&date=2026-10-14`) }));
    expect(missing.status).toBe(400);
  });
});

describe('POST /api/appointments', () => {
  it('crea una cita confirmada con precio y duración calculados en el servidor', async () => {
    // El cliente intenta enviar precio/duración/status: se ignoran.
    const { status, body } = await post(
      validBody(barber, service, '10:00', { price: 1, durationMinutes: 5, status: 'pending' }),
    );

    expect(status).toBe(201);
    expect(body.id).toEqual(expect.any(Number));
    expect(body.confirmationToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.status).toBe('confirmed');
    expect(body.price).toBe(30000);
    expect(body.startDatetime).toBe('2026-10-14T15:00:00.000Z');
    expect(body.endDatetime).toBe('2026-10-14T16:00:00.000Z');
    expect(body.clientName).toBe('Juan Pérez');
  });

  it('usa los overrides de barber_services para precio y duración', async () => {
    const { barberServices } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    await db
      .update(barberServices)
      .set({ price: 45000, durationMinutes: 120 })
      .where(eq(barberServices.barberId, barber.id));

    const { status, body } = await post(validBody(barber, service, '10:00'));
    expect(status).toBe(201);
    expect(body.price).toBe(45000);
    expect(body.endDatetime).toBe('2026-10-14T17:00:00.000Z');
  });

  it('la cita creada desaparece de la disponibilidad sin afectar los slots vecinos', async () => {
    await post(validBody(barber, service, '10:00'));
    const { body } = await availability(barber.id, service.id);
    const locals = body.slots.map((s: { startLocal: string }) => s.startLocal);
    expect(locals).not.toContain('10:00');
    expect(locals).toContain('09:00');
    expect(locals).toContain('11:00');
    expect(locals).toHaveLength(11);
  });

  it('se pueden reservar horas consecutivas (09:00, 10:00 y 11:00)', async () => {
    for (const t of ['09:00', '10:00', '11:00']) {
      expect((await post(validBody(barber, service, t))).status).toBe(201);
    }
  });

  it('responde 409 si el slot ya está ocupado', async () => {
    const first = await post(validBody(barber, service, '10:00'));
    expect(first.status).toBe(201);

    const second = await post(validBody(barber, service, '10:00', { clientName: 'Otro Cliente' }));
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('SLOT_TAKEN');
  });

  it('con buffer explícito, responde 409 si el slot solapa por buffer con otra cita', async () => {
    const { barbers } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    await db.update(barbers).set({ bufferMinutes: 5 }).where(eq(barbers.id, barber.id));

    await post(validBody(barber, service, '10:00'));
    const adjacent = await post(validBody(barber, service, '11:00'));
    expect(adjacent.status).toBe(409);
  });

  it('dos solicitudes casi simultáneas: una 201 y la otra 409', async () => {
    const [a, b] = await Promise.all([
      post(validBody(barber, service, '14:00', { clientName: 'Cliente A' })),
      post(validBody(barber, service, '14:00', { clientName: 'Cliente B' })),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);

    const { body } = await availability(barber.id, service.id);
    expect(body.slots.map((s: { startLocal: string }) => s.startLocal)).not.toContain('14:00');
  });

  it('carrera con 5 solicitudes simultáneas: exactamente una gana', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        post(validBody(barber, service, '16:00', { clientName: `Cliente ${i}` })),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
  });

  it('responde 422 si la hora está fuera del horario o no está alineada', async () => {
    const early = await post(validBody(barber, service, '03:00'));
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('SLOT_OUTSIDE_SCHEDULE');

    const misaligned = await post(validBody(barber, service, '10:30'));
    expect(misaligned.status).toBe(422);

    const atClose = await post(validBody(barber, service, '21:00'));
    expect(atClose.status).toBe(422);
  });

  it('responde 409 si el slot cae dentro de un time-off', async () => {
    await db.insert(barberTimeOff).values({
      barberId: barber.id,
      startDatetime: at('12:00'),
      endDatetime: at('14:00'),
    });
    const { status } = await post(validBody(barber, service, '12:00'));
    expect(status).toBe(409);
  });

  it('responde 404 si el barbero o servicio no existe / no se ofrece', async () => {
    const { status } = await post(validBody(barber, service, '10:00', { serviceId: 9999 }));
    expect(status).toBe(404);
  });

  it('responde 400 con body inválido', async () => {
    const noJson = await post('esto no es json');
    expect(noJson.status).toBe(400);

    const missingName = await post(validBody(barber, service, '10:00', { clientName: '' }));
    expect(missingName.status).toBe(400);
    expect(missingName.body.error.details.clientName).toBeDefined();

    const badPhone = await post(validBody(barber, service, '10:00', { clientPhone: 'abc' }));
    expect(badPhone.status).toBe(400);

    const badDate = await post(validBody(barber, service, '10:00', { startDatetime: 'ayer' }));
    expect(badDate.status).toBe(400);
  });
});

describe('GET/PATCH /api/appointments/:token', () => {
  it('GET devuelve la cita con barbero y servicio', async () => {
    const created = await post(validBody(barber, service, '10:00'));
    const { status, body } = await getAppointment(created.body.confirmationToken);

    expect(status).toBe(200);
    expect(body.appointment.id).toBe(created.body.id);
    expect(body.appointment.status).toBe('confirmed');
    expect(body.appointment.barber.name).toBe(barber.name);
    expect(body.appointment.service.name).toBe(service.name);
  });

  it('GET responde 404 con token desconocido o mal formado', async () => {
    expect((await getAppointment(crypto.randomUUID())).status).toBe(404);
    expect((await getAppointment('no-es-un-uuid')).status).toBe(404);
  });

  it('PATCH cancel cambia el estado y libera el slot', async () => {
    const created = await post(validBody(barber, service, '10:00'));
    const token = created.body.confirmationToken;

    const { status, body } = await patchAppointment(token, { action: 'cancel', reason: 'No puedo asistir' });
    expect(status).toBe(200);
    expect(body.appointment.status).toBe('cancelled');
    expect(body.appointment.cancellationReason).toBe('No puedo asistir');
    expect(body.alreadyCancelled).toBe(false);

    const again = await patchAppointment(token, { action: 'cancel' });
    expect(again.status).toBe(200);
    expect(again.body.alreadyCancelled).toBe(true);

    const { body: avail } = await availability(barber.id, service.id);
    expect(avail.slots.map((s: { startLocal: string }) => s.startLocal)).toContain('10:00');

    // El slot puede volver a reservarse.
    const rebook = await post(validBody(barber, service, '10:00'));
    expect(rebook.status).toBe(201);
  });

  it('PATCH valida el body', async () => {
    const created = await post(validBody(barber, service, '10:00'));
    const bad = await patchAppointment(created.body.confirmationToken, { action: 'delete' });
    expect(bad.status).toBe(400);
  });

  it('PATCH responde 404 con token desconocido', async () => {
    const { status } = await patchAppointment(crypto.randomUUID(), { action: 'cancel' });
    expect(status).toBe(404);
  });
});
