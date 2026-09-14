import { describe, expect, it } from 'vitest';
import {
  buildAppointmentConfirmationMessage,
  buildServiceInquiryMessage,
  buildWhatsAppUrl,
  formatBogotaDate,
  formatBogotaTime,
} from './whatsapp';

// 2026-10-14T15:00Z = miércoles 14 de octubre de 2026, 10:00 a. m. en Bogotá
const START = new Date('2026-10-14T15:00:00.000Z');

describe('whatsapp helpers', () => {
  it('arma el enlace wa.me con el texto codificado', () => {
    expect(buildWhatsAppUrl('573142915681', 'Hola, ¿qué tal?')).toBe(
      'https://wa.me/573142915681?text=Hola%2C%20%C2%BFqu%C3%A9%20tal%3F',
    );
    expect(buildWhatsAppUrl('+57 314 291 5681', 'x')).toBe('https://wa.me/573142915681?text=x');
  });

  it('conserva el mensaje del modal antiguo', () => {
    expect(buildServiceInquiryMessage('Corte Premium')).toBe(
      'Hola, deseo agendar el servicio de Corte Premium contigo.',
    );
  });

  it('formatea fecha y hora en zona Bogotá', () => {
    expect(formatBogotaDate(START)).toMatch(/miércoles.*14.*octubre.*2026/);
    expect(formatBogotaTime(START)).toMatch(/10:00/);
    expect(formatBogotaTime(START)).toMatch(/a\.?\s?m\./i);
  });

  it('arma el resumen de la cita con nombre de pila, servicio, fecha, hora y código', () => {
    const msg = buildAppointmentConfirmationMessage({
      barberName: 'Oswar Avendaño',
      serviceName: 'Corte Premium',
      startDatetime: START,
      clientName: 'Juan Pérez',
      confirmationToken: 'c3b253be-1a93-4e12-82ac-2376508e39f6',
    });
    expect(msg).toContain('Hola Oswar, soy Juan Pérez.');
    expect(msg).toContain('*Corte Premium*');
    expect(msg).toMatch(/miércoles.*14.*octubre/);
    expect(msg).toMatch(/10:00 a\.\s?m\.\n/);
    expect(msg).not.toContain('..');
    expect(msg).toContain('Código de reserva: C3B253BE');
  });
});
