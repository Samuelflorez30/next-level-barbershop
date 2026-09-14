import type { APIRoute } from 'astro';
import { apiError, json, readJson } from '../../../lib/api';
import { authenticate, createSession, setSessionCookie } from '../../../lib/auth';

/**
 * POST /api/auth/login — acepta formulario (x-www-form-urlencoded) o JSON.
 * Campos: `username` (nombre simple o email, sin validar formato) y `password`.
 * Formulario: redirige (303) a `next` o /panel; si falla, a /login?error=….
 * JSON: 200 { user } o 401.
 */
export const POST: APIRoute = async ({ request, cookies }) => {
  const contentType = request.headers.get('content-type') ?? '';
  const isForm = contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data');

  let username = '';
  let password = '';
  let next = '/panel';

  if (isForm) {
    const form = await request.formData();
    username = String(form.get('username') ?? '');
    password = String(form.get('password') ?? '');
    next = safeNext(String(form.get('next') ?? ''));
  } else {
    const body = (await readJson(request)) as Record<string, unknown> | null;
    username = typeof body?.username === 'string' ? body.username : '';
    password = typeof body?.password === 'string' ? body.password : '';
    next = safeNext(typeof body?.next === 'string' ? body.next : '');
  }

  if (!username || !password) {
    return isForm
      ? redirectTo(`/login?error=missing&next=${encodeURIComponent(next)}`)
      : apiError(400, 'VALIDATION_ERROR', 'Usuario y contraseña son obligatorios.');
  }

  const user = await authenticate(username, password);
  if (!user) {
    return isForm
      ? redirectTo(`/login?error=credentials&next=${encodeURIComponent(next)}`)
      : apiError(401, 'INVALID_CREDENTIALS', 'Usuario o contraseña incorrectos.');
  }

  const { token, session } = await createSession(user.id);
  setSessionCookie(cookies, token, session.expiresAt);

  return isForm
    ? redirectTo(next)
    : json({ user: { id: user.id, username: user.username, role: user.role, barberId: user.barberId } });
};

/** Solo permite rutas internas del panel como destino post-login. */
function safeNext(value: string): string {
  return value.startsWith('/panel') && !value.startsWith('//') ? value : '/panel';
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location } });
}
