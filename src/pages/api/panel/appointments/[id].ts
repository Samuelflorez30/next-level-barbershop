import type { APIRoute } from 'astro';
import { json } from '../../../../lib/api';
import { PANEL_STATUSES, updateAppointmentStatus, PanelError, type PanelStatus } from '../../../../lib/panel';
import { requireIdParam, requireJson, requireUser, withPanel } from '../../../../lib/panel-api';

/** PATCH /api/panel/appointments/:id  { status: 'confirmed'|'cancelled'|'completed'|'no_show', reason? } */
export const PATCH: APIRoute = ({ locals, params, request }) =>
  withPanel(async () => {
    const user = requireUser(locals);
    const id = requireIdParam(params);
    const body = await requireJson(request);
    const status = body.status;
    if (typeof status !== 'string' || !PANEL_STATUSES.includes(status as PanelStatus)) {
      throw new PanelError(422, 'INVALID_STATUS', `status debe ser uno de: ${PANEL_STATUSES.join(', ')}.`);
    }
    const reason = typeof body.reason === 'string' ? body.reason : null;
    const appointment = await updateAppointmentStatus(user, id, status as PanelStatus, reason);
    return json({ appointment });
  });
