/**
 * Paleta única de estados de cita para el panel. La usan StatusBadge.astro,
 * el Resumen del dashboard y la etiqueta "Próxima" de la tabla de citas.
 */
import type { AppointmentStatus } from '../../db/schema';

/** Clases base de una etiqueta (badge) del panel. */
export const BADGE_BASE =
  'inline-flex items-center gap-1.5 border rounded-full px-2.5 py-0.5 text-[11px] font-bold tracking-wider uppercase leading-5 whitespace-nowrap';

/** Borde + texto de cada estado. */
export const STATUS_BADGE: Record<AppointmentStatus, string> = {
  pending: 'border-zinc-500/40 text-zinc-300',
  confirmed: 'border-[#D4AF37]/50 text-[#D4AF37]',
  completed: 'border-emerald-500/40 text-emerald-300',
  cancelled: 'border-red-500/40 text-red-300',
  no_show: 'border-orange-500/40 text-orange-300',
};

/** Color de relleno (punto indicador) de cada estado, misma paleta. */
export const STATUS_DOT: Record<AppointmentStatus, string> = {
  pending: 'bg-zinc-400',
  confirmed: 'bg-[#D4AF37]',
  completed: 'bg-emerald-400',
  cancelled: 'bg-red-400',
  no_show: 'bg-orange-400',
};

/** La "próxima cita" usa el mismo tratamiento que una cita confirmada. */
export const NEXT_BADGE = STATUS_BADGE.confirmed;
