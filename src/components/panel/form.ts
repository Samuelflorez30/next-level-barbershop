/**
 * Utilidades de los formularios del panel (navegador): envío JSON, errores
 * inline junto a cada campo y mensajes de estado. Sin alert().
 *
 * Convención de marcado:
 *   <input name="campo">  +  <p data-error-for="campo" hidden></p>
 * El servidor responde 422 con `error.details = { campo: [mensajes] }`.
 */

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export type JsonResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: ApiError | null };

export async function sendJson<T = unknown>(url: string, method: string, body?: unknown): Promise<JsonResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, error: { code: 'NETWORK', message: 'Sin conexión. Revisa tu internet e intenta de nuevo.' } };
  }
  const data = await res.json().catch(() => null);
  if (res.ok) return { ok: true, status: res.status, data: data as T };
  return { ok: false, status: res.status, error: data?.error ?? null };
}

export function clearFieldErrors(form: HTMLElement) {
  form.querySelectorAll<HTMLElement>('[data-error-for]').forEach((el) => {
    el.textContent = '';
    el.hidden = true;
  });
  form.querySelectorAll('[aria-invalid="true"]').forEach((el) => el.removeAttribute('aria-invalid'));
}

/** Muestra `{ campo: [mensajes] }` junto a cada campo y enfoca el primero. Devuelve true si mostró alguno. */
export function showFieldErrors(form: HTMLElement, details: unknown): boolean {
  if (!details || typeof details !== 'object') return false;
  let first: HTMLElement | null = null;
  for (const [field, messages] of Object.entries(details as Record<string, unknown>)) {
    const el = form.querySelector<HTMLElement>(`[data-error-for="${field}"]`);
    if (!el || !Array.isArray(messages) || messages.length === 0) continue;
    el.textContent = messages.join(' ');
    el.hidden = false;
    const input = form.querySelector<HTMLElement>(`[name="${field}"]`);
    input?.setAttribute('aria-invalid', 'true');
    first ??= input ?? el;
  }
  first?.focus();
  return first !== null;
}

export type MessageState = 'pending' | 'success' | 'error' | '';

/** Mensaje de estado junto al botón (mismo tratamiento que /panel/horario). */
export function setMessage(el: HTMLElement, text: string, state: MessageState) {
  el.textContent = text;
  el.className = `text-sm ${state === 'success' ? 'text-emerald-300' : state === 'error' ? 'text-red-300' : 'text-zinc-400'}`;
  if (state) el.dataset.state = state;
  else delete el.dataset.state;
}
