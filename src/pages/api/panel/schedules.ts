import type { APIRoute } from 'astro';
import { json } from '../../../lib/api';
import {
  createScheduleRange,
  getWeekSchedule,
  replaceWeekSchedule,
  resolveBarberScope,
  PanelError,
  type DayScheduleInput,
} from '../../../lib/panel';
import { optionalId, requireJson, requireUser, withPanel } from '../../../lib/panel-api';

/** GET /api/panel/schedules?barberId= — horario semanal del barbero (propio si es barber). */
export const GET: APIRoute = ({ locals, url }) =>
  withPanel(async () => {
    const user = requireUser(locals);
    const barberId = (await resolveBarberScope(user, optionalId(url.searchParams.get('barberId') ?? undefined)))!;
    return json({ barberId, schedules: await getWeekSchedule(barberId) });
  });

/** POST /api/panel/schedules  { barberId?, dayOfWeek, startTime, endTime } — agrega una franja. */
export const POST: APIRoute = ({ locals, request }) =>
  withPanel(async () => {
    const user = requireUser(locals);
    const body = await requireJson(request);
    const barberId = (await resolveBarberScope(user, optionalId(body.barberId)))!;
    const row = await createScheduleRange(barberId, {
      dayOfWeek: Number(body.dayOfWeek),
      startTime: String(body.startTime ?? ''),
      endTime: String(body.endTime ?? ''),
    });
    return json({ schedule: row }, 201);
  });

/**
 * PUT /api/panel/schedules  { barberId?, days: [{ dayOfWeek, ranges: [{ startTime, endTime }] }] }
 * Reemplaza el horario completo de la semana (los días ausentes quedan cerrados).
 */
export const PUT: APIRoute = ({ locals, request }) =>
  withPanel(async () => {
    const user = requireUser(locals);
    const body = await requireJson(request);
    const barberId = (await resolveBarberScope(user, optionalId(body.barberId)))!;
    if (!Array.isArray(body.days)) throw new PanelError(422, 'INVALID_DAYS', 'days debe ser un arreglo.');
    const days: DayScheduleInput[] = body.days.map((d: unknown) => {
      const day = (d ?? {}) as Record<string, unknown>;
      const ranges = Array.isArray(day.ranges) ? day.ranges : [];
      return {
        dayOfWeek: Number(day.dayOfWeek),
        ranges: ranges.map((r: unknown) => {
          const range = (r ?? {}) as Record<string, unknown>;
          return { startTime: String(range.startTime ?? ''), endTime: String(range.endTime ?? '') };
        }),
      };
    });
    const schedules = await replaceWeekSchedule(barberId, days);
    return json({ barberId, schedules });
  });
