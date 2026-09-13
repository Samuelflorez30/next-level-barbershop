import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// La URL de la base de datos temporal debe existir ANTES de importar el cliente.
const dbFile = await vi.hoisted(async () => {
  const { useTempDatabase } = await import('../test/db');
  return useTempDatabase();
});

import { db, libsqlClient } from '../db/client';
import { appointments, barberTimeOff, type AppointmentStatus, type Barber, type Service } from '../db/schema';
import { migrateTestDb, removeTempDatabase, seedFixtures, truncateAll } from '../test/db';
import { computeAvailableSlots } from './availability';
import { bogotaDayOfWeek, bogotaToUtc, utcToBogota } from './time';

// 2026-10-14 es miércoles; 2026-10-18 es domingo.
const WEDNESDAY = '2026-10-14';
const SUNDAY = '2026-10-18';

const at = (time: string, date = WEDNESDAY) => bogotaToUtc(date, time);

async function book(
  barber: Barber,
  service: Service,
  start: string,
  end: string,
  status: AppointmentStatus = 'confirmed',
  date = WEDNESDAY,
) {
  await db.insert(appointments).values({
    barberId: barber.id,
    serviceId: service.id,
    clientName: 'Cliente',
    clientPhone: '573000000001',
    startDatetime: at(start, date),
    endDatetime: at(end, date),
    price: 30000,
    status,
    confirmationToken: crypto.randomUUID(),
  });
}

beforeAll(async () => {
  await migrateTestDb(db);
});

afterAll(() => {
  libsqlClient.close();
  removeTempDatabase(dbFile);
});

beforeEach(async () => {
  await truncateAll(db);
});

describe('helpers de zona horaria (America/Bogota, UTC-5)', () => {
  it('convierte hora local a UTC y viceversa', () => {
    const utc = bogotaToUtc('2026-10-14', '09:00');
    expect(utc.toISOString()).toBe('2026-10-14T14:00:00.000Z');
    expect(utcToBogota(utc)).toEqual({ date: '2026-10-14', time: '09:00' });
  });

  it('maneja el cruce de medianoche (22:00 local = 03:00Z del día siguiente)', () => {
    const utc = bogotaToUtc('2026-10-14', '22:00');
    expect(utc.toISOString()).toBe('2026-10-15T03:00:00.000Z');
    expect(utcToBogota(utc)).toEqual({ date: '2026-10-14', time: '22:00' });
  });

  it('day_of_week: 0 = lunes … 6 = domingo', () => {
    expect(bogotaDayOfWeek('2026-10-12')).toBe(0); // lunes
    expect(bogotaDayOfWeek(WEDNESDAY)).toBe(2);
    expect(bogotaDayOfWeek(SUNDAY)).toBe(6);
  });
});

