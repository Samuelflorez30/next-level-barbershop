/**
 * Seed inicial: consolida los datos que hoy viven hardcodeados en
 * src/components/Team.astro y src/components/Services.astro.
 *
 * Es idempotente: barberos y servicios se hacen upsert por slug; los
 * horarios se regeneran; los usuarios existentes no se tocan salvo
 * SEED_RESET_PASSWORDS=1.
 *
 * Uso: npm run db:seed   (lee .env vía `node --env-file`)
 */
import { eq, sql } from 'drizzle-orm';
import { db, libsqlClient } from './client';
import {
  barberSchedules,
  barberServices,
  barbers,
  services,
  users,
  type NewBarber,
  type NewService,
} from './schema';
import { generateTemporaryPassword, hashPassword } from '../lib/password';

// ---------------------------------------------------------------------------
// Datos
// ---------------------------------------------------------------------------

const BARBERS: NewBarber[] = [
  {
    slug: 'oswar-avendano',
    name: 'Oswar Avendaño',
    role: 'Master Barber',
    quote: 'La perfección no es un objetivo, es nuestro estándar.',
    photoUrl: '/oswar2.jpg',
    phoneWhatsapp: '573142915681',
    displayOrder: 1,
  },
  {
    slug: 'stiven-tapia',
    name: 'Stiven Tapia',
    role: 'Master Barber',
    quote: 'Tu cabello es el lienzo, la navaja es mi pincel.',
    photoUrl: '/harolportada.jpg',
    phoneWhatsapp: '573183452539',
    displayOrder: 2,
  },
  {
    slug: 'jesus-montoya',
    name: 'Jesus Montoya',
    role: 'Master Barber',
    quote:
      'Diseñamos un estilo que hable por ti antes de que digas una palabra.',
    photoUrl: '/JesusMontoya.jpeg',
    phoneWhatsapp: '573192672869',
    displayOrder: 3,
  },
  {
    slug: 'jesus-toro',
    name: 'Jesus Toro',
    role: 'Master Barber',
    quote: 'No es solo un corte, es tu carta de presentación.',
    photoUrl: '/JesusToro.jpeg',
    phoneWhatsapp: '573183175916',
    displayOrder: 4,
  },
];

// Precios en COP enteros ($30.000 -> 30000). Todos los servicios duran 60 min.
const SERVICES: NewService[] = [
  {
    slug: 'corte-basico',
    name: 'Corte Básico',
    description: 'Corte de cabello clásico o degradado con técnica impecable.',
    defaultPrice: 30000,
    defaultDurationMinutes: 60,
    imageUrl: '/Basico.jpg',
    displayOrder: 1,
  },
  {
    slug: 'corte-kids',
    name: 'Corte Kids',
    description:
      'Corte diseñado especialmente para los más pequeños, con paciencia y estilo.',
    defaultPrice: 30000,
    defaultDurationMinutes: 60,
    imageUrl: '/Kids1.jpg',
    displayOrder: 2,
  },
  {
    slug: 'corte-premium',
    name: 'Corte Premium',
    description:
      'Incluye lavado, mascarilla, extracción de puntos negros y masajes relajantes.',
    defaultPrice: 40000,
    defaultDurationMinutes: 60,
    imageUrl: '/CortePremium.jpg',
    displayOrder: 3,
  },
  {
    slug: 'corte-barba-basico',
    name: 'Corte + Barba Básico',
    description:
      'Corte impecable y perfilado de barba preciso. Incluye vaporizador.',
    defaultPrice: 45000,
    defaultDurationMinutes: 60,
    imageUrl: '/BarbaBasico.jpg',
    displayOrder: 4,
  },
  {
    slug: 'corte-barba-premium',
    name: 'Corte + Barba Premium',
    description:
      'La experiencia definitiva. Incluye vaporizador, limpieza profunda y mascarilla.',
    defaultPrice: 50000,
    defaultDurationMinutes: 60,
    imageUrl: '/BarbaPremium.jpg',
    displayOrder: 5,
  },
  {
    slug: 'diseno-freestyle',
    name: 'Diseño Freestyle',
    description:
      'Diseños personalizados, grecas y líneas creativas ejecutadas a navaja libre.',
    defaultPrice: 20000, // en el sitio se muestra como "Desde $20.000"
    defaultDurationMinutes: 60,
    imageUrl: '/Freestyle.jpg',
    displayOrder: 6,
  },
  {
    slug: 'limpieza-facial',
    name: 'Limpieza Facial',
    description:
      'Renueva tu piel con nuestra limpieza profunda, exfoliación e hidratación.',
    defaultPrice: 30000, // en el sitio se muestra como "Desde $30.000"
    defaultDurationMinutes: 60,
    imageUrl: '/LimpiezaFacial.jpg',
    displayOrder: 7,
  },
  {
    slug: 'ondulados-semi-permanentes',
    name: 'Ondulados Semi Permanentes',
    description:
      'Aporta textura, volumen y movimiento a tu cabello con ondas duraderas.',
    defaultPrice: 200000, // en el sitio se muestra como "Desde $200.000"
    defaultDurationMinutes: 60,
    imageUrl: '/Ondulado.jpg',
    displayOrder: 8,
  },
  {
    slug: 'colorimetria-platinado',
    name: 'Colorimetría / Platinado',
    description:
      'Transformación radical de color utilizando productos de alta gama que protegen tu cabello.',
    defaultPrice: 200000, // en el sitio se muestra como "Desde $200.000"
    defaultDurationMinutes: 60,
    imageUrl: '/Platinado.jpg',
    displayOrder: 9,
  },
];

