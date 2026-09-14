/// <reference path="../.astro/types.d.ts" />

declare namespace App {
  interface Locals {
    /** Usuario autenticado (lo llena src/middleware.ts) o null. */
    user: import('./lib/auth').SessionUser | null;
    /** Token de sesión en claro (para invalidarlo en logout) o null. */
    sessionToken: string | null;
  }
}
