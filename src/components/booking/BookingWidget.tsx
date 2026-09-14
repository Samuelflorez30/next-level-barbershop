import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildAppointmentConfirmationMessage,
  buildWhatsAppUrl,
  formatBogotaDate,
  formatBogotaTime,
} from '../../lib/whatsapp';
import { ApiError, createAppointment, fetchAvailability, fetchBarbers, fetchServices } from './api';
import { SELECT_SERVICE_EVENT, type SelectServiceDetail } from './events';
import type { ApiAppointment, ApiBarber, ApiService, ApiSlot } from './types';

/**
 * Isla de React: flujo de reserva por pasos.
 *
 * 1 Servicio → 2 Barbero → 3 Fecha y hora → 4 Datos → 5 Confirmar → listo.
 * Las tarjetas de Services.astro pueden preseleccionar un servicio disparando
 * `window.dispatchEvent(new CustomEvent('nlb:select-service', { detail: { serviceId } }))`
 * (o dejando `window.__nlbPendingServiceId` si el widget aún no hidrató).
 */


type Step = 1 | 2 | 3 | 4 | 5 | 'done';

const STEPS: { n: Exclude<Step, 'done'>; label: string }[] = [
  { n: 1, label: 'Servicio' },
  { n: 2, label: 'Barbero' },
  { n: 3, label: 'Fecha y hora' },
  { n: 4, label: 'Tus datos' },
  { n: 5, label: 'Confirmar' },
];

interface ContactForm {
  clientName: string;
  clientPhone: string;
  clientEmail: string;
  clientNote: string;
}

const EMPTY_FORM: ContactForm = { clientName: '', clientPhone: '', clientEmail: '', clientNote: '' };

const cop = new Intl.NumberFormat('es-CO');
const formatPrice = (value: number) => `$${cop.format(value)}`;

/** Fecha de hoy en Bogotá como YYYY-MM-DD (en-CA da ese formato). */
function todayInBogota(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Normaliza un teléfono colombiano a dígitos con indicativo (3xx… → 573xx…). */
function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('3')) return `57${digits}`;
  return digits;
}

function validateForm(form: ContactForm): Partial<Record<keyof ContactForm, string>> {
  const errors: Partial<Record<keyof ContactForm, string>> = {};
  if (form.clientName.trim().length < 2) errors.clientName = 'Escribe tu nombre completo.';
  const phone = normalizePhone(form.clientPhone);
  if (phone.length < 7 || phone.length > 15) errors.clientPhone = 'Escribe un número de celular válido.';
  const email = form.clientEmail.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.clientEmail = 'Escribe un correo válido.';
  if (form.clientNote.length > 500) errors.clientNote = 'Máximo 500 caracteres.';
  return errors;
}

// ---------------------------------------------------------------------------
// Estilos compartidos
// ---------------------------------------------------------------------------
const btnPrimary =
  'inline-flex items-center justify-center px-8 py-3 bg-[#D4AF37] text-black font-bold text-sm tracking-widest uppercase rounded-sm transition-colors duration-300 hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-[#D4AF37]';
const btnGhost =
  'inline-flex items-center gap-1 text-xs tracking-widest uppercase text-zinc-400 hover:text-[#D4AF37] transition-colors';
const card =
  'group text-left w-full bg-zinc-900/60 border border-white/10 rounded-xl p-4 transition-all duration-300 hover:border-[#D4AF37]/60 hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#D4AF37]';
const input =
  'w-full bg-zinc-950 border border-white/10 rounded-md px-4 py-3 text-white placeholder:text-zinc-600 focus:outline-none focus:border-[#D4AF37] transition-colors';
const label = 'block text-xs font-bold tracking-widest uppercase text-zinc-400 mb-2';

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------
export interface BookingWidgetProps {
  initialServiceId?: number;
}

