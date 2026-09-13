import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, lt } from 'drizzle-orm';
import { db as defaultDb, type Database } from '../db/client';
import { appointments, type Appointment } from '../db/schema';
import {
  BLOCKING_STATUSES,
  computeAvailableSlots,
  generateCandidateSlots,
  getSchedulesForDate,
  resolveBookingContext,
} from './availability';
import { addMinutes, utcToBogota } from './time';

export interface CreateAppointmentInput {
  barberId: number;
  serviceId: number;
  /** Inicio en UTC. */
  startDatetime: Date;
  clientName: string;
  clientPhone: string;
  clientEmail?: string | null;
  clientNote?: string | null;
}

export type CreateAppointmentResult =
  | { ok: true; appointment: Appointment }
  | { ok: false; status: 404 | 409 | 422; code: string; message: string };

// ---------------------------------------------------------------------------
// Lock en proceso: serializa las reservas dentro de una misma instancia para
// que dos solicitudes simultáneas no abran transacciones de escritura a la
// vez (en SQLite local el segundo BEGIN IMMEDIATE bloquearía el hilo).
// Entre instancias distintas protege la transacción + el índice único parcial
// `appointments_barber_start_active_uq`.
// ---------------------------------------------------------------------------
let bookingQueue: Promise<unknown> = Promise.resolve();

function withBookingLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = bookingQueue.then(fn, fn);
  bookingQueue = run.catch(() => undefined);
  return run;
}

class SlotTakenError extends Error {}

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(msg);
}

/**
 * Crea una cita validando todo en el servidor:
 * - barbero/servicio activos y ofrecidos → duración y precio efectivos
 * - el inicio coincide con un slot del horario (alineado a la hora)
 * - no hay bloqueos ni citas activas solapadas (con buffer)
 * - dentro de una transacción se re-verifica el solape antes de insertar
 */
export async function createAppointment(
  input: CreateAppointmentInput,
  database: Database = defaultDb,
): Promise<CreateAppointmentResult> {
  const ctx = await resolveBookingContext(input.barberId, input.serviceId, database);
  if (!ctx) {
    return {
      ok: false,
      status: 404,
      code: 'BARBER_OR_SERVICE_NOT_FOUND',
      message: 'El barbero o el servicio no existen, están inactivos o no se ofrecen juntos.',
    };
  }

  const start = input.startDatetime;
  const end = addMinutes(start, ctx.durationMinutes);
  const { date } = utcToBogota(start);

  // ¿Es un slot válido del horario (independiente de ocupación)?
  const schedules = await getSchedulesForDate(input.barberId, date, database);
  const candidates = generateCandidateSlots(schedules, date, ctx.durationMinutes);
  const startMs = start.getTime();
  if (!candidates.some((s) => s.start.getTime() === startMs)) {
    return {
      ok: false,
      status: 422,
      code: 'SLOT_OUTSIDE_SCHEDULE',
      message: 'La hora solicitada no corresponde a un turno válido del horario del barbero.',
    };
  }

  // ¿Sigue disponible (citas + bloqueos)? Chequeo rápido antes de la transacción.
  const available = await computeAvailableSlots(
    { barberId: input.barberId, serviceId: input.serviceId, date },
    database,
  );
  if (!available.some((s) => s.start.getTime() === startMs)) {
    return slotTaken();
  }

  const buffer = ctx.barber.bufferMinutes;

  try {
    const appointment = await withBookingLock(() =>
      database.transaction(async (tx) => {
        // Re-validación dentro de la transacción (BEGIN IMMEDIATE).
        const clash = await tx.query.appointments.findFirst({
          columns: { id: true },
          where: and(
            eq(appointments.barberId, input.barberId),
            inArray(appointments.status, [...BLOCKING_STATUSES]),
            gt(appointments.endDatetime, addMinutes(start, -buffer)),
            lt(appointments.startDatetime, addMinutes(end, buffer)),
          ),
        });
        if (clash) throw new SlotTakenError();

        const [row] = await tx
          .insert(appointments)
          .values({
            barberId: input.barberId,
            serviceId: input.serviceId,
            clientName: input.clientName,
            clientPhone: input.clientPhone,
            clientEmail: input.clientEmail ?? null,
            clientNote: input.clientNote ?? null,
            startDatetime: start,
            endDatetime: end,
            price: ctx.price,
            status: 'confirmed',
            confirmationToken: randomUUID(),
          })
          .returning();
        return row;
      }),
    );
    return { ok: true, appointment };
  } catch (err) {
    if (err instanceof SlotTakenError || isUniqueViolation(err)) return slotTaken();
    throw err;
  }
}

function slotTaken(): CreateAppointmentResult {
  return {
    ok: false,
    status: 409,
    code: 'SLOT_TAKEN',
    message: 'Ese horario ya no está disponible. Elige otro.',
  };
}

// ---------------------------------------------------------------------------
// Consulta / cancelación por token (sin login)
// ---------------------------------------------------------------------------

export type AppointmentView = Appointment & {
  barber: { id: number; name: string; slug: string; phoneWhatsapp: string } | null;
  service: { id: number; name: string; slug: string } | null;
};

export async function getAppointmentByToken(
  token: string,
  database: Database = defaultDb,
): Promise<AppointmentView | null> {
  const row = await database.query.appointments.findFirst({
    where: eq(appointments.confirmationToken, token),
    with: {
      barber: { columns: { id: true, name: true, slug: true, phoneWhatsapp: true } },
      service: { columns: { id: true, name: true, slug: true } },
    },
  });
  return row ?? null;
}

export type CancelAppointmentResult =
  | { ok: true; appointment: AppointmentView; alreadyCancelled: boolean }
  | { ok: false; status: 404 | 422; code: string; message: string };

export async function cancelAppointmentByToken(
  token: string,
  reason: string | null | undefined,
  database: Database = defaultDb,
): Promise<CancelAppointmentResult> {
  const current = await getAppointmentByToken(token, database);
  if (!current) {
    return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Cita no encontrada.' };
  }
  if (current.status === 'cancelled') {
    return { ok: true, appointment: current, alreadyCancelled: true };
  }
  if (current.status === 'completed' || current.status === 'no_show') {
    return {
      ok: false,
      status: 422,
      code: 'NOT_CANCELLABLE',
      message: `No se puede cancelar una cita en estado "${current.status}".`,
    };
  }

  await database
    .update(appointments)
    .set({ status: 'cancelled', cancellationReason: reason ?? null })
    .where(eq(appointments.id, current.id));

  const updated = await getAppointmentByToken(token, database);
  return { ok: true, appointment: updated!, alreadyCancelled: false };
}
