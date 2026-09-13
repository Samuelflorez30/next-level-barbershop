import { defineConfig } from 'drizzle-kit';

const url = process.env.TURSO_DATABASE_URL;
if (!url) {
  throw new Error(
    'Falta TURSO_DATABASE_URL. Copia .env.example a .env y complétalo (ver docs/SETUP.md).',
  );
}

const isLocalFile = url.startsWith('file:');

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
  // Desarrollo local: archivo SQLite. Producción: Turso remoto con token.
  ...(isLocalFile
    ? { dialect: 'sqlite', dbCredentials: { url } }
    : {
        dialect: 'turso',
        dbCredentials: { url, authToken: process.env.TURSO_AUTH_TOKEN },
      }),
});
