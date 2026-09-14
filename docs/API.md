# API de reservas

Todos los endpoints responden JSON. Los errores tienen la forma
`{ "error": { "code", "message", "details?" } }`.

Convenciones:

- `startDatetime` / `endDatetime` siempre en **UTC** (ISO 8601).
- `startLocal` / `endLocal` en hora local de **Bogotá** (`"HH:MM"`).
- Precios en pesos colombianos enteros (`40000` = $40.000).
- Los slots van **cada 60 minutos alineados a la apertura** (09:00, 10:00, …).
  La duración y el precio se calculan siempre en el servidor.

## GET /api/services

Servicios activos ordenados por `displayOrder`.

```sh
curl http://localhost:4321/api/services
```

## GET /api/barbers?serviceId=

Barberos activos. Con `serviceId`, solo los que ofrecen ese servicio
(`barber_services.is_offered = true`).

```sh
curl "http://localhost:4321/api/barbers?serviceId=3"
```

## GET /api/availability?barberId=&serviceId=&date=YYYY-MM-DD

Slots disponibles para ese día (hora local Bogotá). Descarta citas activas
(`pending`/`confirmed`), bloqueos (`barber_time_off`, propios o globales) y
horas ya pasadas. Una cita solo ocupa su propio slot: reservar 10:00 deja
09:00 y 11:00 disponibles (`barbers.buffer_minutes` es 0 por defecto; si se
configura un valor mayor, la cita se expande ese tiempo en ambos extremos).

```sh
curl "http://localhost:4321/api/availability?barberId=1&serviceId=3&date=2026-10-14"
```

```json
{
  "barberId": 1, "serviceId": 3, "date": "2026-10-14", "timezone": "America/Bogota",
  "slots": [
    { "start": "2026-10-14T14:00:00.000Z", "end": "2026-10-14T15:00:00.000Z", "startLocal": "09:00", "endLocal": "10:00" },
    { "start": "2026-10-14T15:00:00.000Z", "end": "2026-10-14T16:00:00.000Z", "startLocal": "10:00", "endLocal": "11:00" }
  ]
}
```

## POST /api/appointments

Crea una cita con `status: "confirmed"`.

```sh
curl -X POST http://localhost:4321/api/appointments \
  -H 'Content-Type: application/json' \
  -d '{
    "barberId": 1,
    "serviceId": 3,
    "startDatetime": "2026-10-14T15:00:00.000Z",
    "clientName": "Juan Pérez",
    "clientPhone": "573001234567",
    "clientEmail": "juan@example.com",
    "clientNote": "Opcional"
  }'
```

| Código | Cuándo                                                                 |
| ------ | ---------------------------------------------------------------------- |
| 201    | Creada. Devuelve `{ id, confirmationToken, status, price, … }`.        |
| 400    | Body inválido (`VALIDATION_ERROR`, con `details` por campo).           |
| 404    | Barbero/servicio inexistente, inactivo o no ofrecido por ese barbero.  |
| 409    | `SLOT_TAKEN`: el horario ya está ocupado (cita o bloqueo).             |
| 422    | `SLOT_OUTSIDE_SCHEDULE`: la hora no es un turno válido del horario.    |

Tras confirmar la transacción se envía un email al dueño (`NOTIFY_EMAIL`) y,
si el cliente dejó correo, una confirmación con el enlace `/citas/<token>`.

La verificación de solape se repite **dentro de una transacción** antes de
insertar, y la base de datos tiene un índice único parcial
(`barber_id`, `start_datetime`) sobre citas activas, así que dos solicitudes
simultáneas nunca reservan el mismo turno: una recibe 201 y la otra 409.

## Página pública /citas/:token

Vista de la cita para el cliente (enlace que llega en los emails y en la
pantalla de confirmación del widget), con botón para cancelar. Usa los dos
endpoints siguientes.

## GET /api/appointments/:token

Detalle de la cita (con barbero y servicio) usando el `confirmationToken`.
404 si el token no existe.

```sh
curl http://localhost:4321/api/appointments/<confirmationToken>
```

## PATCH /api/appointments/:token

Cancela la cita. Envía aviso de cancelación por email al dueño y al cliente
(si dejó correo). Idempotente: si ya estaba cancelada responde 200 con
`alreadyCancelled: true`. 422 si está `completed` o `no_show`.

```sh
curl -X PATCH http://localhost:4321/api/appointments/<confirmationToken> \
  -H 'Content-Type: application/json' \
  -d '{ "action": "cancel", "reason": "No puedo asistir" }'
```

---

# Panel (requiere sesión)

## Autenticación

| Endpoint                | Descripción                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/login`  | Formulario (`username`, `password`, `next?`) → 303 a `next`/`/panel` o `/login?error=…`. JSON → `{ user }` o 401. `username` es un nombre simple (barberos) o un email (admin); no se valida formato. |
| `POST /api/auth/logout` | Invalida la sesión y borra la cookie. 303 a `/login` (o `{ ok: true }` con `Accept: application/json`).       |

La sesión viaja en la cookie `nlb_session` (httpOnly, SameSite=Lax, 30 días con
renovación deslizante). En la DB (`sessions`) solo se guarda el SHA-256 del
token. Las contraseñas se almacenan con **bcrypt**; los hashes scrypt del seed
inicial se migran automáticamente en el primer inicio de sesión.

`src/middleware.ts` redirige `/panel/**` a `/login` sin sesión, responde 401 en
`/api/panel/**`, y expone `Astro.locals.user = { id, email, role, barberId }`.

## Reglas de autorización

- `role = 'barber'` → **siempre** actúa sobre su propio `barber_id`. Cualquier
  `barberId` que envíe (query o body) se ignora. No puede crear ni borrar
  cierres globales.
- `role = 'admin'` → indica `barberId` (obligatorio en horarios; opcional en
  citas y días libres, donde vacío = todos). `barberId: null` en `time-off`
  crea un cierre para todo el negocio.

> Los endpoints del panel están protegidos por CSRF (`checkOrigin` de Astro):
> las peticiones desde fuera del navegador deben enviar
> `Content-Type: application/json`.

## Citas

```
GET   /api/panel/appointments?barberId=&status=&from=YYYY-MM-DD&to=YYYY-MM-DD
PATCH /api/panel/appointments/:id     { status: 'confirmed'|'cancelled'|'completed'|'no_show', reason? }
```

409 al re-confirmar una cita cancelada cuyo horario ya tiene otra cita activa.

## Horario semanal

```
GET    /api/panel/schedules?barberId=
PUT    /api/panel/schedules            { barberId?, days: [{ dayOfWeek, ranges: [{ startTime, endTime }] }] }  // reemplaza la semana
POST   /api/panel/schedules            { barberId?, dayOfWeek, startTime, endTime }                              // agrega una franja
PATCH  /api/panel/schedules/:id        { startTime?, endTime?, isActive? }
DELETE /api/panel/schedules/:id
```

Validaciones (422): `HH:MM`, inicio < fin, sin solapes dentro del mismo día.
Un día sin franjas queda cerrado.

## Días libres / bloqueos

```
GET    /api/panel/time-off?barberId=&includePast=1
POST   /api/panel/time-off             { barberId?, startLocal: 'YYYY-MM-DDTHH:MM', endLocal, reason? }  // hora local Bogotá
DELETE /api/panel/time-off/:id
```
