import type { APIRoute } from 'astro';
import { asc, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { services } from '../../db/schema';
import { json } from '../../lib/api';

/** GET /api/services — servicios activos. */
export const GET: APIRoute = async () => {
  const rows = await db
    .select({
      id: services.id,
      name: services.name,
      slug: services.slug,
      description: services.description,
      defaultDurationMinutes: services.defaultDurationMinutes,
      defaultPrice: services.defaultPrice,
      imageUrl: services.imageUrl,
      displayOrder: services.displayOrder,
    })
    .from(services)
    .where(eq(services.isActive, true))
    .orderBy(asc(services.displayOrder), asc(services.id));

  return json({ services: rows });
};
