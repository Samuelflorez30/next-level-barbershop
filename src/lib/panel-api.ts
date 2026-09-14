/** Helpers compartidos por los endpoints de /api/panel. */
import type { APIContext } from 'astro';
import type { SessionUser } from './auth';
import { apiError, readJson } from './api';
import { PanelError } from './panel';

/** El middleware ya bloquea sin sesión; esto es defensa en profundidad. */
export function requireUser(locals: App.Locals): SessionUser {
  if (!locals.user) throw new PanelError(403, 'UNAUTHENTICATED', 'Inicia sesión.');
  return locals.user;
}

export function panelErrorResponse(err: unknown): Response {
  if (err instanceof PanelError) return apiError(err.status, err.code, err.message);
  throw err;
}

/** Ejecuta un handler traduciendo PanelError a respuesta JSON. */
export async function withPanel(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    return panelErrorResponse(err);
  }
}

/** Lee el body JSON o lanza 400. */
export async function requireJson(request: Request): Promise<Record<string, unknown>> {
  const raw = await readJson(request);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PanelError(400, 'INVALID_JSON', 'El body debe ser un objeto JSON.');
  }
  return raw as Record<string, unknown>;
}

/** `?barberId=` o body.barberId como entero positivo, null si viene vacío/null, undefined si no viene. */
export function optionalId(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
    throw new PanelError(400, 'INVALID_ID', 'barberId debe ser un entero positivo.');
  }
  return n;
}

export function requireIdParam(params: APIContext['params'], name = 'id'): number {
  const n = Number(params[name]);
  if (!Number.isInteger(n) || n <= 0) throw new PanelError(400, 'INVALID_ID', `${name} inválido.`);
  return n;
}
