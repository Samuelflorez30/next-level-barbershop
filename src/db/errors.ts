/** Detecta una violación de UNIQUE recorriendo la cadena de `cause` (Drizzle envuelve el error de libSQL). */
export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const e = current as { message?: string; code?: string; cause?: unknown };
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
    if (typeof e.message === 'string' && /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(e.message)) return true;
    current = e.cause;
  }
  return false;
}
