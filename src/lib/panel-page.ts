/** Contexto común de las páginas /panel/*: usuario, barbero seleccionado y lista para el admin. */
import type { AstroGlobal } from 'astro';
import type { SessionUser } from './auth';
import { listBarbersForPanel } from './panel';

export interface PanelBarber {
  id: number;
  name: string;
  slug: string;
  role: string;
  photoUrl: string | null;
  isActive: boolean;
}

export interface PanelContext {
  user: SessionUser;
  /** Todos los barberos (solo para el selector del admin; vacío para barberos). */
  barbers: PanelBarber[];
  /** Barbero sobre el que se está viendo/editando. */
  selected: PanelBarber;
  /** Construye un enlace del panel conservando `?barberId=` cuando es admin. */
  href: (path: string, extra?: Record<string, string>) => string;
}

/**
 * - barber → su propio barbero (se ignora `?barberId=`).
 * - admin  → `?barberId=` o el primero de la lista.
 * Devuelve una Response de redirección si el contexto no es válido.
 */
export async function getPanelContext(Astro: AstroGlobal): Promise<PanelContext | Response> {
  const user = Astro.locals.user;
  if (!user) return Astro.redirect('/login');

  const all = await listBarbersForPanel();

  let selected: PanelBarber | undefined;
  let barbers: PanelBarber[] = [];

  if (user.role === 'barber') {
    selected = all.find((b) => b.id === user.barberId);
    if (!selected) {
      return new Response('Tu usuario no está vinculado a ningún barbero. Contacta al administrador.', {
        status: 403,
      });
    }
  } else {
    barbers = all;
    const requested = Number(Astro.url.searchParams.get('barberId'));
    selected = all.find((b) => b.id === requested) ?? all[0];
    if (!selected) return new Response('No hay barberos registrados.', { status: 404 });
  }

  const href = (path: string, extra: Record<string, string> = {}) => {
    const params = new URLSearchParams(extra);
    if (user.role === 'admin') params.set('barberId', String(selected!.id));
    const qs = params.toString();
    return qs ? `${path}?${qs}` : path;
  };

  return { user, barbers, selected, href };
}

/**
 * Igual que `getPanelContext`, pero solo para el admin (gestión de barberos):
 * un usuario con rol barbero es redirigido a /panel.
 */
export async function getAdminPanelContext(Astro: AstroGlobal): Promise<PanelContext | Response> {
  const user = Astro.locals.user;
  if (user && user.role !== 'admin') return Astro.redirect('/panel');
  return getPanelContext(Astro);
}