export default function BookingWidget({ initialServiceId }: BookingWidgetProps) {
  const [step, setStep] = useState<Step>(1);

  const [services, setServices] = useState<ApiService[]>([]);
  const [servicesLoading, setServicesLoading] = useState(true);
  const [servicesError, setServicesError] = useState<string | null>(null);
  const [service, setService] = useState<ApiService | null>(null);
  const [pendingServiceId, setPendingServiceId] = useState<number | null>(initialServiceId ?? null);

  const [barbers, setBarbers] = useState<ApiBarber[]>([]);
  const [barbersLoading, setBarbersLoading] = useState(false);
  const [barbersError, setBarbersError] = useState<string | null>(null);
  const [barber, setBarber] = useState<ApiBarber | null>(null);

  const [date, setDate] = useState(() => todayInBogota());
  const [slots, setSlots] = useState<ApiSlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [slot, setSlot] = useState<ApiSlot | null>(null);
  const [slotsReload, setSlotsReload] = useState(0);

  const [form, setForm] = useState<ContactForm>(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<Partial<Record<keyof ContactForm, string>>>({});

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);
  const [result, setResult] = useState<ApiAppointment | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const minDate = useMemo(() => todayInBogota(), []);

  // --- Servicios -----------------------------------------------------------
  useEffect(() => {
    const ctrl = new AbortController();
    setServicesLoading(true);
    fetchServices(ctrl.signal)
      .then((list) => {
        setServices(list);
        setServicesError(null);
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setServicesError(err instanceof Error ? err.message : 'No se pudieron cargar los servicios.');
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setServicesLoading(false);
      });
    return () => ctrl.abort();
  }, []);

  // --- Preselección desde las tarjetas del catálogo ------------------------
  const selectService = useCallback((next: ApiService) => {
    setService(next);
    setBarber(null);
    setSlot(null);
    setConflictNotice(null);
    setSubmitError(null);
    setResult(null);
    setStep(2);
  }, []);

  useEffect(() => {
    const onSelect = (event: Event) => {
      const id = (event as CustomEvent<Partial<SelectServiceDetail>>).detail?.serviceId;
      if (typeof id === 'number') setPendingServiceId(id);
    };
    window.addEventListener(SELECT_SERVICE_EVENT, onSelect);
    if (typeof window.__nlbPendingServiceId === 'number') {
      setPendingServiceId(window.__nlbPendingServiceId);
      window.__nlbPendingServiceId = undefined;
    }
    return () => window.removeEventListener(SELECT_SERVICE_EVENT, onSelect);
  }, []);

  useEffect(() => {
    if (pendingServiceId === null || services.length === 0) return;
    const found = services.find((s) => s.id === pendingServiceId);
    setPendingServiceId(null);
    if (found) selectService(found);
  }, [pendingServiceId, services, selectService]);

  // --- Barberos que ofrecen el servicio ------------------------------------
  useEffect(() => {
    if (!service) return;
    const ctrl = new AbortController();
    setBarbersLoading(true);
    setBarbers([]);
    fetchBarbers(service.id, ctrl.signal)
      .then((list) => {
        setBarbers(list);
        setBarbersError(null);
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setBarbersError(err instanceof Error ? err.message : 'No se pudieron cargar los barberos.');
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setBarbersLoading(false);
      });
    return () => ctrl.abort();
  }, [service]);

  // --- Disponibilidad (cambia con barbero, fecha o recarga tras 409) -------
  useEffect(() => {
    if (!service || !barber || !date) return;
    const ctrl = new AbortController();
    setSlotsLoading(true);
    setSlots([]);
    setSlot(null);
    fetchAvailability(barber.id, service.id, date, ctrl.signal)
      .then((list) => {
        setSlots(list);
        setSlotsError(null);
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setSlotsError(err instanceof Error ? err.message : 'No se pudo cargar la disponibilidad.');
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setSlotsLoading(false);
      });
    return () => ctrl.abort();
  }, [service, barber, date, slotsReload]);

  // --- Acciones ------------------------------------------------------------
  const goTo = (target: Exclude<Step, 'done'>) => {
    setSubmitError(null);
    setStep(target);
    rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const chooseBarber = (b: ApiBarber) => {
    setBarber(b);
    setSlot(null);
    setConflictNotice(null);
    goTo(3);
  };

  const chooseSlot = (s: ApiSlot) => {
    setSlot(s);
    setConflictNotice(null);
    goTo(4);
  };

  const submitContact = (e: React.FormEvent) => {
    e.preventDefault();
    const errors = validateForm(form);
    setFormErrors(errors);
    if (Object.keys(errors).length === 0) goTo(5);
  };

  const confirm = async () => {
    if (!service || !barber || !slot) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const appointment = await createAppointment({
        barberId: barber.id,
        serviceId: service.id,
        startDatetime: slot.start,
        clientName: form.clientName.trim(),
        clientPhone: normalizePhone(form.clientPhone),
        clientEmail: form.clientEmail.trim() || undefined,
        clientNote: form.clientNote.trim() || undefined,
      });
      setResult(appointment);
      setStep('done');
      rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // El horario se ocupó mientras el cliente llenaba el formulario.
        setConflictNotice(
          `El horario de las ${slot.startLocal} acaba de ocuparse. Elige otro, por favor.`,
        );
        setSlotsReload((n) => n + 1);
        goTo(3);
      } else if (err instanceof ApiError && err.status === 422) {
        setConflictNotice(err.message);
        setSlotsReload((n) => n + 1);
        goTo(3);
      } else {
        setSubmitError(
          err instanceof Error ? err.message : 'No se pudo crear la reserva. Intenta de nuevo.',
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setService(null);
    setBarber(null);
    setSlot(null);
    setDate(todayInBogota());
    setForm(EMPTY_FORM);
    setFormErrors({});
    setResult(null);
    setSubmitError(null);
    setConflictNotice(null);
    setStep(1);
  };

  // --- Render --------------------------------------------------------------
  const whatsappUrl =
    result && barber && service
      ? buildWhatsAppUrl(
          barber.phoneWhatsapp,
          buildAppointmentConfirmationMessage({
            barberName: barber.name,
            serviceName: service.name,
            startDatetime: new Date(result.startDatetime),
            clientName: result.clientName,
            confirmationToken: result.confirmationToken,
          }),
        )
      : null;

  return (
    <div
      ref={rootRef}
      data-booking-widget
      className="w-full bg-zinc-950/80 backdrop-blur-sm border border-white/10 rounded-2xl p-5 sm:p-8 text-white scroll-mt-24"
    >
      {step !== 'done' && (
        <>
          <StepHeader current={step} onNavigate={goTo} maxReached={maxReached(service, barber, slot)} />
          <SelectionSummary service={service} barber={barber} slot={slot} onChange={goTo} />
        </>
      )}

      {conflictNotice && step === 3 && (
        <Notice tone="warning" onClose={() => setConflictNotice(null)}>
          {conflictNotice}
        </Notice>
      )}

      {step === 1 && (
        <section aria-labelledby="bw-step1">
          <h3 id="bw-step1" className="font-serif text-xl md:text-2xl font-bold text-[#D4AF37] mb-4">
            ¿Qué servicio quieres?
          </h3>
          {servicesError && <Notice tone="error">{servicesError}</Notice>}
          {servicesLoading ? (
            <SkeletonGrid count={6} />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {services.map((s) => (
                <button key={s.id} type="button" className={card} onClick={() => selectService(s)} data-service-option={s.id}>
                  <div className="flex justify-between items-start gap-3 mb-1">
                    <span className="font-semibold text-white group-hover:text-[#D4AF37] transition-colors">{s.name}</span>
                    <span className="text-[#D4AF37] font-bold whitespace-nowrap">{formatPrice(s.defaultPrice)}</span>
                  </div>
                  {s.description && <p className="text-zinc-400 text-sm leading-relaxed">{s.description}</p>}
                  <p className="text-zinc-500 text-xs mt-2">{s.defaultDurationMinutes} min</p>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {step === 2 && service && (
        <section aria-labelledby="bw-step2">
          <h3 id="bw-step2" className="font-serif text-xl md:text-2xl font-bold text-[#D4AF37] mb-4">
            ¿Con quién?
          </h3>
          {barbersError && <Notice tone="error">{barbersError}</Notice>}
          {barbersLoading ? (
            <SkeletonGrid count={4} />
          ) : barbers.length === 0 ? (
            <p className="text-zinc-400">Ningún barbero ofrece este servicio por ahora.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {barbers.map((b) => (
                <button key={b.id} type="button" className={`${card} flex items-center gap-4`} onClick={() => chooseBarber(b)} data-barber-option={b.id}>
                  <span className="w-14 h-14 rounded-full overflow-hidden shrink-0 border border-white/10 group-hover:border-[#D4AF37] transition-colors bg-zinc-800">
                    {b.photoUrl && <img src={b.photoUrl} alt="" className="w-full h-full object-cover" loading="lazy" />}
                  </span>
                  <span>
                    <span className="block font-semibold text-white group-hover:text-[#D4AF37] transition-colors">{b.name}</span>
                    <span className="block text-xs tracking-widest uppercase text-zinc-500">{b.role}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {step === 3 && service && barber && (
        <section aria-labelledby="bw-step3">
          <h3 id="bw-step3" className="font-serif text-xl md:text-2xl font-bold text-[#D4AF37] mb-4">
            ¿Cuándo?
          </h3>
          <div className="mb-6 max-w-xs">
            <label htmlFor="bw-date" className={label}>Fecha</label>
            <input
              id="bw-date"
              type="date"
              className={`${input} [color-scheme:dark]`}
              value={date}
              min={minDate}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <p className={label}>Horarios disponibles</p>
          {slotsError && <Notice tone="error">{slotsError}</Notice>}
          {slotsLoading ? (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2" aria-busy="true" data-slots-loading>
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-11 rounded-md bg-zinc-800/60 animate-pulse" />
              ))}
            </div>
          ) : slots.length === 0 ? (
            <p className="text-zinc-400" data-no-slots>No hay horarios disponibles ese día. Prueba otra fecha.</p>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2" data-slots>
              {slots.map((s) => (
                <button
                  key={s.start}
                  type="button"
                  onClick={() => chooseSlot(s)}
                  data-slot={s.startLocal}
                  className="h-11 rounded-md border border-white/10 bg-zinc-900/60 text-sm font-semibold tracking-wider hover:border-[#D4AF37] hover:text-[#D4AF37] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#D4AF37]"
                >
                  {s.startLocal}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {step === 4 && slot && (
        <form onSubmit={submitContact} noValidate aria-labelledby="bw-step4">
          <h3 id="bw-step4" className="font-serif text-xl md:text-2xl font-bold text-[#D4AF37] mb-4">
            Tus datos
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field id="clientName" label="Nombre completo" error={formErrors.clientName}>
              <input id="clientName" name="clientName" className={input} autoComplete="name" value={form.clientName} onChange={(e) => setForm({ ...form, clientName: e.target.value })} placeholder="Juan Pérez" />
            </Field>
            <Field id="clientPhone" label="Celular (WhatsApp)" error={formErrors.clientPhone}>
              <input id="clientPhone" name="clientPhone" className={input} type="tel" inputMode="tel" autoComplete="tel" value={form.clientPhone} onChange={(e) => setForm({ ...form, clientPhone: e.target.value })} placeholder="314 291 5681" />
            </Field>
            <Field id="clientEmail" label="Correo (opcional)" error={formErrors.clientEmail} hint="Te enviamos la confirmación y el enlace para cancelar.">
              <input id="clientEmail" name="clientEmail" className={input} type="email" autoComplete="email" value={form.clientEmail} onChange={(e) => setForm({ ...form, clientEmail: e.target.value })} placeholder="tu@correo.com" />
            </Field>
            <Field id="clientNote" label="Nota (opcional)" error={formErrors.clientNote} className="sm:col-span-2">
              <textarea id="clientNote" name="clientNote" className={`${input} min-h-[88px]`} maxLength={500} value={form.clientNote} onChange={(e) => setForm({ ...form, clientNote: e.target.value })} placeholder="¿Algo que el barbero deba saber?" />
            </Field>
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-4">
            <button type="submit" className={btnPrimary}>Continuar</button>
            <button type="button" className={btnGhost} onClick={() => goTo(3)}>← Cambiar horario</button>
          </div>
        </form>
      )}

      {step === 5 && service && barber && slot && (
        <section aria-labelledby="bw-step5">
          <h3 id="bw-step5" className="font-serif text-xl md:text-2xl font-bold text-[#D4AF37] mb-4">
            Confirma tu reserva
          </h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm bg-zinc-900/60 border border-white/10 rounded-xl p-5 mb-6" data-review>
            <Row term="Servicio">{service.name}</Row>
            <Row term="Precio">{formatPrice(service.defaultPrice)}</Row>
            <Row term="Barbero">{barber.name}</Row>
            <Row term="Duración">{service.defaultDurationMinutes} min</Row>
            <Row term="Fecha">{formatBogotaDate(new Date(slot.start))}</Row>
            <Row term="Hora">{formatBogotaTime(new Date(slot.start))}</Row>
            <Row term="Nombre">{form.clientName.trim()}</Row>
            <Row term="Celular">{normalizePhone(form.clientPhone)}</Row>
            {form.clientEmail.trim() && <Row term="Correo">{form.clientEmail.trim()}</Row>}
            {form.clientNote.trim() && <Row term="Nota">{form.clientNote.trim()}</Row>}
          </dl>
          {submitError && <Notice tone="error">{submitError}</Notice>}
          <div className="flex flex-wrap items-center gap-4">
            <button type="button" className={btnPrimary} onClick={confirm} disabled={submitting} data-confirm>
              {submitting ? 'Reservando…' : 'Confirmar reserva'}
            </button>
            <button type="button" className={btnGhost} onClick={() => goTo(4)} disabled={submitting}>← Editar datos</button>
          </div>
        </section>
      )}

      {step === 'done' && result && service && barber && whatsappUrl && (
        <section aria-labelledby="bw-done" className="text-center py-4" data-done>
          <div className="mx-auto w-16 h-16 rounded-full border-2 border-[#D4AF37] flex items-center justify-center mb-5">
            <svg className="w-8 h-8 text-[#D4AF37]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h3 id="bw-done" className="font-serif text-2xl md:text-3xl font-bold text-[#D4AF37] uppercase tracking-widest mb-2">
            ¡Reserva confirmada!
          </h3>
          <p className="text-zinc-400 mb-6">
            Te esperamos, <span className="text-white font-semibold">{result.clientName}</span>.
          </p>
          <dl className="inline-grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-left text-sm bg-zinc-900/60 border border-white/10 rounded-xl p-5 mb-6">
            <Row term="Servicio">{service.name}</Row>
            <Row term="Barbero">{barber.name}</Row>
            <Row term="Fecha">{formatBogotaDate(new Date(result.startDatetime))}</Row>
            <Row term="Hora">{formatBogotaTime(new Date(result.startDatetime))}</Row>
            <Row term="Precio">{formatPrice(result.price)}</Row>
            <Row term="Código">
              <span className="font-mono tracking-wider" data-token>{result.confirmationToken.slice(0, 8).toUpperCase()}</span>
            </Row>
          </dl>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <a
              href={whatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`${btnPrimary} gap-2`}
              data-whatsapp
            >
              <WhatsAppIcon />
              Confirmar por WhatsApp
            </a>
            <button type="button" className={btnGhost} onClick={reset}>Reservar otra cita</button>
          </div>
          <p className="text-zinc-500 text-xs mt-6">
            {result.clientEmail ? 'Te enviamos la confirmación a tu correo. ' : ''}
            Puedes{' '}
            <a href={`/citas/${result.confirmationToken}`} className="text-[#D4AF37] hover:underline" data-view-link>
              ver o cancelar tu cita aquí
            </a>
            .
          </p>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-componentes
// ---------------------------------------------------------------------------

function maxReached(service: ApiService | null, barber: ApiBarber | null, slot: ApiSlot | null): Exclude<Step, 'done'> {
  if (slot) return 4;
  if (barber) return 3;
  if (service) return 2;
  return 1;
}

function StepHeader({
  current,
  maxReached,
  onNavigate,
}: {
  current: Exclude<Step, 'done'>;
  maxReached: Exclude<Step, 'done'>;
  onNavigate: (s: Exclude<Step, 'done'>) => void;
}) {
  return (
    <ol className="flex items-center gap-2 mb-6 overflow-x-auto pb-1" aria-label="Pasos de la reserva">
      {STEPS.map(({ n, label: text }, i) => {
        const done = n < current;
        const active = n === current;
        const reachable = n <= maxReached;
        return (
          <li key={n} className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={!reachable || active}
              onClick={() => onNavigate(n)}
              aria-current={active ? 'step' : undefined}
              className={`flex items-center gap-2 text-xs tracking-widest uppercase transition-colors ${
                active ? 'text-[#D4AF37]' : done ? 'text-zinc-300 hover:text-[#D4AF37]' : 'text-zinc-600'
              } disabled:cursor-default`}
            >
              <span
                className={`w-6 h-6 rounded-full border flex items-center justify-center text-[10px] font-bold ${
                  active
                    ? 'border-[#D4AF37] bg-[#D4AF37] text-black'
                    : done
                      ? 'border-[#D4AF37] text-[#D4AF37]'
                      : 'border-zinc-700'
                }`}
              >
                {done ? '✓' : n}
              </span>
              {/* Solo el paso activo muestra su nombre; los demás quedan como círculos numerados. */}
              <span className={active ? 'inline' : 'sr-only'}>{text}</span>
            </button>
            {i < STEPS.length - 1 && <span className="w-4 h-px bg-zinc-700" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}

function SelectionSummary({
  service,
  barber,
  slot,
  onChange,
}: {
  service: ApiService | null;
  barber: ApiBarber | null;
  slot: ApiSlot | null;
  onChange: (s: Exclude<Step, 'done'>) => void;
}) {
  if (!service) return null;
  const chip = 'inline-flex items-center gap-2 bg-zinc-900/60 border border-white/10 rounded-full px-3 py-1 text-xs';
  return (
    <div className="flex flex-wrap gap-2 mb-6" data-summary>
      <span className={chip}>
        <span className="text-zinc-500 uppercase tracking-widest">Servicio</span>
        <span className="text-white">{service.name}</span>
        <button type="button" className="text-[#D4AF37] hover:underline" onClick={() => onChange(1)}>cambiar</button>
      </span>
      {barber && (
        <span className={chip}>
          <span className="text-zinc-500 uppercase tracking-widest">Barbero</span>
          <span className="text-white">{barber.name}</span>
          <button type="button" className="text-[#D4AF37] hover:underline" onClick={() => onChange(2)}>cambiar</button>
        </span>
      )}
      {slot && (
        <span className={chip}>
          <span className="text-zinc-500 uppercase tracking-widest">Cita</span>
          <span className="text-white">
            {formatBogotaDate(new Date(slot.start))} · {slot.startLocal}
          </span>
          <button type="button" className="text-[#D4AF37] hover:underline" onClick={() => onChange(3)}>cambiar</button>
        </span>
      )}
    </div>
  );
}

function Notice({
  tone,
  children,
  onClose,
}: {
  tone: 'error' | 'warning';
  children: React.ReactNode;
  onClose?: () => void;
}) {
  const styles =
    tone === 'error'
      ? 'border-red-500/40 bg-red-500/10 text-red-200'
      : 'border-[#D4AF37]/40 bg-[#D4AF37]/10 text-[#F5E6A3]';
  return (
    <div role="alert" className={`flex items-start justify-between gap-4 border rounded-md px-4 py-3 text-sm mb-4 ${styles}`} data-notice={tone}>
      <span>{children}</span>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Cerrar aviso" className="opacity-70 hover:opacity-100">
          ×
        </button>
      )}
    </div>
  );
}

function SkeletonGrid({ count }: { count: number }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" aria-busy="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="h-24 rounded-xl bg-zinc-800/60 animate-pulse" />
      ))}
    </div>
  );
}

function Field({
  id,
  label: text,
  error,
  hint,
  className = '',
  children,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <label htmlFor={id} className={label}>{text}</label>
      {children}
      {error ? (
        <p className="text-red-300 text-xs mt-1" role="alert">{error}</p>
      ) : hint ? (
        <p className="text-zinc-500 text-xs mt-1">{hint}</p>
      ) : null}
    </div>
  );
}

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-zinc-500 uppercase tracking-widest text-xs self-center">{term}</dt>
      <dd className="text-white">{children}</dd>
    </div>
  );
}

function WhatsAppIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z" />
    </svg>
  );
}
