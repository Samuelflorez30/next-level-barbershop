DROP INDEX "appointments_confirmation_token_unique";--> statement-breakpoint
DROP INDEX "appointments_barber_start_idx";--> statement-breakpoint
DROP INDEX "appointments_status_idx";--> statement-breakpoint
DROP INDEX "appointments_barber_start_active_uq";--> statement-breakpoint
DROP INDEX "barber_schedules_barber_day_idx";--> statement-breakpoint
DROP INDEX "barber_services_barber_service_uq";--> statement-breakpoint
DROP INDEX "barber_time_off_barber_start_idx";--> statement-breakpoint
DROP INDEX "barbers_slug_unique";--> statement-breakpoint
DROP INDEX "services_slug_unique";--> statement-breakpoint
DROP INDEX "users_email_unique";--> statement-breakpoint
ALTER TABLE `barbers` ALTER COLUMN "buffer_minutes" TO "buffer_minutes" integer NOT NULL DEFAULT 0;--> statement-breakpoint
CREATE UNIQUE INDEX `appointments_confirmation_token_unique` ON `appointments` (`confirmation_token`);--> statement-breakpoint
CREATE INDEX `appointments_barber_start_idx` ON `appointments` (`barber_id`,`start_datetime`);--> statement-breakpoint
CREATE INDEX `appointments_status_idx` ON `appointments` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `appointments_barber_start_active_uq` ON `appointments` (`barber_id`,`start_datetime`) WHERE status IN ('pending', 'confirmed');--> statement-breakpoint
CREATE INDEX `barber_schedules_barber_day_idx` ON `barber_schedules` (`barber_id`,`day_of_week`);--> statement-breakpoint
CREATE UNIQUE INDEX `barber_services_barber_service_uq` ON `barber_services` (`barber_id`,`service_id`);--> statement-breakpoint
CREATE INDEX `barber_time_off_barber_start_idx` ON `barber_time_off` (`barber_id`,`start_datetime`);--> statement-breakpoint
CREATE UNIQUE INDEX `barbers_slug_unique` ON `barbers` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `services_slug_unique` ON `services` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
UPDATE `barbers` SET `buffer_minutes` = 0;
