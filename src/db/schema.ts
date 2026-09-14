import { relations, sql } from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * Esquema de la base de datos (Turso / libSQL).
 *
 * Convenciones:
 * - Precios en pesos colombianos enteros (30000 = $30.000). Sin centavos.
 * - Fechas/horas absolutas (citas, bloqueos) en UTC como timestamp en ms.
 * - Horarios de atención en hora local de Bogotá como texto "HH:MM".
 * - day_of_week: 0 = lunes … 6 = domingo.
 */

const nowMs = sql`(unixepoch() * 1000)`;

const timestampMs = (name: string) => integer(name, { mode: 'timestamp_ms' });

const createdAt = () => timestampMs('created_at').notNull().default(nowMs);

// ---------------------------------------------------------------------------
// barbers
// ---------------------------------------------------------------------------
export const barbers = sqliteTable('barbers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  role: text('role').notNull(),
  quote: text('quote'),
  photoUrl: text('photo_url'),
  phoneWhatsapp: text('phone_whatsapp').notNull(),
  /**
   * Minutos de descanso entre citas consecutivas. Por defecto 0: los slots
   * van cada 60 min y una cita a las 10:00 no debe bloquear 09:00 ni 11:00.
   */
  bufferMinutes: integer('buffer_minutes').notNull().default(0),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  displayOrder: integer('display_order').notNull().default(0),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// services
// ---------------------------------------------------------------------------
export const services = sqliteTable('services', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  defaultDurationMinutes: integer('default_duration_minutes')
    .notNull()
    .default(60),
  /** Precio base en COP enteros. */
  defaultPrice: integer('default_price').notNull(),
  imageUrl: text('image_url'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  displayOrder: integer('display_order').notNull().default(0),
});

// ---------------------------------------------------------------------------
// barber_services — qué servicios ofrece cada barbero (con overrides)
// ---------------------------------------------------------------------------
export const barberServices = sqliteTable(
  'barber_services',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    barberId: integer('barber_id')
      .notNull()
      .references(() => barbers.id, { onDelete: 'cascade' }),
    serviceId: integer('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    /** COP enteros. Null = hereda services.default_price. */
    price: integer('price'),
    /** Null = hereda services.default_duration_minutes. */
    durationMinutes: integer('duration_minutes'),
    isOffered: integer('is_offered', { mode: 'boolean' })
      .notNull()
      .default(true),
  },
  (t) => [
    uniqueIndex('barber_services_barber_service_uq').on(
      t.barberId,
      t.serviceId,
    ),
  ],
);

// ---------------------------------------------------------------------------
// barber_schedules — horario semanal (varias filas por día = turnos partidos)
// ---------------------------------------------------------------------------
export const barberSchedules = sqliteTable(
  'barber_schedules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    barberId: integer('barber_id')
      .notNull()
      .references(() => barbers.id, { onDelete: 'cascade' }),
    /** 0 = lunes … 6 = domingo. */
    dayOfWeek: integer('day_of_week').notNull(),
    /** "HH:MM" hora local Bogotá. */
    startTime: text('start_time').notNull(),
    /** "HH:MM" hora local Bogotá (hora de cierre). */
    endTime: text('end_time').notNull(),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [
    index('barber_schedules_barber_day_idx').on(t.barberId, t.dayOfWeek),
  ],
);

// ---------------------------------------------------------------------------
// barber_time_off — vacaciones / bloqueos. barber_id null = cierre del negocio
// ---------------------------------------------------------------------------
export const barberTimeOff = sqliteTable(
  'barber_time_off',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    barberId: integer('barber_id').references(() => barbers.id, {
      onDelete: 'cascade',
    }),
    startDatetime: timestampMs('start_datetime').notNull(),
    endDatetime: timestampMs('end_datetime').notNull(),
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (t) => [
    index('barber_time_off_barber_start_idx').on(t.barberId, t.startDatetime),
  ],
);

// ---------------------------------------------------------------------------
// appointments
// ---------------------------------------------------------------------------
export const APPOINTMENT_STATUSES = [
  'pending',
  'confirmed',
  'cancelled',
  'completed',
  'no_show',
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const appointments = sqliteTable(
  'appointments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    barberId: integer('barber_id')
      .notNull()
      .references(() => barbers.id, { onDelete: 'restrict' }),
    serviceId: integer('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'restrict' }),
    clientName: text('client_name').notNull(),
    clientPhone: text('client_phone').notNull(),
    clientEmail: text('client_email'),
    clientNote: text('client_note'),
    startDatetime: timestampMs('start_datetime').notNull(),
    endDatetime: timestampMs('end_datetime').notNull(),
    /** COP enteros, congelado en el momento de reservar. */
    price: integer('price').notNull(),
    status: text('status', { enum: APPOINTMENT_STATUSES })
      .notNull()
      .default('pending'),
    cancellationReason: text('cancellation_reason'),
    confirmationToken: text('confirmation_token').notNull().unique(),
    createdAt: createdAt(),
    updatedAt: timestampMs('updated_at')
      .notNull()
      .default(nowMs)
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('appointments_barber_start_idx').on(t.barberId, t.startDatetime),
    index('appointments_status_idx').on(t.status),
    // Garantía a nivel de DB contra dobles reservas: un barbero no puede tener
    // dos citas activas que empiecen en el mismo instante (los slots están
    // alineados a la hora, así que esto cubre el caso de carrera).
    uniqueIndex('appointments_barber_start_active_uq')
      .on(t.barberId, t.startDatetime)
      .where(sql`status IN ('pending', 'confirmed')`),
  ],
);

// ---------------------------------------------------------------------------
// users — acceso al panel (admin o barbero)
// ---------------------------------------------------------------------------
export const USER_ROLES = ['admin', 'barber'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /**
   * Identificador de login. Los barberos usan un nombre simple (p. ej.
   * "oswaravendano"); el admin puede seguir usando su email. No se valida
   * formato de email.
   */
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: USER_ROLES }).notNull(),
  /** Null cuando role = 'admin'. */
  barberId: integer('barber_id').references(() => barbers.id, {
    onDelete: 'set null',
  }),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// sessions — sesiones del panel (cookie httpOnly con el token en claro; aquí
// se guarda su hash SHA-256 para que una fuga de la DB no sirva para entrar)
// ---------------------------------------------------------------------------
export const sessions = sqliteTable(
  'sessions',
  {
    /** SHA-256 (hex) del token que viaja en la cookie. */
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestampMs('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

// ---------------------------------------------------------------------------
// relations
// ---------------------------------------------------------------------------
export const barbersRelations = relations(barbers, ({ many, one }) => ({
  barberServices: many(barberServices),
  schedules: many(barberSchedules),
  timeOff: many(barberTimeOff),
  appointments: many(appointments),
  user: one(users, { fields: [barbers.id], references: [users.barberId] }),
}));

export const servicesRelations = relations(services, ({ many }) => ({
  barberServices: many(barberServices),
  appointments: many(appointments),
}));

export const barberServicesRelations = relations(barberServices, ({ one }) => ({
  barber: one(barbers, {
    fields: [barberServices.barberId],
    references: [barbers.id],
  }),
  service: one(services, {
    fields: [barberServices.serviceId],
    references: [services.id],
  }),
}));

export const barberSchedulesRelations = relations(
  barberSchedules,
  ({ one }) => ({
    barber: one(barbers, {
      fields: [barberSchedules.barberId],
      references: [barbers.id],
    }),
  }),
);

export const barberTimeOffRelations = relations(barberTimeOff, ({ one }) => ({
  barber: one(barbers, {
    fields: [barberTimeOff.barberId],
    references: [barbers.id],
  }),
}));

export const appointmentsRelations = relations(appointments, ({ one }) => ({
  barber: one(barbers, {
    fields: [appointments.barberId],
    references: [barbers.id],
  }),
  service: one(services, {
    fields: [appointments.serviceId],
    references: [services.id],
  }),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  barber: one(barbers, { fields: [users.barberId], references: [barbers.id] }),
  sessions: many(sessions),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------
export type Barber = typeof barbers.$inferSelect;
export type NewBarber = typeof barbers.$inferInsert;
export type Service = typeof services.$inferSelect;
export type NewService = typeof services.$inferInsert;
export type BarberService = typeof barberServices.$inferSelect;
export type NewBarberService = typeof barberServices.$inferInsert;
export type BarberSchedule = typeof barberSchedules.$inferSelect;
export type NewBarberSchedule = typeof barberSchedules.$inferInsert;
export type BarberTimeOff = typeof barberTimeOff.$inferSelect;
export type NewBarberTimeOff = typeof barberTimeOff.$inferInsert;
export type Appointment = typeof appointments.$inferSelect;
export type NewAppointment = typeof appointments.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
