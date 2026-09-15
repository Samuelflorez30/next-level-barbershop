import type { APIRoute } from 'astro';
import { json } from '../../../../lib/api';
import { changePassword } from '../../../../lib/auth';
import { MIN_PASSWORD_LENGTH } from '../../../../lib/password';
import { PanelError } from '../../../../lib/panel';
import { requireJson, requireUser, withPanel } from '../../../../lib/panel-api';

/**
 * POST /api/panel/account/password  { currentPassword, newPassword, confirmPassword }
 * Cambia la contraseña del usuario de la sesión (admin o barbero). Verifica
 * la actual; al cambiarla cierra las demás sesiones y conserva la actual.
 */
export const POST: APIRoute = ({ locals, request }) =>
  withPanel(async () => {
    const user = requireUser(locals);
    const body = await requireJson(request);
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    const confirmPassword = typeof body.confirmPassword === 'string' ? body.confirmPassword : '';

    const fieldErrors: Record<string, string[]> = {};
    if (!currentPassword) fieldErrors.currentPassword = ['Escribe tu contraseña actual.'];
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      fieldErrors.newPassword = [`La contraseña nueva debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`];
    } else if (newPassword === currentPassword) {
      fieldErrors.newPassword = ['La contraseña nueva debe ser distinta de la actual.'];
    }
    if (confirmPassword !== newPassword) fieldErrors.confirmPassword = ['Las contraseñas no coinciden.'];
    if (Object.keys(fieldErrors).length > 0) {
      throw new PanelError(422, 'VALIDATION_ERROR', 'Revisa los campos marcados.', fieldErrors);
    }

    const result = await changePassword(user.id, currentPassword, newPassword, locals.sessionToken);
    if (!result.ok) {
      if (result.code === 'WRONG_PASSWORD') {
        throw new PanelError(422, 'VALIDATION_ERROR', 'Revisa los campos marcados.', {
          currentPassword: ['La contraseña actual no es correcta.'],
        });
      }
      throw new PanelError(404, 'USER_NOT_FOUND', 'Usuario no encontrado.');
    }
    return json({ ok: true });
  });
