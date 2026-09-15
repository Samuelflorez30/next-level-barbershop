import type { APIRoute } from 'astro';
import { json } from '../../../../../lib/api';
import { resetBarberPassword } from '../../../../../lib/barbers-admin';
import { requireAdmin, requireIdParam, withPanel } from '../../../../../lib/panel-api';

/**
 * POST /api/panel/barbers/:id/reset-password — rescate explícito del admin:
 * nueva contraseña temporal para ese barbero y cierre de sus sesiones.
 * Devuelve { credentials: { username, password } } (se muestra una sola vez).
 */
export const POST: APIRoute = ({ locals, params }) =>
  withPanel(async () => {
    requireAdmin(locals);
    const id = requireIdParam(params);
    return json(await resetBarberPassword(id));
  });
