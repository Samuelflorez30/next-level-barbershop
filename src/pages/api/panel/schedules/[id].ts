import type { APIRoute } from 'astro';
import { json } from '../../../../lib/api';
import { deleteScheduleRange, updateScheduleRange } from '../../../../lib/panel';
import { requireIdParam, requireJson, requireUser, withPanel } from '../../../../lib/panel-api';

/** PATCH /api/panel/schedules/:id  { startTime?, endTime?, isActive? } */
export const PATCH: APIRoute = ({ locals, params, request }) =>
  withPanel(async () => {
    const user = requireUser(locals);
    const id = requireIdParam(params);
    const body = await requireJson(request);
    const patch: { startTime?: string; endTime?: string; isActive?: boolean } = {};
    if (typeof body.startTime === 'string') patch.startTime = body.startTime;
    if (typeof body.endTime === 'string') patch.endTime = body.endTime;
    if (typeof body.isActive === 'boolean') patch.isActive = body.isActive;
    const schedule = await updateScheduleRange(user, id, patch);
    return json({ schedule });
  });

/** DELETE /api/panel/schedules/:id */
export const DELETE: APIRoute = ({ locals, params }) =>
  withPanel(async () => {
    const user = requireUser(locals);
    await deleteScheduleRange(user, requireIdParam(params));
    return json({ ok: true });
  });
