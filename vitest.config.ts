import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Cada archivo de test crea su propia base de datos SQLite temporal
    // (ver src/test/db.ts), así que pueden correr en paralelo sin interferir.
    isolate: true,
    testTimeout: 15_000,
  },
});
