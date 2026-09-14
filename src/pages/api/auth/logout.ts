import type { APIRoute } from 'astro';
import { json } from '../../../lib/api';
import { clearSessionCookie, invalidateSession } from '../../../lib/auth';

/** POST /api/auth/logout — invalida la sesión y borra la cookie. */
export const POST: APIRoute = async ({ locals, cookies, request }) => {
  if (locals.sessionToken) await invalidateSession(locals.sessionToken);
  clearSessionCookie(cookies);

  const accept = request.headers.get('accept') ?? '';
  if (accept.includes('application/json')) return json({ ok: true });
  return new Response(null, { status: 303, headers: { Location: '/login' } });
};