describe('computeAvailableSlots', () => {
  it('día totalmente libre: slots en punto cada hora, 09:00 a 20:00', async () => {
    const { barber, service } = await seedFixtures(db);

    const slots = await computeAvailableSlots(
      { barberId: barber.id, serviceId: service.id, date: WEDNESDAY },
      db,
    );

    expect(slots.map((s) => s.startLocal)).toEqual([
      '09:00', '10:00', '11:00', '12:00', '13:00', '14:00',
      '15:00', '16:00', '17:00', '18:00', '19:00', '20:00',
    ]);
    // Todos en punto, duración 60, y el último termina exactamente al cierre.
    for (const s of slots) {
      expect(s.start.getUTCMinutes()).toBe(0);
      expect(s.end.getTime() - s.start.getTime()).toBe(60 * 60_000);
    }
    expect(slots[0].start.toISOString()).toBe('2026-10-14T14:00:00.000Z');
    expect(slots.at(-1)!.endLocal).toBe('21:00');
  });

  it('domingo abre a las 10:00: el primer slot es 10:00', async () => {
    const { barber, service } = await seedFixtures(db, {
      days: [6],
      startTime: '10:00',
      endTime: '21:00',
    });

    const slots = await computeAvailableSlots(
      { barberId: barber.id, serviceId: service.id, date: SUNDAY },
      db,
    );
    expect(slots[0].startLocal).toBe('10:00');
    expect(slots).toHaveLength(11);
  });

  it('día sin horario: sin slots', async () => {
    const { barber, service } = await seedFixtures(db, { days: [0, 1] }); // solo lunes y martes
    const slots = await computeAvailableSlots(
      { barberId: barber.id, serviceId: service.id, date: WEDNESDAY },
      db,
    );
    expect(slots).toEqual([]);
  });

  it('turno partido: dos franjas generan slots alineados a cada apertura', async () => {
    const { barber, service } = await seedFixtures(db, { days: [] });
    const { barberSchedules } = await import('../db/schema');
    await db.insert(barberSchedules).values([
      { barberId: barber.id, dayOfWeek: 2, startTime: '09:00', endTime: '12:00' },
      { barberId: barber.id, dayOfWeek: 2, startTime: '14:30', endTime: '17:30' },
    ]);

    const slots = await computeAvailableSlots(
      { barberId: barber.id, serviceId: service.id, date: WEDNESDAY },
      db,
    );
    expect(slots.map((s) => s.startLocal)).toEqual(['09:00', '10:00', '11:00', '14:30', '15:30', '16:30']);
  });

  it('día totalmente ocupado: sin slots', async () => {
    const { barber, service } = await seedFixtures(db);
    for (let h = 9; h < 21; h++) {
      const hh = String(h).padStart(2, '0');
      const next = String(h + 1).padStart(2, '0');
      await book(barber, service, `${hh}:00`, `${next}:00`);
    }

    const slots = await computeAvailableSlots(
      { barberId: barber.id, serviceId: service.id, date: WEDNESDAY },
      db,
    );
    expect(slots).toEqual([]);
  });

  it('cita en el límite de cierre con buffer: bloquea también el slot anterior', async () => {
    // buffer 5 → la cita 20:00–21:00 ocupa [19:55, 21:05) y solapa el slot 19:00–20:00.
    const { barber, service } = await seedFixtures(db, { bufferMinutes: 5 });
    await book(barber, service, '20:00', '21:00');

    const locals = (
      await computeAvailableSlots({ barberId: barber.id, serviceId: service.id, date: WEDNESDAY }, db)
    ).map((s) => s.startLocal);

    expect(locals).not.toContain('20:00');
    expect(locals).not.toContain('19:00');
    expect(locals).toContain('18:00');
    expect(locals).toHaveLength(10);
  });

  it('sin buffer, una cita solo bloquea su propio slot', async () => {
    const { barber, service } = await seedFixtures(db, { bufferMinutes: 0 });
    await book(barber, service, '20:00', '21:00');

    const locals = (
      await computeAvailableSlots({ barberId: barber.id, serviceId: service.id, date: WEDNESDAY }, db)
    ).map((s) => s.startLocal);

    expect(locals).not.toContain('20:00');
    expect(locals).toContain('19:00');
    expect(locals).toHaveLength(11);
  });

  it('una cita a media mañana con buffer bloquea el slot anterior y el siguiente', async () => {
    const { barber, service } = await seedFixtures(db, { bufferMinutes: 5 });
    await book(barber, service, '12:00', '13:00'); // ocupa [11:55, 13:05)

    const locals = (
      await computeAvailableSlots({ barberId: barber.id, serviceId: service.id, date: WEDNESDAY }, db)
    ).map((s) => s.startLocal);

    expect(locals).not.toContain('11:00');
    expect(locals).not.toContain('12:00');
    expect(locals).not.toContain('13:00');
    expect(locals).toContain('10:00');
    expect(locals).toContain('14:00');
  });

  it('las citas canceladas no ocupan la agenda', async () => {
    const { barber, service } = await seedFixtures(db);
    await book(barber, service, '10:00', '11:00', 'cancelled');

    const locals = (
      await computeAvailableSlots({ barberId: barber.id, serviceId: service.id, date: WEDNESDAY }, db)
    ).map((s) => s.startLocal);
    expect(locals).toContain('10:00');
    expect(locals).toHaveLength(12);
  });

  it('las citas de otro barbero no afectan', async () => {
    const a = await seedFixtures(db);
    const b = await seedFixtures(db);
    await book(b.barber, b.service, '10:00', '11:00');

    const locals = (
      await computeAvailableSlots({ barberId: a.barber.id, serviceId: a.service.id, date: WEDNESDAY }, db)
    ).map((s) => s.startLocal);
    expect(locals).toHaveLength(12);
  });

  it('time-off parcial del barbero: elimina los slots que solapa', async () => {
    const { barber, service } = await seedFixtures(db);
    await db.insert(barberTimeOff).values({
      barberId: barber.id,
      startDatetime: at('12:00'),
      endDatetime: at('15:00'),
      reason: 'Almuerzo largo',
    });

    const locals = (
      await computeAvailableSlots({ barberId: barber.id, serviceId: service.id, date: WEDNESDAY }, db)
    ).map((s) => s.startLocal);

    expect(locals).toEqual(['09:00', '10:00', '11:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00']);
  });

  it('time-off que empieza a media hora bloquea el slot que lo contiene', async () => {
    const { barber, service } = await seedFixtures(db);
    await db.insert(barberTimeOff).values({
      barberId: barber.id,
      startDatetime: at('12:30'),
      endDatetime: at('13:30'),
    });

    const locals = (
      await computeAvailableSlots({ barberId: barber.id, serviceId: service.id, date: WEDNESDAY }, db)
    ).map((s) => s.startLocal);
    expect(locals).not.toContain('12:00');
    expect(locals).not.toContain('13:00');
    expect(locals).toContain('11:00');
    expect(locals).toContain('14:00');
  });

  it('time-off global (barberId null) aplica a todos los barberos', async () => {
    const a = await seedFixtures(db);
    const b = await seedFixtures(db);
    await db.insert(barberTimeOff).values({
      barberId: null,
      startDatetime: at('00:00'),
      endDatetime: at('00:00', '2026-10-15'),
      reason: 'Festivo',
    });

    for (const { barber, service } of [a, b]) {
      const slots = await computeAvailableSlots(
        { barberId: barber.id, serviceId: service.id, date: WEDNESDAY },
        db,
      );
      expect(slots).toEqual([]);
    }
  });

  it('el time-off de otro barbero no afecta', async () => {
    const a = await seedFixtures(db);
    const b = await seedFixtures(db);
    await db.insert(barberTimeOff).values({
      barberId: b.barber.id,
      startDatetime: at('09:00'),
      endDatetime: at('21:00'),
    });
    const slots = await computeAvailableSlots(
      { barberId: a.barber.id, serviceId: a.service.id, date: WEDNESDAY },
      db,
    );
    expect(slots).toHaveLength(12);
  });

  it('usa la duración del override de barber_services si existe', async () => {
    const { barber, service } = await seedFixtures(db);
    const { barberServices } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    await db
      .update(barberServices)
      .set({ durationMinutes: 90 })
      .where(eq(barberServices.barberId, barber.id));

    const slots = await computeAvailableSlots(
      { barberId: barber.id, serviceId: service.id, date: WEDNESDAY },
      db,
    );
    // Sigue arrancando cada hora; 20:00 + 90 min excedería el cierre (21:00), así que el último es 19:00.
    expect(slots.map((s) => s.startLocal)).toEqual([
      '09:00', '10:00', '11:00', '12:00', '13:00', '14:00',
      '15:00', '16:00', '17:00', '18:00', '19:00',
    ]);
    expect(slots[0].endLocal).toBe('10:30');
  });

  it('con `now`, descarta los slots que ya pasaron', async () => {
    const { barber, service } = await seedFixtures(db);
    const slots = await computeAvailableSlots(
      { barberId: barber.id, serviceId: service.id, date: WEDNESDAY, now: at('11:30') },
      db,
    );
    expect(slots[0].startLocal).toBe('12:00');
  });

  it('barbero que no ofrece el servicio: sin slots', async () => {
    const { barber, service } = await seedFixtures(db);
    const { barberServices } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    await db
      .update(barberServices)
      .set({ isOffered: false })
      .where(eq(barberServices.barberId, barber.id));

    const slots = await computeAvailableSlots(
      { barberId: barber.id, serviceId: service.id, date: WEDNESDAY },
      db,
    );
    expect(slots).toEqual([]);
  });
});
