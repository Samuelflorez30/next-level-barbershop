import { defineMiddleware } from 'astro:middleware';
import { SESSION_COOKIE, clearSessionCookie, setSessionCookie, validateSession } from './lib/auth';

const PANEL_PREFIX = '/panel';
const PANEL_API_PREFIX = '/api/panel';

/**
 * - Resuelve la sesión de la cookie y expone `locals.user` (role, barberId).
 * - /panel/**: sin sesión → redirige a /login?next=…
 * - /api/panel/**: sin sesión → 401 JSON.
 * - /login con sesión → redirige a /panel.
 */
export const onRequest = defineMiddleware(async ({ cookies, locals, url, redirect }, next) => {
  locals.user = null;
  locals.sessionToken = null;

  const token = cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    const result = await validateSession(token);
    if (result) {
      locals.user = result.user;
      locals.sessionToken = token;
      // Mantiene la cookie alineada con la expiración (renovación deslizante).
      setSessionCookie(cookies, token, result.session.expiresAt);
    } else {
      clearSessionCookie(cookies);
    }
  }

  const { pathname } = url;
  const isPanelPage = pathname === PANEL_PREFIX || pathname.startsWith(`${PANEL_PREFIX}/`);
  const isPanelApi = pathname.startsWith(`${PANEL_API_PREFIX}/`) || pathname === PANEL_API_PREFIX;

  if (!locals.user) {
    if (isPanelPage) {
      const next = encodeURIComponent(pathname + url.search);
      return redirect(`/login?next=${next}`, 302);
    }
    if (isPanelApi) {
      return new Response(
        JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Inicia sesión.' } }),
        { status: 401, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
      );
    }
  } else if (pathname === '/login') {
    return redirect(PANEL_PREFIX, 302);
  }

  return next();
});
