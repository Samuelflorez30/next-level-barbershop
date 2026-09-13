import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import * as schema from './schema';

/**
 * Lee una variable de entorno tanto en Astro/Vite (`import.meta.env`)
 * como en scripts Node (`process.env`, p. ej. el seed con tsx).
 */
function readEnv(name: string): string | undefined {
  const fromVite = (import.meta as unknown as { env?: Record<string, string> })
    .env?.[name];
  return fromVite ?? process.env[name];
}

export type Database = LibSQLDatabase<typeof schema>;

// Cache global para no abrir una conexión nueva en cada HMR del dev server.
const globalForDb = globalThis as unknown as {
  __nextLevelDb?: { client: Client; db: Database };
};

function connect(): { client: Client; db: Database } {
  const url = readEnv('TURSO_DATABASE_URL');
  if (!url) {
    throw new Error(
      'Falta TURSO_DATABASE_URL. Copia .env.example a .env y complétalo (ver docs/SETUP.md).',
    );
  }
  const authToken = readEnv('TURSO_AUTH_TOKEN') || undefined;

  const client = createClient({
    url,
    authToken,
    // Solo aplica a `file:` (SQLite local): espera en vez de fallar con
    // SQLITE_BUSY si otro proceso tiene la base de datos bloqueada.
    timeout: 2000,
  });
  const db = drizzle(client, { schema });
  return { client, db };
}

const connection = globalForDb.__nextLevelDb ?? connect();
if (import.meta.env?.DEV) globalForDb.__nextLevelDb = connection;

/** Instancia única de Drizzle conectada a Turso. */
export const db: Database = connection.db;
/** Cliente libSQL subyacente (útil para cerrar la conexión en scripts). */
export const libsqlClient: Client = connection.client;

export { schema };
