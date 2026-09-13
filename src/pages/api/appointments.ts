import type { APIRoute } from 'astro';
import { z } from 'astro/zod';
import { apiError, json, readJson } from '../../lib/api';
import { createAppointment } from '../../lib/appointments';

const bodySchema = z.object({
  barberId: z.number().int().positive(),
  serviceId: z.number().int().positive(),
  /** ISO 8601 (UTC o con offset). */
  startDatetime: z
    .string()
    .min(1)
    .refine((v) => !Number.isNaN(Date.parse(v)), 'startDatetime debe ser una fecha ISO 8601 válida.'),
  clientName: z.string().trim().min(2).max(120),
  clientPhone: z
    .string()
    .trim()
    .regex(/^\+?\d{7,15}$/, 'clientPhone debe contener solo dígitos (7 a 15), opcionalmente con +.'),
  clientEmail: z.string().trim().email().max(254).nullish(),
  clientNote: z.string().trim().max(500).nullish(),
});

/**
 * POST /api/appointments
 * Crea una cita. Duración y precio se calculan en el servidor; el slot se
 * re-valida dentro de una transacción (409 si ya está ocupado).
 */
export const POST: APIRoute = async ({ request }) => {
  const raw = await readJson(request);
  if (raw === null) {
    return apiError(400, 'INVALID_JSON', 'El body debe ser JSON válido.');
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return apiError(400, 'VALIDATION_ERROR', 'Datos inválidos.', parsed.error.flatten().fieldErrors);
  }
  const body = parsed.data;

  const result = await createAppointment({
    barberId: body.barberId,
    serviceId: body.serviceId,
    startDatetime: new Date(body.startDatetime),
    clientName: body.clientName,
    clientPhone: body.clientPhone,
    clientEmail: body.clientEmail ?? null,
    clientNote: body.clientNote ?? null,
  });

  if (!result.ok) {
    return apiError(result.status, result.code, result.message);
  }

  const a = result.appointment;
  return json(
    {
      id: a.id,
      confirmationToken: a.confirmationToken,
      status: a.status,
      barberId: a.barberId,
      serviceId: a.serviceId,
      startDatetime: a.startDatetime,
      endDatetime: a.endDatetime,
      price: a.price,
      clientName: a.clientName,
      clientPhone: a.clientPhone,
      clientEmail: a.clientEmail,
      clientNote: a.clientNote,
      createdAt: a.createdAt,
    },
    201,
  );
};
