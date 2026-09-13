import type { APIRoute } from 'astro';
import { z } from 'astro/zod';
import { apiError, json, readJson } from '../../../lib/api';
import { cancelAppointmentByToken, getAppointmentByToken } from '../../../lib/appointments';

const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const patchSchema = z.object({
  action: z.literal('cancel'),
  reason: z.string().trim().max(500).nullish(),
});

function validToken(token: string | undefined): string | null {
  return token && TOKEN_RE.test(token) ? token : null;
}

/** GET /api/appointments/:token — detalle de la cita para el cliente (sin login). */
export const GET: APIRoute = async ({ params }) => {
  const token = validToken(params.token);
  if (!token) return apiError(404, 'NOT_FOUND', 'Cita no encontrada.');

  const appointment = await getAppointmentByToken(token);
  if (!appointment) return apiError(404, 'NOT_FOUND', 'Cita no encontrada.');

  return json({ appointment });
};

/** PATCH /api/appointments/:token  body: { action: 'cancel', reason? } */
export const PATCH: APIRoute = async ({ params, request }) => {
  const token = validToken(params.token);
  if (!token) return apiError(404, 'NOT_FOUND', 'Cita no encontrada.');

  const raw = await readJson(request);
  if (raw === null) return apiError(400, 'INVALID_JSON', 'El body debe ser JSON válido.');

  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) {
    return apiError(400, 'VALIDATION_ERROR', 'Datos inválidos.', parsed.error.flatten().fieldErrors);
  }

  const result = await cancelAppointmentByToken(token, parsed.data.reason);
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return json({ appointment: result.appointment, alreadyCancelled: result.alreadyCancelled });
};
