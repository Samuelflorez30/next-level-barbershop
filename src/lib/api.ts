/** Helpers para respuestas JSON uniformes en src/pages/api. */

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

export type ApiErrorBody = {
  error: { code: string; message: string; details?: unknown };
};

export function apiError(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): Response {
  const body: ApiErrorBody = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  return json(body, status);
}

/** Lee y parsea el body JSON; null si está vacío o no es JSON válido. */
export async function readJson(request: Request): Promise<unknown | null> {
  try {
    const text = await request.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Parsea un entero positivo de un query param; undefined si no viene, NaN si es inválido. */
export function parseIdParam(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : Number.NaN;
}
