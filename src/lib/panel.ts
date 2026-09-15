/**
 * Lógica del panel: autorización por rol y operaciones sobre horarios,
 * días libres y citas. Los endpoints de /api/panel y las páginas /panel
 * pasan por aquí; NUNCA se confía en el barberId que venga del cliente
 * para decidir permisos.
 */
import { and, asc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import { db as defaultDb, type Database } from '../db/client';
import { isUniqueViolation } from '../db/errors';
import {
  appointments,
  barberSchedules,
  barberTimeOff,
  barbers,
  type AppointmentStatus,
  type BarberSchedule,
  type BarberTimeOff,
} from '../db/schema';
import type { SessionUser } from './auth';
import { sendCancellationNotice } from './notifications';
import { bogotaToUtc, isValidDateString, isValidTimeString } from './time';

// ---------------------------------------------------------------------------
// Errores de autorización / validación
// ---------------------------------------------------------------------------
export class PanelError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 422,
    public readonly code: string,
    message: string,
    /** Detalle opcional para el cliente (p. ej. errores por campo `{ campo: [mensajes] }`). */
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PanelError';
  }
}

const forbidden = () => new PanelError(403, 'FORBIDDEN', 'No tienes permiso para esta acción.');

/**
 * Determina sobre qué barbero actúa el usuario:
 * - barber → SIEMPRE su propio barberId (se ignora lo que pida).
 * - admin  → el barberId solicitado (obligatorio salvo `allowGlobal`, donde
 *            null significa "todo el negocio").
 */
export async function resolveBarberScope(
  user: SessionUser,
  requested: number | null | undefined,
  opts: { allowGlobal?: boolean } = {},
  database: Database = defaultDb,
): Promise<number | null> {
  if (user.role === 'barber') {
    if (user.barberId === null) throw forbidden();
    return user.barberId;
  }
  if (requested === null || requested === undefined) {
    if (opts.allowGlobal) return null;
    throw new PanelError(400, 'BARBER_ID_REQUIRED', 'Indica el barbero.');
  }
  const exists = await database.query.barbers.findFirst({
    columns: { id: true },
    where: eq(barbers.id, requested),
  });
  if (!exists) throw new PanelError(404, 'BARBER_NOT_FOUND', 'Barbero no encontrado.');
  return requested;
}

/** Garantiza que el usuario pueda tocar un registro de ese barbero. */
export function assertCanAccessBarber(user: SessionUser, barberId: number | null) {
  if (user.role === 'admin') return;
  if (barberId === null || barberId !== user.barberId) throw forbidden();
}

export function listBarbersForPanel(database: Database = defaultDb) {
  return database.query.barbers.findMany({
    columns: { id: true, name: true, slug: true, role: true, photoUrl: true, isActive: true },
    orderBy: [asc(barbers.displayOrder), asc(barbers.id)],
  });
}

// ---------------------------------------------------------------------------
// Horario semanal
// ---------------------------------------------------------------------------
export const DAY_NAMES = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

