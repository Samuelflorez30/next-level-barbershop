import type { APIRoute } from 'astro';
import { json } from '../../../lib/api';
import { listAppointments, resolveBarberScope, PanelError } from '../../../lib/panel';
import { optionalId, requireUser, withPanel } from '../../../lib/panel-api';
import { APPOINTMENT_STATUSES, type AppointmentStatus } from '../../../db/schema';

/**
 * GET /api/panel/appointments?barberId=&status=&from=YYYY-MM-DD&to=YYYY-MM-DD
 * barber → solo sus citas (barberId se ignora). admin → todas o las del barbero indicado.
 */
export const GET: APIRoute = ({ locals, url }) =>
  withPanel(async () => {
    const user = requireUser(locals);
    const requested = optionalId(url.searchParams.get('barberId') ?? undefined);
    const barberId = await resolveBarberScope(user, requested ?? null, { allowGlobal: true });

    const statusParam = url.searchParams.get('status') ?? undefined;
    if (statusParam && !APPOINTMENT_STATUSES.includes(statusParam as AppointmentStatus)) {
      throw new PanelError(400, 'INVALID_STATUS', 'status inválido.');
    }

    const rows = await listAppointments({
      barberId,
      status: statusParam as AppointmentStatus | undefined,
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
    });
    return json({ appointments: rows });
  });
