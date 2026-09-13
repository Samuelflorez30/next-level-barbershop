import type { APIRoute } from 'astro';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { barberServices, barbers } from '../../db/schema';
import { apiError, json, parseIdParam } from '../../lib/api';

const publicColumns = {
  id: barbers.id,
  name: barbers.name,
  slug: barbers.slug,
  role: barbers.role,
  quote: barbers.quote,
  photoUrl: barbers.photoUrl,
  phoneWhatsapp: barbers.phoneWhatsapp,
  displayOrder: barbers.displayOrder,
};

/** GET /api/barbers?serviceId= — barberos activos (opcionalmente que ofrezcan un servicio). */
export const GET: APIRoute = async ({ url }) => {
  const serviceId = parseIdParam(url.searchParams.get('serviceId'));
  if (Number.isNaN(serviceId)) {
    return apiError(400, 'INVALID_SERVICE_ID', 'serviceId debe ser un entero positivo.');
  }

  const rows =
    serviceId === undefined
      ? await db
          .select(publicColumns)
          .from(barbers)
          .where(eq(barbers.isActive, true))
          .orderBy(asc(barbers.displayOrder), asc(barbers.id))
      : await db
          .select(publicColumns)
          .from(barbers)
          .innerJoin(
            barberServices,
            and(
              eq(barberServices.barberId, barbers.id),
              eq(barberServices.serviceId, serviceId),
              eq(barberServices.isOffered, true),
            ),
          )
          .where(eq(barbers.isActive, true))
          .orderBy(asc(barbers.displayOrder), asc(barbers.id));

  return json({ barbers: rows });
};