export interface ScheduleRangeInput {
  startTime: string;
  endTime: string;
}
export interface DayScheduleInput {
  dayOfWeek: number;
  ranges: ScheduleRangeInput[];
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function validateRange(r: ScheduleRangeInput) {
  if (!isValidTimeString(r.startTime) || !isValidTimeString(r.endTime)) {
    throw new PanelError(422, 'INVALID_TIME', 'Las horas deben tener formato HH:MM.');
  }
  if (toMinutes(r.startTime) >= toMinutes(r.endTime)) {
    throw new PanelError(422, 'INVALID_RANGE', 'La hora de inicio debe ser anterior a la de cierre.');
  }
}

export function validateDay(day: DayScheduleInput) {
  if (!Number.isInteger(day.dayOfWeek) || day.dayOfWeek < 0 || day.dayOfWeek > 6) {
    throw new PanelError(422, 'INVALID_DAY', 'day_of_week debe estar entre 0 (lunes) y 6 (domingo).');
  }
  const sorted = [...day.ranges].sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
  sorted.forEach(validateRange);
  for (let i = 1; i < sorted.length; i++) {
    if (toMinutes(sorted[i].startTime) < toMinutes(sorted[i - 1].endTime)) {
      throw new PanelError(422, 'OVERLAPPING_RANGES', `Las franjas del ${DAY_NAMES[day.dayOfWeek]} se solapan.`);
    }
  }
}

export function getWeekSchedule(barberId: number, database: Database = defaultDb) {
  return database.query.barberSchedules.findMany({
    where: eq(barberSchedules.barberId, barberId),
    orderBy: [asc(barberSchedules.dayOfWeek), asc(barberSchedules.startTime)],
  });
}

/** Reemplaza el horario completo de la semana (transacción). */
export async function replaceWeekSchedule(
  barberId: number,
  days: DayScheduleInput[],
  database: Database = defaultDb,
): Promise<BarberSchedule[]> {
  const seen = new Set<number>();
  for (const day of days) {
    validateDay(day);
    if (seen.has(day.dayOfWeek)) throw new PanelError(422, 'DUPLICATE_DAY', 'Día repetido.');
    seen.add(day.dayOfWeek);
  }
  const rows = days.flatMap((d) =>
    d.ranges.map((r) => ({ barberId, dayOfWeek: d.dayOfWeek, startTime: r.startTime, endTime: r.endTime })),
  );
  await database.transaction(async (tx) => {
    await tx.delete(barberSchedules).where(eq(barberSchedules.barberId, barberId));
    if (rows.length > 0) await tx.insert(barberSchedules).values(rows);
  });
  return getWeekSchedule(barberId, database);
}

export async function createScheduleRange(
  barberId: number,
  input: ScheduleRangeInput & { dayOfWeek: number },
  database: Database = defaultDb,
): Promise<BarberSchedule> {
  const existing = (await getWeekSchedule(barberId, database)).filter((r) => r.dayOfWeek === input.dayOfWeek);
  validateDay({ dayOfWeek: input.dayOfWeek, ranges: [...existing, input] });
  const [row] = await database
    .insert(barberSchedules)
    .values({ barberId, dayOfWeek: input.dayOfWeek, startTime: input.startTime, endTime: input.endTime })
    .returning();
  return row;
}

export async function updateScheduleRange(
  user: SessionUser,
  id: number,
  patch: Partial<ScheduleRangeInput & { isActive: boolean }>,
  database: Database = defaultDb,
): Promise<BarberSchedule> {
  const row = await database.query.barberSchedules.findFirst({ where: eq(barberSchedules.id, id) });
  if (!row) throw new PanelError(404, 'NOT_FOUND', 'Franja no encontrada.');
  assertCanAccessBarber(user, row.barberId);

  const next = { ...row, ...patch };
  const others = (await getWeekSchedule(row.barberId, database)).filter(
    (r) => r.dayOfWeek === row.dayOfWeek && r.id !== id && r.isActive,
  );
  if (next.isActive) validateDay({ dayOfWeek: row.dayOfWeek, ranges: [...others, next] });
  else validateRange(next);

  const [updated] = await database
    .update(barberSchedules)
    .set({ startTime: next.startTime, endTime: next.endTime, isActive: next.isActive })
    .where(eq(barberSchedules.id, id))
    .returning();
  return updated;
}

export async function deleteScheduleRange(user: SessionUser, id: number, database: Database = defaultDb) {
  const row = await database.query.barberSchedules.findFirst({ where: eq(barberSchedules.id, id) });
  if (!row) throw new PanelError(404, 'NOT_FOUND', 'Franja no encontrada.');
  assertCanAccessBarber(user, row.barberId);
  await database.delete(barberSchedules).where(eq(barberSchedules.id, id));
}

// ---------------------------------------------------------------------------
// Días libres / bloqueos
// ---------------------------------------------------------------------------
export interface TimeOffInput {
  /** "YYYY-MM-DDTHH:MM" en hora local Bogotá (datetime-local). */
  startLocal: string;
  endLocal: string;
  reason?: string | null;
}

function parseLocal(value: string, field: string): Date {
  const [date, time] = value.split('T');
  if (!date || !time || !isValidDateString(date) || !isValidTimeString(time.slice(0, 5))) {
    throw new PanelError(422, 'INVALID_DATETIME', `${field} debe tener formato YYYY-MM-DDTHH:MM.`);
  }
  return bogotaToUtc(date, time.slice(0, 5));
}

/** Lista bloqueos: los del barbero + los globales; admin con `barberId` null ve todos. */
export function listTimeOff(
  barberId: number | null,
  opts: { from?: Date } = {},
  database: Database = defaultDb,
) {
  const conds = [];
  if (barberId !== null) conds.push(or(eq(barberTimeOff.barberId, barberId), isNull(barberTimeOff.barberId)));
  if (opts.from) conds.push(gte(barberTimeOff.endDatetime, opts.from));
  return database.query.barberTimeOff.findMany({
    where: conds.length ? and(...conds) : undefined,
    orderBy: [asc(barberTimeOff.startDatetime)],
    with: { barber: { columns: { id: true, name: true } } },
  });
}

export async function createTimeOff(
  barberId: number | null,
  input: TimeOffInput,
  database: Database = defaultDb,
): Promise<BarberTimeOff> {
  const startDatetime = parseLocal(input.startLocal, 'startLocal');
  const endDatetime = parseLocal(input.endLocal, 'endLocal');
  if (startDatetime >= endDatetime) {
    throw new PanelError(422, 'INVALID_RANGE', 'El fin debe ser posterior al inicio.');
  }
  const [row] = await database
    .insert(barberTimeOff)
    .values({ barberId, startDatetime, endDatetime, reason: input.reason?.trim() || null })
    .returning();
  return row;
}

export async function deleteTimeOff(user: SessionUser, id: number, database: Database = defaultDb) {
  const row = await database.query.barberTimeOff.findFirst({ where: eq(barberTimeOff.id, id) });
  if (!row) throw new PanelError(404, 'NOT_FOUND', 'Bloqueo no encontrado.');
  // Un barbero no puede borrar bloqueos globales (barberId null) ni ajenos.
  assertCanAccessBarber(user, row.barberId);
  await database.delete(barberTimeOff).where(eq(barberTimeOff.id, id));
}

// ---------------------------------------------------------------------------
// Citas
// ---------------------------------------------------------------------------
export const PANEL_STATUSES = ['confirmed', 'cancelled', 'completed', 'no_show'] as const;
export type PanelStatus = (typeof PANEL_STATUSES)[number];

export const STATUS_LABELS: Record<AppointmentStatus, string> = {
  pending: 'Pendiente',
  confirmed: 'Confirmada',
  cancelled: 'Cancelada',
  completed: 'Completada',
  no_show: 'No asistió',
};

export interface AppointmentFilters {
  /** null = todos (solo admin). */
  barberId: number | null;
  status?: AppointmentStatus;
  /** Fecha local YYYY-MM-DD (inclusive). */
  from?: string;
  to?: string;
  limit?: number;
}

export function listAppointments(filters: AppointmentFilters, database: Database = defaultDb) {
  const conds = [];
  if (filters.barberId !== null) conds.push(eq(appointments.barberId, filters.barberId));
  if (filters.status) conds.push(eq(appointments.status, filters.status));
  if (filters.from) {
    if (!isValidDateString(filters.from)) throw new PanelError(400, 'INVALID_DATE', 'from inválido.');
    conds.push(gte(appointments.startDatetime, bogotaToUtc(filters.from, '00:00')));
  }
  if (filters.to) {
    if (!isValidDateString(filters.to)) throw new PanelError(400, 'INVALID_DATE', 'to inválido.');
    conds.push(lte(appointments.startDatetime, bogotaToUtc(filters.to, '23:59')));
  }
  return database.query.appointments.findMany({
    where: conds.length ? and(...conds) : undefined,
    orderBy: [asc(appointments.startDatetime)],
    limit: filters.limit ?? 500,
    with: {
      barber: { columns: { id: true, name: true } },
      service: { columns: { id: true, name: true } },
    },
  });
}

export async function updateAppointmentStatus(
  user: SessionUser,
  id: number,
  status: PanelStatus,
  reason?: string | null,
  database: Database = defaultDb,
) {
  if (!PANEL_STATUSES.includes(status)) {
    throw new PanelError(422, 'INVALID_STATUS', 'Estado inválido.');
  }
  const row = await database.query.appointments.findFirst({ where: eq(appointments.id, id) });
  if (!row) throw new PanelError(404, 'NOT_FOUND', 'Cita no encontrada.');
  assertCanAccessBarber(user, row.barberId);

  try {
    await database
      .update(appointments)
      .set({
        status,
        cancellationReason: status === 'cancelled' ? (reason?.trim() || row.cancellationReason) : row.cancellationReason,
      })
      .where(eq(appointments.id, id));
  } catch (err) {
    // Reactivar una cita cancelada cuyo horario ya fue tomado por otra.
    if (isUniqueViolation(err)) {
      throw new PanelError(409, 'SLOT_TAKEN', 'Ese horario ya tiene otra cita activa.');
    }
    throw err;
  }
  const updated = await database.query.appointments.findFirst({
    where: eq(appointments.id, id),
    with: {
      barber: { columns: { id: true, name: true } },
      service: { columns: { id: true, name: true } },
    },
  });

  // Cancelada desde el panel (barbero o admin): avisar al dueño y al cliente.
  if (status === 'cancelled' && row.status !== 'cancelled' && updated?.barber && updated.service) {
    await sendCancellationNotice(updated, updated.barber, updated.service, user.role);
  }

  return updated;
}

/** Conteos rápidos para el dashboard. */
export async function countAppointmentsByStatus(barberId: number | null, database: Database = defaultDb) {
  const rows = await database
    .select({ status: appointments.status, count: sql<number>`count(*)` })
    .from(appointments)
    .where(barberId === null ? undefined : eq(appointments.barberId, barberId))
    .groupBy(appointments.status);
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)])) as Partial<Record<AppointmentStatus, number>>;
}
