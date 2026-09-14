/**
 * Utilidades para tests de integración con una base de datos SQLite temporal.
 *
 * Uso en cada archivo de test (la variable de entorno debe fijarse ANTES de
 * importar src/db/client, por eso va en `vi.hoisted`):
 *
 *   vi.hoisted(() => useTempDatabase());   // ← requiere import dinámico, ver abajo
 *
 * Como `vi.hoisted` corre antes que los imports estáticos, los tests llaman
 * a `useTempDatabase()` vía `await import('../test/db')` dentro del hoisted.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { hashPassword } from '../lib/password';
import type { Database } from '../db/client';
import {
  appointments,
  barberSchedules,
  barberServices,
  barberTimeOff,
  barbers,
  services,
  sessions,
  users,
  type UserRole,
} from '../db/schema';

/** Fija TURSO_DATABASE_URL a un archivo temporal único y devuelve su ruta. */
export function useTempDatabase(): string {
  const dir = join(tmpdir(), 'next-level-barbershop-tests');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${randomUUID()}.db`);
  process.env.TURSO_DATABASE_URL = `file:${file}`;
  process.env.TURSO_AUTH_TOKEN = '';
  return file;
}

export function removeTempDatabase(file: string) {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    rmSync(file + suffix, { force: true });
  }
}

/** Aplica las migraciones de ./drizzle a la base temporal. */
export async function migrateTestDb(db: Database) {
  await migrate(db, { migrationsFolder: 'drizzle' });
}

/** Borra todas las filas (para aislar cada test). */
export async function truncateAll(db: Database) {
  await db.delete(sessions);
  await db.delete(appointments);
  await db.delete(barberTimeOff);
  await db.delete(barberSchedules);
  await db.delete(barberServices);
  await db.delete(users);
  await db.delete(services);
  await db.delete(barbers);
}

export const FULL_WEEK = [0, 1, 2, 3, 4, 5, 6];

export interface FixtureOptions {
  bufferMinutes?: number;
  durationMinutes?: number;
  /** Días (0=lunes…6=domingo) con horario; por defecto toda la semana. */
  days?: number[];
  startTime?: string;
  endTime?: string;
}

/**
 * Inserta un barbero, un servicio, la relación entre ambos y el horario.
 * Por defecto: sin buffer, servicio de 60 min, toda la semana 09:00–21:00.
 */
export async function seedFixtures(db: Database, opts: FixtureOptions = {}) {
  const {
    bufferMinutes = 0,
    durationMinutes = 60,
    days = FULL_WEEK,
    startTime = '09:00',
    endTime = '21:00',
  } = opts;

  const [barber] = await db
    .insert(barbers)
    .values({
      name: 'Barbero Test',
      slug: `barbero-test-${randomUUID().slice(0, 8)}`,
      role: 'Master Barber',
      phoneWhatsapp: '573000000000',
      bufferMinutes,
    })
    .returning();

  const [service] = await db
    .insert(services)
    .values({
      name: 'Corte Test',
      slug: `corte-test-${randomUUID().slice(0, 8)}`,
      defaultDurationMinutes: durationMinutes,
      defaultPrice: 30000,
    })
    .returning();

  await db.insert(barberServices).values({ barberId: barber.id, serviceId: service.id });

  if (days.length > 0) {
    await db
      .insert(barberSchedules)
      .values(days.map((dayOfWeek) => ({ barberId: barber.id, dayOfWeek, startTime, endTime })));
  }

  return { barber, service };
}

/** Crea un usuario del panel con contraseña en bcrypt. */
export async function seedUser(
  db: Database,
  opts: { username: string; password: string; role: UserRole; barberId?: number | null },
) {
  const [user] = await db
    .insert(users)
    .values({
      username: opts.username,
      passwordHash: await hashPassword(opts.password),
      role: opts.role,
      barberId: opts.barberId ?? null,
    })
    .returning();
  return user;
}
