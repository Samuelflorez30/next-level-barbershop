/**
 * Derivación de usuario, slug e iniciales a partir del nombre de un barbero.
 *
 * Funciones puras sin dependencias de Node: se usan en el servidor
 * (src/lib/barbers-admin.ts) y en el navegador (formulario de alta), así
 * el usuario sugerido en pantalla es exactamente el que se crea.
 */

/** "Pérez Muñoz" → "Perez Munoz". */
export function stripAccents(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** "Carlos Pérez" → ["carlos", "perez"] (solo letras y números). */
function nameTokens(name: string): string[] {
  return stripAccents(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

const FALLBACK = 'barbero';

/** "Carlos Pérez" → "carlosperez". */
export function usernameFromName(name: string): string {
  return nameTokens(name).join('') || FALLBACK;
}

/** "Carlos Pérez" → "carlos-perez". */
export function slugFromName(name: string): string {
  return nameTokens(name).join('-') || FALLBACK;
}

/**
 * Devuelve `base` si está libre; si no, "base2", "base3", … hasta encontrar
 * uno libre. Misma regla para usuarios y slugs.
 */
export function withUniqueSuffix(base: string, isTaken: (candidate: string) => boolean): string {
  if (!isTaken(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`;
    if (!isTaken(candidate)) return candidate;
  }
}

/** Solo letras minúsculas y números, sin espacios, 2 a 40 caracteres. */
export const USERNAME_PATTERN = /^[a-z0-9]{2,40}$/;

/** "Oswar Avendaño" → "OA"; "Stiven" → "S". Para el avatar sin foto. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}
