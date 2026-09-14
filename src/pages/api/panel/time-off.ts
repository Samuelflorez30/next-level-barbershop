import type { APIRoute } from 'astro';
import { json } from '../../../lib/api';
import { createTimeOff, listTimeOff, resolveBarberScope } from '../../../lib/panel';
import { optionalId, requireJson, requireUser, withPanel } from '../../../lib/panel-api';

/**
 * GET /api/panel/time-off?barberId=&includePast=1
 * barber → sus bloqueos + los globales. admin sin barberId → todos.
 */
export const GET: APIRoute = ({ locals, url }) =>
  withPanel(async () => {
    const user = requireUser(locals);
    const requested = optionalId(url.searchParams.get('barberId') ?? undefined);
    const barberId = await resolveBarberScope(user, requested ?? null, { allowGlobal: true });
    const includePast = url.searchParams.get('includePast') === '1';
    const rows = await listTimeOff(barberId, includePast ? {} : { from: new Date() });
    return json({ barberId, timeOff: rows });
  });

/**
 * POST /api/panel/time-off  { barberId?, startLocal, endLocal, reason? }
 * barber → siempre el suyo. admin → el indicado, o `barberId: null` para
 * cerrar todo el negocio.
 */
export const POST: APIRoute = ({ locals, request }) =>
  withPanel(async () => {
    const user = requireUser(locals);
    const body = await requireJson(request);
    const barberId = await resolveBarberScope(user, optionalId(body.barberId), {
      allowGlobal: user.role === 'admin' && body.barberId === null,
    });
    const row = await createTimeOff(barberId, {
      startLocal: String(body.startLocal ?? ''),
      endLocal: String(body.endLocal ?? ''),
      reason: typeof body.reason === 'string' ? body.reason : null,
    });
    return json({ timeOff: row }, 201);
  });
