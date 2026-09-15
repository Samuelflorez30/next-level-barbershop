import type { APIRoute } from 'astro';
import { json } from '../../../../lib/api';
import { createBarber, listBarbersAdmin } from '../../../../lib/barbers-admin';
import { requireAdmin, requireJson, withPanel } from '../../../../lib/panel-api';

/** GET /api/panel/barbers — todos los barberos (activos e inactivos) con conteo de servicios. Solo admin. */
export const GET: APIRoute = ({ locals }) =>
  withPanel(async () => {
    requireAdmin(locals);
    return json({ barbers: await listBarbersAdmin() });
  });

/**
 * POST /api/panel/barbers  { name, phoneWhatsapp, role?, quote?, photoUrl?, serviceIds?, username? }
 * Crea barbero + servicios + horario por defecto + usuario del panel en una
 * transacción. Devuelve { barber, credentials: { username, password } }; la
 * contraseña temporal solo se entrega aquí.
 */
export const POST: APIRoute = ({ locals, request }) =>
  withPanel(async () => {
    requireAdmin(locals);
    const body = await requireJson(request);
    const result = await createBarber(body);
    return json(result, 201);
  });
