/**
 * Notificaciones por email (Resend).
 *
 * Reglas:
 * - Si falta RESEND_API_KEY se registra un aviso y no se envía nada.
 * - Ninguna función lanza: cualquier error del proveedor se registra con
 *   console.error. Un problema de email NUNCA debe romper una reserva.
 * - Se llaman siempre DESPUÉS de que la transacción de la cita se confirmó.
 */
import { Resend } from 'resend';
import { formatBogotaDate, formatBogotaTime } from './whatsapp';

// ---------------------------------------------------------------------------
// Tipos mínimos (para no depender de las relaciones completas de Drizzle)
// ---------------------------------------------------------------------------
export interface NotifyAppointment {
  id: number;
  confirmationToken: string;
  clientName: string;
  clientPhone: string;
  clientEmail: string | null;
  clientNote?: string | null;
  startDatetime: Date;
  endDatetime: Date;
  /** COP enteros. */
  price: number;
  cancellationReason?: string | null;
}
export interface NotifyBarber {
  name: string;
}
export interface NotifyService {
  name: string;
}

export type CancelledBy = 'client' | 'barber' | 'admin';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

// ---------------------------------------------------------------------------
// Configuración (leída en cada llamada para que tests y runtime puedan cambiarla)
// ---------------------------------------------------------------------------
function readEnv(name: string): string | undefined {
  const fromVite = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  const value = fromVite ?? process.env[name];
  return value?.trim() || undefined;
}

export function getNotificationConfig() {
  return {
    apiKey: readEnv('RESEND_API_KEY'),
    from: readEnv('RESEND_FROM_EMAIL') ?? 'onboarding@resend.dev',
    notifyEmail: readEnv('NOTIFY_EMAIL'),
    siteUrl: (readEnv('PUBLIC_SITE_URL') ?? 'https://barbernextlevel.com').replace(/\/+$/, ''),
  };
}

let client: Resend | null = null;
let clientKey: string | undefined;
let warnedMissingKey = false;

/** Cliente Resend (singleton por API key). Null si no hay clave configurada. */
function getClient(): Resend | null {
  const { apiKey } = getNotificationConfig();
  if (!apiKey) {
    if (!warnedMissingKey) {
      console.warn('[notifications] RESEND_API_KEY no está configurado: no se enviarán emails.');
      warnedMissingKey = true;
    }
    return null;
  }
  if (!client || clientKey !== apiKey) {
    client = new Resend(apiKey);
    clientKey = apiKey;
  }
  return client;
}

/** Solo para tests: olvida el cliente cacheado y el aviso de clave faltante. */
export function resetNotificationsForTests() {
  client = null;
  clientKey = undefined;
  warnedMissingKey = false;
}

// ---------------------------------------------------------------------------
// Armado de mensajes (puro, testeable)
// ---------------------------------------------------------------------------
const cop = new Intl.NumberFormat('es-CO');
const formatPrice = (value: number) => `$${cop.format(value)}`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function appointmentUrl(token: string, siteUrl = getNotificationConfig().siteUrl): string {
  return `${siteUrl}/citas/${token}`;
}

interface Row {
  label: string;
  value: string;
}

function appointmentRows(a: NotifyAppointment, barber: NotifyBarber, service: NotifyService): Row[] {
  const rows: Row[] = [
    { label: 'Servicio', value: service.name },
    { label: 'Barbero', value: barber.name },
    { label: 'Fecha', value: formatBogotaDate(a.startDatetime) },
    { label: 'Hora', value: `${formatBogotaTime(a.startDatetime)} – ${formatBogotaTime(a.endDatetime)}` },
    { label: 'Precio', value: formatPrice(a.price) },
    { label: 'Cliente', value: a.clientName },
    { label: 'Teléfono', value: a.clientPhone },
  ];
  if (a.clientEmail) rows.push({ label: 'Correo', value: a.clientEmail });
  if (a.clientNote) rows.push({ label: 'Nota', value: a.clientNote });
  return rows;
}

