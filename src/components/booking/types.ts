/** Tipos de las respuestas de /api/* que consume el widget. */

export interface ApiService {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  defaultDurationMinutes: number;
  /** COP enteros. */
  defaultPrice: number;
  imageUrl: string | null;
  displayOrder: number;
}

export interface ApiBarber {
  id: number;
  name: string;
  slug: string;
  role: string;
  quote: string | null;
  photoUrl: string | null;
  phoneWhatsapp: string;
  displayOrder: number;
}

export interface ApiSlot {
  /** ISO UTC */
  start: string;
  /** ISO UTC */
  end: string;
  /** "HH:MM" Bogotá */
  startLocal: string;
  endLocal: string;
}

export interface ApiAppointment {
  id: number;
  confirmationToken: string;
  status: string;
  barberId: number;
  serviceId: number;
  startDatetime: string;
  endDatetime: string;
  price: number;
  clientName: string;
  clientPhone: string;
  clientEmail: string | null;
  clientNote: string | null;
}

export interface CreateAppointmentBody {
  barberId: number;
  serviceId: number;
  startDatetime: string;
  clientName: string;
  clientPhone: string;
  clientEmail?: string;
  clientNote?: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, string[]> };
}
