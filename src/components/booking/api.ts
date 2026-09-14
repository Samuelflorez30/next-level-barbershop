import type {
  ApiAppointment,
  ApiBarber,
  ApiErrorBody,
  ApiService,
  ApiSlot,
  CreateAppointmentBody,
} from './types';

/** Error de la API con código HTTP y cuerpo `{ error }` ya parseado. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
  });

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* sin cuerpo */
  }

  if (!res.ok) {
    const err = (body as ApiErrorBody | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'HTTP_ERROR',
      err?.message ?? `Error ${res.status}`,
      err?.details,
    );
  }
  return body as T;
}

export async function fetchServices(signal?: AbortSignal): Promise<ApiService[]> {
  const data = await request<{ services: ApiService[] }>('/api/services', { signal });
  return data.services;
}

export async function fetchBarbers(serviceId: number, signal?: AbortSignal): Promise<ApiBarber[]> {
  const data = await request<{ barbers: ApiBarber[] }>(
    `/api/barbers?serviceId=${encodeURIComponent(serviceId)}`,
    { signal },
  );
  return data.barbers;
}

export async function fetchAvailability(
  barberId: number,
  serviceId: number,
  date: string,
  signal?: AbortSignal,
): Promise<ApiSlot[]> {
  const params = new URLSearchParams({
    barberId: String(barberId),
    serviceId: String(serviceId),
    date,
  });
  const data = await request<{ slots: ApiSlot[] }>(`/api/availability?${params}`, { signal });
  return data.slots;
}

export function createAppointment(body: CreateAppointmentBody): Promise<ApiAppointment> {
  return request<ApiAppointment>('/api/appointments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
