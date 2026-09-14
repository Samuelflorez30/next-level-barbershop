import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock del SDK: cada `new Resend()` comparte el mismo `emails.send`.
const sendMock = vi.hoisted(() => vi.fn());
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

import {
  buildCancellationEmail,
  buildClientConfirmationEmail,
  buildOwnerNewBookingEmail,
  resetNotificationsForTests,
  sendBookingConfirmation,
  sendCancellationNotice,
  sendOwnerNewBookingAlert,
} from './notifications';

const appointment = {
  id: 7,
  confirmationToken: 'c3b253be-1a93-4e12-82ac-2376508e39f6',
  clientName: 'Juan Pérez',
  clientPhone: '573001234567',
  clientEmail: 'juan@example.com',
  clientNote: 'Primera vez',
  startDatetime: new Date('2026-10-14T15:00:00.000Z'), // miércoles 14 oct, 10:00 a. m. Bogotá
  endDatetime: new Date('2026-10-14T16:00:00.000Z'),
  price: 40000,
  cancellationReason: null,
};
const barber = { name: 'Oswar Avendaño' };
const service = { name: 'Corte Premium' };

const ENV = ['RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'NOTIFY_EMAIL', 'PUBLIC_SITE_URL'] as const;
const saved: Partial<Record<(typeof ENV)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.RESEND_API_KEY = 're_test_123';
  process.env.RESEND_FROM_EMAIL = 'reservas@barbernextlevel.com';
  process.env.NOTIFY_EMAIL = 'dueno@example.com';
  process.env.PUBLIC_SITE_URL = 'https://barbernextlevel.com';
  // El módulo lee import.meta.env primero (vitest lo define): asegurar que no interfiera.
  for (const k of ENV) (import.meta.env as Record<string, string | undefined>)[k] = process.env[k];
  sendMock.mockReset();
  sendMock.mockResolvedValue({ data: { id: 'email_1' }, error: null });
  resetNotificationsForTests();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV) {
    process.env[k] = saved[k];
    (import.meta.env as Record<string, string | undefined>)[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe('armado de mensajes', () => {
  it('aviso al dueño: asunto y cuerpo con todos los datos y el enlace /citas/<token>', () => {
    const m = buildOwnerNewBookingEmail(appointment, barber, service, 'dueno@example.com', 'https://barbernextlevel.com');
    expect(m.to).toBe('dueno@example.com');
    expect(m.subject).toMatch(/^Nueva reserva: Juan Pérez · Corte Premium · miércoles, 14 de octubre de 2026 10:00/);
    for (const needle of ['Juan Pérez', '573001234567', 'juan@example.com', 'Primera vez', 'Corte Premium', 'Oswar Avendaño', '$40.000', 'https://barbernextlevel.com/citas/c3b253be-1a93-4e12-82ac-2376508e39f6']) {
      expect(m.text).toContain(needle);
      expect(m.html).toContain(needle);
    }
    expect(m.text).toMatch(/10:00 a\.?\s?m\./);
    expect(m.replyTo).toBe('juan@example.com'); // responder al cliente directamente
  });

  it('confirmación al cliente: no repite sus datos y trae enlace para ver/cancelar', () => {
    const m = buildClientConfirmationEmail(appointment, barber, service, 'https://barbernextlevel.com');
    expect(m.to).toBe('juan@example.com');
    expect(m.subject).toBe('Reserva confirmada: Corte Premium · miércoles, 14 de octubre de 2026 10:00 a. m.');
    expect(m.text).toContain('Hola Juan Pérez');
    expect(m.text).toContain('Ver o cancelar mi cita: https://barbernextlevel.com/citas/c3b253be-1a93-4e12-82ac-2376508e39f6');
    expect(m.text).not.toContain('Teléfono:');
    expect(m.text).toContain('C3B253BE');
  });

  it('cancelación: indica quién canceló y el motivo; versión dueño vs cliente', () => {
    const withReason = { ...appointment, cancellationReason: 'Cliente avisó' };
    const owner = buildCancellationEmail(withReason, barber, service, 'dueno@example.com', 'owner', 'barber', 'https://x.com');
    expect(owner.subject).toMatch(/^Cita cancelada: Juan Pérez · Corte Premium/);
    expect(owner.text).toContain('fue cancelada por el barbero');
    expect(owner.text).toContain('Motivo: Cliente avisó');
    expect(owner.text).toContain('https://x.com/citas/');

    const client = buildCancellationEmail(withReason, barber, service, 'juan@example.com', 'client', 'admin', 'https://x.com');
    expect(client.text).toContain('fue cancelada por la barbería');
    expect(client.text).toContain('https://x.com/#reservar');
    expect(client.text).not.toContain('Teléfono:');

    const self = buildCancellationEmail(appointment, barber, service, 'juan@example.com', 'client', 'client');
    expect(self.text).toContain('quedó cancelada como lo pediste');
  });

  it('escapa HTML en los datos del cliente', () => {
    const m = buildOwnerNewBookingEmail({ ...appointment, clientName: '<img src=x onerror=alert(1)>' }, barber, service, 'a@b.c');
    expect(m.html).not.toContain('<img src=x');
    expect(m.html).toContain('&lt;img src=x');
  });
});

describe('envío', () => {
  it('sendOwnerNewBookingAlert envía a NOTIFY_EMAIL desde RESEND_FROM_EMAIL', async () => {
    const r = await sendOwnerNewBookingAlert(appointment, barber, service);
    expect(r).toEqual({ ok: true, id: 'email_1' });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toMatchObject({
      from: 'reservas@barbernextlevel.com',
      to: 'dueno@example.com',
      subject: expect.stringContaining('Nueva reserva'),
      replyTo: 'juan@example.com',
    });
  });

  it('sendBookingConfirmation solo envía si hay clientEmail', async () => {
    expect(await sendBookingConfirmation({ ...appointment, clientEmail: null }, barber, service)).toEqual({ ok: false, skipped: 'no_recipient' });
    expect(sendMock).not.toHaveBeenCalled();

    const r = await sendBookingConfirmation(appointment, barber, service);
    expect(r.ok).toBe(true);
    expect(sendMock.mock.calls[0][0].to).toBe('juan@example.com');
  });

  it('sendCancellationNotice avisa al dueño y al cliente (o solo al dueño sin correo)', async () => {
    const both = await sendCancellationNotice(appointment, barber, service, 'admin');
    expect(both.owner.ok && both.client.ok).toBe(true);
    expect(sendMock.mock.calls.map((c) => c[0].to).sort()).toEqual(['dueno@example.com', 'juan@example.com']);

    sendMock.mockClear();
    const ownerOnly = await sendCancellationNotice({ ...appointment, clientEmail: null }, barber, service, 'client');
    expect(ownerOnly.client).toEqual({ ok: false, skipped: 'no_recipient' });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('sin RESEND_API_KEY: no envía, avisa una sola vez y no lanza', async () => {
    process.env.RESEND_API_KEY = '';
    (import.meta.env as Record<string, string | undefined>).RESEND_API_KEY = '';
    resetNotificationsForTests();
    expect(await sendOwnerNewBookingAlert(appointment, barber, service)).toEqual({ ok: false, skipped: 'no_api_key' });
    expect(await sendBookingConfirmation(appointment, barber, service)).toEqual({ ok: false, skipped: 'no_api_key' });
    expect(sendMock).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('un error del proveedor (rechazo o excepción) se registra y no lanza', async () => {
    sendMock.mockResolvedValueOnce({ data: null, error: { message: 'Invalid API key', name: 'validation_error' } });
    const rejected = await sendOwnerNewBookingAlert(appointment, barber, service);
    expect(rejected).toEqual({ ok: false, error: 'Invalid API key' });

    sendMock.mockRejectedValueOnce(new Error('network down'));
    await expect(sendBookingConfirmation(appointment, barber, service)).resolves.toEqual({ ok: false, error: 'network down' });

    sendMock.mockRejectedValue(new Error('boom'));
    const cancel = await sendCancellationNotice(appointment, barber, service, 'client');
    expect(cancel.owner.ok).toBe(false);
    expect(cancel.client.ok).toBe(false);
    expect(console.error).toHaveBeenCalledTimes(4);
  });
});
