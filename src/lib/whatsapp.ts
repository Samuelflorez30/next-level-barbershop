/**
 * Armado de enlaces y mensajes de WhatsApp.
 *
 * Este módulo se usa tanto en el servidor (Astro) como en el navegador
 * (BookingWidget), así que solo depende de APIs estándar (Intl, URL).
 */

export const BOGOTA_TIMEZONE = 'America/Bogota';

/** Enlace wa.me con el texto ya codificado (misma lógica que usaba el modal). */
export function buildWhatsAppUrl(phone: string, text: string): string {
  const digits = phone.replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/** Mensaje que enviaba el modal antiguo al elegir barbero (sin cita en la DB). */
export function buildServiceInquiryMessage(serviceName: string): string {
  return `Hola, deseo agendar el servicio de ${serviceName} contigo.`;
}

/** "miércoles, 14 de octubre de 2026" en hora de Bogotá. */
export function formatBogotaDate(date: Date): string {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: BOGOTA_TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

/** "10:00 a. m." en hora de Bogotá. */
export function formatBogotaTime(date: Date): string {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: BOGOTA_TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

export function formatBogotaDateTime(date: Date): string {
  return `${formatBogotaDate(date)}, ${formatBogotaTime(date)}`;
}

/** Nombre de pila para saludar ("Oswar Avendaño" → "Oswar"). */
function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

export interface AppointmentMessageInput {
  barberName: string;
  serviceName: string;
  /** Inicio de la cita (UTC). */
  startDatetime: Date;
  clientName: string;
  confirmationToken: string;
}

/**
 * Resumen legible de una cita ya creada, para que el cliente la confirme
 * con el barbero por WhatsApp.
 */
export function buildAppointmentConfirmationMessage({
  barberName,
  serviceName,
  startDatetime,
  clientName,
  confirmationToken,
}: AppointmentMessageInput): string {
  return [
    `Hola ${firstName(barberName)}, soy ${clientName.trim()}.`,
    // formatBogotaTime termina en "a. m."/"p. m.", que ya cierra la frase.
    `Acabo de reservar *${serviceName}* para el ${formatBogotaDate(startDatetime)} a las ${formatBogotaTime(startDatetime)}`,
    `Código de reserva: ${confirmationToken.slice(0, 8).toUpperCase()}`,
  ].join('\n');
}