// Horario de atención (hora local Bogotá). day_of_week: 0 = lunes … 6 = domingo.
// Lunes a sábado 09:00–21:00; domingo 10:00–21:00. La última cita (20:00)
// se deriva de cierre − duración del servicio en la lógica de disponibilidad.
const WEEKLY_SCHEDULE: { dayOfWeek: number; startTime: string; endTime: string }[] = [
  { dayOfWeek: 0, startTime: '09:00', endTime: '21:00' }, // lunes
  { dayOfWeek: 1, startTime: '09:00', endTime: '21:00' }, // martes
  { dayOfWeek: 2, startTime: '09:00', endTime: '21:00' }, // miércoles
  { dayOfWeek: 3, startTime: '09:00', endTime: '21:00' }, // jueves
  { dayOfWeek: 4, startTime: '09:00', endTime: '21:00' }, // viernes
  { dayOfWeek: 5, startTime: '09:00', endTime: '21:00' }, // sábado
  { dayOfWeek: 6, startTime: '10:00', endTime: '21:00' }, // domingo
];

// El admin entra con su email real; los barberos con un usuario simple
// derivado del slug (sin guiones): oswaravendano, stiventapia, …
const ADMIN_USERNAME = 'reservasnextlevel@gmail.com';
const barberUsername = (slug: string) => slug.replace(/-/g, '');

// Usuarios creados por versiones anteriores del seed: se renombran en vez de
// crear cuentas duplicadas (conservan contraseña, barbero y sesiones).
const LEGACY_ADMIN_USERNAME = 'davidflorezramirez1602@gmail.com';
const legacyBarberUsername = (slug: string) => `${slug}@barbernextlevel.com`;

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

const RESET_PASSWORDS = process.env.SEED_RESET_PASSWORDS === '1';

type CredentialRow = { username: string; role: string; password: string };

async function seedBarbers() {
  for (const b of BARBERS) {
    await db
      .insert(barbers)
      .values(b)
      .onConflictDoUpdate({
        target: barbers.slug,
        set: {
          name: b.name,
          role: b.role,
          quote: b.quote,
          photoUrl: b.photoUrl,
          phoneWhatsapp: b.phoneWhatsapp,
          displayOrder: b.displayOrder,
        },
      });
  }
  return db.select().from(barbers).orderBy(barbers.displayOrder);
}

