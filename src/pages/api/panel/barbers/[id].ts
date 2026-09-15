import type { APIRoute } from 'astro';
import { json } from '../../../../lib/api';
import { getBarberAdmin, setBarberActive, updateBarber } from '../../../../lib/barbers-admin';
import { PanelError } from '../../../../lib/panel';
import { requireAdmin, requireIdParam, requireJson, withPanel } from '../../../../lib/panel-api';

/**
 * PATCH /api/panel/barbers/:id
 *   { name?, role?, quote?, phoneWhatsapp?, photoUrl?, serviceIds? }  → edita datos y servicios
 *   { isActive: true | false }                                        → activa / desactiva
 * Solo admin. Al desactivar se cierran las sesiones del barbero.
 */
export const PATCH: APIRoute = ({ locals, params, request }) =>
  withPanel(async () => {
    requireAdmin(locals);
    const id = requireIdParam(params);
    const { isActive, ...patch } = await requireJson(request);

    let barber = Object.keys(patch).length > 0 ? await updateBarber(id, patch) : undefined;
    if (isActive !== undefined) {
      if (typeof isActive !== 'boolean') {
        throw new PanelError(422, 'VALIDATION_ERROR', 'Revisa los campos marcados.', { isActive: ['isActive debe ser true o false.'] });
      }
      barber = await setBarberActive(id, isActive);
    }
    return json({ barber: barber ?? (await getBarberAdmin(id)) });
  });
