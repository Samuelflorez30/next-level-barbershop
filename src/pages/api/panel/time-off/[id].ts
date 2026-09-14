import type { APIRoute } from 'astro';
import { json } from '../../../../lib/api';
import { deleteTimeOff } from '../../../../lib/panel';
import { requireIdParam, requireUser, withPanel } from '../../../../lib/panel-api';

/** DELETE /api/panel/time-off/:id */
export const DELETE: APIRoute = ({ locals, params }) =>
  withPanel(async () => {
    const user = requireUser(locals);
    await deleteTimeOff(user, requireIdParam(params));
    return json({ ok: true });
  });
