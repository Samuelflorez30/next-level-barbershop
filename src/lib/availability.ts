import { and, eq, gt, inArray, isNull, lt, or } from 'drizzle-orm';
import { db as defaultDb, type Database } from '../db/client';
import {
  appointments,
  barberSchedules,
  barberServices,
  barberTimeOff,
  barbers,
  services,
  type Barber,
  type BarberSchedule,
  type Service,
} from '../db/schema';
import {
  DAY_MS,
  addMinutes,
  bogotaDayOfWeek,
  bogotaDayStart,
  bogotaToUtc,
  intervalsOverlap,
  utcToBogota,
} from './time';

/** Los slots candidatos se generan cada 60 minutos desde la hora de apertura. */
export const SLOT_STEP_MINUTES = 60;

/** Estados de cita que ocupan la agenda. */
export const BLOCKING_STATUSES = ['pending', 'confirmed'] as const;

export interface Slot {
  /** Inicio en UTC. */
  start: Date;
  /** Fin en UTC (inicio + duración efectiva del servicio). */
  end: Date;
  /** Inicio en hora local Bogotá, "HH:MM". */
  startLocal: string;
  /** Fin en hora local Bogotá, "HH:MM". */
  endLocal: string;
}

export interface Interval {
  start: Date;
  end: Date;
}

export interface BookingContext {
  barber: Barber;
  service: Service;
  /** Duración efectiva: override del barbero o la del servicio. */
  durationMinutes: number;
  /** Precio efectivo en COP: override del barbero o el del servicio. */
  price: number;
}

/**
 * Resuelve barbero + servicio y calcula duración y precio efectivos.
 * Devuelve null si alguno no existe, está inactivo, o el barbero no ofrece
 * ese servicio.
 */
export async function resolveBookingContext(
  barberId: number,
  serviceId: number,
  database: Database = defaultDb,
): Promise<BookingContext | null> {
  const [barber, service, offering] = await Promise.all([
    database.query.barbers.findFirst({
      where: and(eq(barbers.id, barberId), eq(barbers.isActive, true)),
    }),
    database.query.services.findFirst({
      where: and(eq(services.id, serviceId), eq(services.isActive, true)),
    }),
    database.query.barberServices.findFirst({
      where: and(
        eq(barberServices.barberId, barberId),
        eq(barberServices.serviceId, serviceId),
      ),
    }),
  ]);

  if (!barber || !service || !offering || !offering.isOffered) return null;

  return {
    barber,
    service,
    durationMinutes: offering.durationMinutes ?? service.defaultDurationMinutes,
    price: offering.price ?? service.defaultPrice,
  };
}

/**
 * Genera los slots candidatos de un día a partir de las franjas del horario:
 * cada 60 min alineados a la apertura de cada franja, siempre que el servicio
 * completo quepa antes del cierre.
 */
export function generateCandidateSlots(
  schedules: Pick<BarberSchedule, 'startTime' | 'endTime'>[],
  date: string,
  durationMinutes: number,
): Slot[] {
  const slots: Slot[] = [];
  for (const window of schedules) {
    const windowStart = bogotaToUtc(date, window.startTime);
    const windowEnd = bogotaToUtc(date, window.endTime);
    for (
      let start = windowStart;
      addMinutes(start, durationMinutes) <= windowEnd;
      start = addMinutes(start, SLOT_STEP_MINUTES)
    ) {
      const end = addMinutes(start, durationMinutes);
      slots.push({
        start,
        end,
        startLocal: utcToBogota(start).time,
        endLocal: utcToBogota(end).time,
      });
    }
  }
  return slots.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Franjas activas del barbero para el día de la semana de `date`. */
export async function getSchedulesForDate(
  barberId: number,
  date: string,
  database: Database = defaultDb,
): Promise<BarberSchedule[]> {
  return database.query.barberSchedules.findMany({
    where: and(
      eq(barberSchedules.barberId, barberId),
      eq(barberSchedules.dayOfWeek, bogotaDayOfWeek(date)),
      eq(barberSchedules.isActive, true),
    ),
  });
}

/**
 * Citas activas del barbero que tocan [from, to), ya expandidas por el buffer
 * en ambos extremos.
 */
export async function getAppointmentBlocks(
  barberId: number,
  from: Date,
  to: Date,
  bufferMinutes: number,
  database: Database = defaultDb,
): Promise<Interval[]> {
  const rows = await database.query.appointments.findMany({
    columns: { startDatetime: true, endDatetime: true },
    where: and(
      eq(appointments.barberId, barberId),
      inArray(appointments.status, [...BLOCKING_STATUSES]),
      gt(appointments.endDatetime, addMinutes(from, -bufferMinutes)),
      lt(appointments.startDatetime, addMinutes(to, bufferMinutes)),
    ),
  });
  return rows.map((r) => ({
    start: addMinutes(r.startDatetime, -bufferMinutes),
    end: addMinutes(r.endDatetime, bufferMinutes),
  }));
}

/** Bloqueos (del barbero o globales) que tocan [from, to). */
export async function getTimeOffBlocks(
  barberId: number,
  from: Date,
  to: Date,
  database: Database = defaultDb,
): Promise<Interval[]> {
  const rows = await database.query.barberTimeOff.findMany({
    columns: { startDatetime: true, endDatetime: true },
    where: and(
      or(eq(barberTimeOff.barberId, barberId), isNull(barberTimeOff.barberId)),
      gt(barberTimeOff.endDatetime, from),
      lt(barberTimeOff.startDatetime, to),
    ),
  });
  return rows.map((r) => ({ start: r.startDatetime, end: r.endDatetime }));
}

export function isSlotFree(slot: Interval, blocks: Interval[]): boolean {
  return !blocks.some((b) => intervalsOverlap(slot.start, slot.end, b.start, b.end));
}

export interface ComputeAvailableSlotsParams {
  barberId: number;
  serviceId: number;
  /** "YYYY-MM-DD" en hora local de Bogotá. */
  date: string;
  /** Si se indica, descarta los slots que empiezan antes de este instante. */
  now?: Date;
}

/**
 * Horarios realmente disponibles de un barbero para un servicio en una fecha:
 * slots candidatos del horario menos citas activas (con buffer) y bloqueos.
 */
export async function computeAvailableSlots(
  { barberId, serviceId, date, now }: ComputeAvailableSlotsParams,
  database: Database = defaultDb,
): Promise<Slot[]> {
  const ctx = await resolveBookingContext(barberId, serviceId, database);
  if (!ctx) return [];

  const schedules = await getSchedulesForDate(barberId, date, database);
  if (schedules.length === 0) return [];

  const candidates = generateCandidateSlots(schedules, date, ctx.durationMinutes);
  if (candidates.length === 0) return [];

  const dayStart = bogotaDayStart(date);
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);

  const [appointmentBlocks, timeOffBlocks] = await Promise.all([
    getAppointmentBlocks(barberId, dayStart, dayEnd, ctx.barber.bufferMinutes, database),
    getTimeOffBlocks(barberId, dayStart, dayEnd, database),
  ]);
  const blocks = [...appointmentBlocks, ...timeOffBlocks];

  return candidates.filter(
    (slot) => (!now || slot.start >= now) && isSlotFree(slot, blocks),
  );
}
