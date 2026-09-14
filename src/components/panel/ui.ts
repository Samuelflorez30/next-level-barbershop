/**
 * Clases compartidas del panel (Astro + Tailwind). Un solo lugar para el
 * tratamiento de inputs, labels, botones y tarjetas, para que /panel,
 * /panel/horario y /panel/dias-libres se vean iguales.
 */
export const focusRing =
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-[#D4AF37]/70 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950';

/** Input sin ancho (para usar en línea, p. ej. rangos de hora). */
export const inputBase = `bg-zinc-950 border border-white/10 rounded-md px-3 py-2.5 text-sm text-white placeholder:text-zinc-600 transition-colors hover:border-white/20 focus:border-[#D4AF37] [color-scheme:dark] ${focusRing}`;

export const input = `w-full ${inputBase}`;

export const select = `bg-zinc-950 border border-white/10 rounded-md px-3 py-2 text-sm text-white transition-colors hover:border-white/20 focus:border-[#D4AF37] ${focusRing}`;

export const label = 'block text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-1.5';

export const checkbox = `w-4 h-4 rounded accent-[#D4AF37] ${focusRing}`;

export const btnPrimary = `inline-flex items-center justify-center gap-2 px-6 py-2.5 bg-[#D4AF37] text-black font-bold text-xs tracking-widest uppercase rounded-sm transition-colors hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-[#D4AF37] ${focusRing}`;

export const btnSecondary = `inline-flex items-center justify-center gap-2 px-4 py-2.5 border border-white/10 text-zinc-300 font-bold text-xs tracking-widest uppercase rounded-sm transition-colors hover:border-[#D4AF37] hover:text-[#D4AF37] disabled:opacity-50 ${focusRing}`;

export const btnDanger = `inline-flex items-center justify-center gap-2 px-4 py-2.5 border border-red-400/40 text-red-200 font-bold text-xs tracking-widest uppercase rounded-sm transition-colors hover:bg-red-500/10 hover:border-red-400 disabled:opacity-50 ${focusRing}`;

export const link = `text-[11px] font-bold uppercase tracking-widest text-zinc-400 transition-colors hover:text-[#D4AF37] rounded-sm ${focusRing}`;

export const card = 'bg-zinc-900/50 border border-white/10 rounded-2xl p-5 sm:p-6';

export const h2 = 'font-serif text-lg font-bold text-[#D4AF37] tracking-widest uppercase';

export const eyebrow = 'text-[10px] font-bold uppercase tracking-widest text-zinc-500';