function renderHtml(title: string, intro: string, rows: Row[], cta: { label: string; url: string }, footer: string): string {
  const table = rows
    .map(
      (r) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#71717a;font-size:12px;text-transform:uppercase;letter-spacing:.08em;white-space:nowrap">${escapeHtml(r.label)}</td><td style="padding:6px 0;color:#fafafa;font-size:15px">${escapeHtml(r.value)}</td></tr>`,
    )
    .join('');
  return `<!doctype html><html lang="es"><body style="margin:0;background:#09090b;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:32px 20px">
  <p style="margin:0 0 8px;color:#D4AF37;font-size:12px;letter-spacing:.2em;text-transform:uppercase;font-weight:700">Next Level Barbershop</p>
  <h1 style="margin:0 0 16px;color:#fafafa;font-size:22px">${escapeHtml(title)}</h1>
  <p style="margin:0 0 20px;color:#a1a1aa;font-size:15px;line-height:1.5">${escapeHtml(intro)}</p>
  <table style="border-collapse:collapse;background:#18181b;border:1px solid #27272a;border-radius:12px;padding:12px;width:100%"><tbody>${table}</tbody></table>
  <p style="margin:24px 0"><a href="${escapeHtml(cta.url)}" style="display:inline-block;background:#D4AF37;color:#000;text-decoration:none;font-weight:700;font-size:13px;letter-spacing:.15em;text-transform:uppercase;padding:12px 24px;border-radius:4px">${escapeHtml(cta.label)}</a></p>
  <p style="margin:0;color:#71717a;font-size:12px;line-height:1.5">${escapeHtml(footer)}</p>
</div></body></html>`;
}

function renderText(title: string, intro: string, rows: Row[], cta: { label: string; url: string }, footer: string): string {
  return [
    'NEXT LEVEL BARBERSHOP',
    title,
    '',
    intro,
    '',
    ...rows.map((r) => `${r.label}: ${r.value}`),
    '',
    `${cta.label}: ${cta.url}`,
    '',
    footer,
  ].join('\n');
}

const CANCELLED_BY_LABEL: Record<CancelledBy, string> = {
  client: 'el cliente',
  barber: 'el barbero',
  admin: 'la barbería',
};

export function buildOwnerNewBookingEmail(
  a: NotifyAppointment,
  barber: NotifyBarber,
  service: NotifyService,
  to: string,
  siteUrl?: string,
): EmailMessage {
  const title = 'Nueva reserva';
  const intro = `${a.clientName} reservó ${service.name} con ${barber.name} para el ${formatBogotaDate(a.startDatetime)} a las ${formatBogotaTime(a.startDatetime)}.`;
  const rows = appointmentRows(a, barber, service);
  const cta = { label: 'Ver cita', url: appointmentUrl(a.confirmationToken, siteUrl) };
  const footer = `Código de reserva: ${a.confirmationToken}`;
  return {
    to,
    subject: `Nueva reserva: ${a.clientName} · ${service.name} · ${formatBogotaDate(a.startDatetime)} ${formatBogotaTime(a.startDatetime)}`,
    html: renderHtml(title, intro, rows, cta, footer),
    text: renderText(title, intro, rows, cta, footer),
    replyTo: a.clientEmail ?? undefined,
  };
}

export function buildClientConfirmationEmail(
  a: NotifyAppointment,
  barber: NotifyBarber,
  service: NotifyService,
  siteUrl?: string,
): EmailMessage {
  const title = '¡Tu reserva está confirmada!';
  const intro = `Hola ${a.clientName}, te esperamos con ${barber.name} para tu ${service.name}.`;
  const rows = appointmentRows(a, barber, service).filter((r) => !['Cliente', 'Teléfono', 'Correo'].includes(r.label));
  const cta = { label: 'Ver o cancelar mi cita', url: appointmentUrl(a.confirmationToken, siteUrl) };
  const footer = `Si no puedes asistir, cancela desde el enlace para liberar el turno. Código de reserva: ${a.confirmationToken.slice(0, 8).toUpperCase()}.`;
  return {
    to: a.clientEmail!,
    subject: `Reserva confirmada: ${service.name} · ${formatBogotaDate(a.startDatetime)} ${formatBogotaTime(a.startDatetime)}`,
    html: renderHtml(title, intro, rows, cta, footer),
    text: renderText(title, intro, rows, cta, footer),
  };
}