async function seedServices() {
  for (const s of SERVICES) {
    await db
      .insert(services)
      .values(s)
      .onConflictDoUpdate({
        target: services.slug,
        set: {
          name: s.name,
          description: s.description,
          defaultPrice: s.defaultPrice,
          defaultDurationMinutes: s.defaultDurationMinutes,
          imageUrl: s.imageUrl,
          displayOrder: s.displayOrder,
        },
      });
  }
  return db.select().from(services).orderBy(services.displayOrder);
}

async function seedBarberServices(barberIds: number[], serviceIds: number[]) {
  // Todos los barberos ofrecen todos los servicios con precio/duración heredados.
  const rows = barberIds.flatMap((barberId) =>
    serviceIds.map((serviceId) => ({ barberId, serviceId })),
  );
  await db.insert(barberServices).values(rows).onConflictDoNothing();
}

async function seedSchedules(barberIds: number[]) {
  for (const barberId of barberIds) {
    await db.delete(barberSchedules).where(eq(barberSchedules.barberId, barberId));
    await db
      .insert(barberSchedules)
      .values(WEEKLY_SCHEDULE.map((s) => ({ barberId, ...s })));
  }
}

async function upsertUser(
  username: string,
  role: 'admin' | 'barber',
  barberId: number | null,
  credentials: CredentialRow[],
  legacyUsername?: string,
) {
  let existing = await db.query.users.findFirst({
    where: eq(users.username, username),
  });

  if (!existing && legacyUsername) {
    const legacy = await db.query.users.findFirst({ where: eq(users.username, legacyUsername) });
    if (legacy) {
      await db.update(users).set({ username }).where(eq(users.id, legacy.id));
      console.log(`  usuario renombrado: ${legacyUsername} → ${username}`);
      existing = { ...legacy, username };
    }
  }

  if (existing && !RESET_PASSWORDS) {
    // Mantener la contraseña actual; solo sincronizar rol/barbero.
    await db.update(users).set({ role, barberId }).where(eq(users.id, existing.id));
    return;
  }

  const password = generateTemporaryPassword();
  const passwordHash = await hashPassword(password);

  if (existing) {
    await db
      .update(users)
      .set({ role, barberId, passwordHash })
      .where(eq(users.id, existing.id));
  } else {
    await db.insert(users).values({ username, role, barberId, passwordHash });
  }
  credentials.push({ username, role, password });
}

async function main() {
  console.log('Seed → iniciando…');

  const barberRows = await seedBarbers();
  console.log(`  barberos:        ${barberRows.length}`);

  const serviceRows = await seedServices();
  console.log(`  servicios:       ${serviceRows.length}`);

  const barberIds = barberRows.map((b) => b.id);
  const serviceIds = serviceRows.map((s) => s.id);

  await seedBarberServices(barberIds, serviceIds);
  const [{ count: bsCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(barberServices);
  console.log(`  barber_services: ${bsCount}`);

  await seedSchedules(barberIds);
  const [{ count: schCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(barberSchedules);
  console.log(`  horarios:        ${schCount}`);

  const credentials: CredentialRow[] = [];
  await upsertUser(ADMIN_USERNAME, 'admin', null, credentials, LEGACY_ADMIN_USERNAME);
  for (const b of barberRows) {
    await upsertUser(barberUsername(b.slug), 'barber', b.id, credentials, legacyBarberUsername(b.slug));
  }
  const [{ count: userCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(users);
  console.log(`  usuarios:        ${userCount}`);

  if (credentials.length > 0) {
    console.log('\nContraseñas temporales (guárdalas ahora; no se vuelven a mostrar):');
    console.table(credentials);
  } else {
    console.log(
      '\nTodos los usuarios ya existían; contraseñas sin cambios. ' +
        'Usa SEED_RESET_PASSWORDS=1 para regenerarlas.',
    );
  }

  console.log('\nSeed → listo.');
}

main()
  .catch((err) => {
    console.error('Seed → error:', err);
    process.exitCode = 1;
  })
  .finally(() => libsqlClient.close());
