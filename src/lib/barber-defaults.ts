/**
 * Valores por defecto de un barbero nuevo. Los usan el seed inicial
 * (src/db/seed.ts) y el alta de barberos desde el panel
 * (src/lib/barbers-admin.ts), para que ambos caminos creen lo mismo.
 */

export const DEFAULT_BARBER_ROLE = 'Master Barber';

export interface WeeklyScheduleEntry {
  /** 0 = lunes … 6 = domingo. */
  dayOfWeek: number;
  /** "HH:MM" hora local Bogotá. */
  startTime: string;
  /** "HH:MM" hora local Bogotá (hora de cierre). */
  endTime: string;
}

// Horario de atención (hora local Bogotá). Lunes a sábado 09:00–21:00;
// domingo 10:00–21:00. La última cita (20:00) se deriva de cierre − duración
// del servicio en la lógica de disponibilidad.
export const WEEKLY_SCHEDULE: readonly WeeklyScheduleEntry[] = [
  { dayOfWeek: 0, startTime: '09:00', endTime: '21:00' }, // lunes
  { dayOfWeek: 1, startTime: '09:00', endTime: '21:00' }, // martes
  { dayOfWeek: 2, startTime: '09:00', endTime: '21:00' }, // miércoles
  { dayOfWeek: 3, startTime: '09:00', endTime: '21:00' }, // jueves
  { dayOfWeek: 4, startTime: '09:00', endTime: '21:00' }, // viernes
  { dayOfWeek: 5, startTime: '09:00', endTime: '21:00' }, // sábado
  { dayOfWeek: 6, startTime: '10:00', endTime: '21:00' }, // domingo
];