export function buildCancellationEmail(
  a: NotifyAppointment,
  barber: NotifyBarber,
  service: NotifyService,
  to: string,
  audience: 'owner' | 'client',
  cancelledBy: CancelledBy,
  siteUrl?: string,
): EmailMessage {
  const who = CANCELLED_BY_LABEL[cancelledBy];
  const title = 'Cita cancelada';
  const intro =
    audience === 'owner'
      ? `La cita de ${a.clientName} (${service.name} con ${barber.name}, ${formatBogotaDate(a.startDatetime)} ${formatBogotaTime(a.startDatetime)}) fue cancelada por ${who}.`
      : cancelledBy === 'client'
        ? `Hola ${a.clientName}, tu cita de ${service.name} con ${barber.name} quedó cancelada como lo pediste.`
        : `Hola ${a.clientName}, lamentamos informarte que tu cita de ${service.name} con ${barber.name} fue cancelada por ${who}.`;
  const rows = appointmentRows(a, barber, service).filter(
    (r) => audience === 'owner' || !['Cliente', 'Teléfono', 'Correo'].includes(r.label),
  );
  if (a.cancellationReason) rows.push({ label: 'Motivo', value: a.cancellationReason });
  const cta =
    audience === 'owner'
      ? { label: 'Ver cita', url: appointmentUrl(a.confirmationToken, siteUrl) }
      : { label: 'Reservar de nuevo', url: `${siteUrl ?? getNotificationConfig().siteUrl}/#reservar` };
  const footer =
    audience === 'owner'
      ? `Código de reserva: ${a.confirmationToken}`
      : 'El turno quedó libre. Puedes reservar otro cuando quieras.';
  return {
    to,
    subject: `Cita cancelada: ${a.clientName} · ${service.name} · ${formatBogotaDate(a.startDatetime)} ${formatBogotaTime(a.startDatetime)}`,
    html: renderHtml(title, intro, rows, cta, footer),
    text: renderText(title, intro, rows, cta, footer),
  };
}

// ---------------------------------------------------------------------------
// Envío (nunca lanza)
// ---------------------------------------------------------------------------
export interface SendResult {
  ok: boolean;
  id?: string;
  skipped?: 'no_api_key' | 'no_recipient';
  error?: string;
}

async function send(message: EmailMessage, kind: string): Promise<SendResult> {
  const resend = getClient();
  if (!resend) return { ok: false, skipped: 'no_api_key' };
  const { from } = getNotificationConfig();
  try {
    const { data, error } = await resend.emails.send({
      from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      replyTo: message.replyTo,
    });
    if (error) {
      console.error(`[notifications] Resend rechazó el email (${kind}) a ${message.to}:`, error);
      return { ok: false, error: error.message ?? String(error) };
    }
    return { ok: true, id: data?.id };
  } catch (err) {
    console.error(`[notifications] Error enviando email (${kind}) a ${message.to}:`, err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Aviso al dueño (NOTIFY_EMAIL) de una reserva nueva. */
export async function sendOwnerNewBookingAlert(
  appointment: NotifyAppointment,
  barber: NotifyBarber,
  service: NotifyService,
): Promise<SendResult> {
  const { notifyEmail } = getNotificationConfig();
  if (!notifyEmail) {
    console.warn('[notifications] NOTIFY_EMAIL no está configurado: sin aviso al dueño.');
    return { ok: false, skipped: 'no_recipient' };
  }
  return send(buildOwnerNewBookingEmail(appointment, barber, service, notifyEmail), 'owner_new_booking');
}

/** Confirmación al cliente; solo si dejó correo. */
export async function sendBookingConfirmation(
  appointment: NotifyAppointment,
  barber: NotifyBarber,
  service: NotifyService,
): Promise<SendResult> {
  if (!appointment.clientEmail) return { ok: false, skipped: 'no_recipient' };
  return send(buildClientConfirmationEmail(appointment, barber, service), 'client_confirmation');
}

/** Aviso de cancelación al dueño y, si dejó correo, al cliente. */
export async function sendCancellationNotice(
  appointment: NotifyAppointment,
  barber: NotifyBarber,
  service: NotifyService,
  cancelledBy: CancelledBy,
): Promise<{ owner: SendResult; client: SendResult }> {
  const { notifyEmail } = getNotificationConfig();
  const owner = notifyEmail
    ? send(buildCancellationEmail(appointment, barber, service, notifyEmail, 'owner', cancelledBy), 'owner_cancellation')
    : Promise.resolve<SendResult>({ ok: false, skipped: 'no_recipient' });
  const client = appointment.clientEmail
    ? send(buildCancellationEmail(appointment, barber, service, appointment.clientEmail, 'client', cancelledBy), 'client_cancellation')
    : Promise.resolve<SendResult>({ ok: false, skipped: 'no_recipient' });
  const [o, c] = await Promise.all([owner, client]);
  return { owner: o, client: c };
}
