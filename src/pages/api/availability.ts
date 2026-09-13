import type { APIRoute } from 'astro';
import { apiError, json, parseIdParam } from '../../lib/api';
import { computeAvailableSlots } from '../../lib/availability';
import { isValidDateString } from '../../lib/time';

/**
 * GET /api/availability?barberId=&serviceId=&date=YYYY-MM-DD
 * Slots disponibles (hora local Bogotá) para ese barbero, servicio y día.
 */
export const GET: APIRoute = async ({ url }) => {
  const barberId = parseIdParam(url.searchParams.get('barberId'));
  const serviceId = parseIdParam(url.searchParams.get('serviceId'));
  const date = url.searchParams.get('date') ?? '';

  if (barberId === undefined || Number.isNaN(barberId)) {
    return apiError(400, 'INVALID_BARBER_ID', 'barberId es obligatorio y debe ser un entero positivo.');
  }
  if (serviceId === undefined || Number.isNaN(serviceId)) {
    return apiError(400, 'INVALID_SERVICE_ID', 'serviceId es obligatorio y debe ser un entero positivo.');
  }
  if (!isValidDateString(date)) {
    return apiError(400, 'INVALID_DATE', 'date es obligatorio con formato YYYY-MM-DD.');
  }

  const slots = await computeAvailableSlots({ barberId, serviceId, date, now: new Date() });

  return json({
    barberId,
    serviceId,
    date,
    timezone: 'America/Bogota',
    slots: slots.map((s) => ({
      start: s.start.toISOString(),
      end: s.end.toISOString(),
      startLocal: s.startLocal,
      endLocal: s.endLocal,
    })),
  });
};
