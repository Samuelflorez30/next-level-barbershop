/**
 * Contrato entre el catálogo (JS plano en Services.astro) y el BookingWidget
 * (isla React). Este módulo no importa React para que el script de Services
 * no arrastre el bundle del widget.
 */

/** `window.dispatchEvent(new CustomEvent(SELECT_SERVICE_EVENT, { detail: { serviceId } }))` */
export const SELECT_SERVICE_EVENT = 'nlb:select-service';

export interface SelectServiceDetail {
  serviceId: number;
}

declare global {
  interface Window {
    /** Servicio elegido antes de que el widget hidratara; el widget lo consume al montar. */
    __nlbPendingServiceId?: number;
  }
}
