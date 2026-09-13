/**
 * Utilidades de tiempo para la zona horaria fija del negocio.
 *
 * Colombia (America/Bogota) es UTC-5 todo el año, sin horario de verano, así
 * que la conversión entre hora local y UTC es un desplazamiento constante.
 * Los horarios de atención se guardan como "HH:MM" locales; las citas y
 * bloqueos se guardan como timestamps UTC.
 */

export const BOGOTA_UTC_OFFSET_HOURS = -5;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

/** Valida "YYYY-MM-DD" (fecha real de calendario). */
export function isValidDateString(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === mo - 1 &&
    probe.getUTCDate() === d
  );
}

/** Valida "HH:MM" en formato 24h. */
export function isValidTimeString(value: string): boolean {
  const m = TIME_RE.exec(value);
  if (!m) return false;
  const [h, min] = [Number(m[1]), Number(m[2])];
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

function parseDate(date: string): [number, number, number] {
  if (!isValidDateString(date)) throw new Error(`Fecha inválida: ${date}`);
  const [y, m, d] = date.split('-').map(Number);
  return [y, m, d];
}

function parseTime(time: string): [number, number] {
  if (!isValidTimeString(time)) throw new Error(`Hora inválida: ${time}`);
  const [h, min] = time.split(':').map(Number);
  return [h, min];
}

/** Convierte fecha + hora local de Bogotá a un instante UTC. */
export function bogotaToUtc(date: string, time: string): Date {
  const [y, m, d] = parseDate(date);
  const [h, min] = parseTime(time);
  return new Date(Date.UTC(y, m - 1, d, h - BOGOTA_UTC_OFFSET_HOURS, min));
}

/** Descompone un instante UTC en fecha y hora local de Bogotá. */
export function utcToBogota(instant: Date): { date: string; time: string } {
  const shifted = new Date(instant.getTime() + BOGOTA_UTC_OFFSET_HOURS * HOUR_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    time: `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`,
  };
}

/** Día de la semana de una fecha local: 0 = lunes … 6 = domingo. */
export function bogotaDayOfWeek(date: string): number {
  const [y, m, d] = parseDate(date);
  // getUTCDay(): 0 = domingo … 6 = sábado → rotamos para que lunes sea 0.
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** Inicio (00:00 local) del día en UTC. */
export function bogotaDayStart(date: string): Date {
  return bogotaToUtc(date, '00:00');
}

export function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * MINUTE_MS);
}

/** Dos intervalos semiabiertos [aStart, aEnd) y [bStart, bEnd) se solapan. */
export function intervalsOverlap(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date,
): boolean {
  return aStart < bEnd && aEnd > bStart;
}
