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
`/api/panel/**`, y expone `Astro.locals.user = { id, username, role, barberId }`.

Un barbero **desactivado** desde el panel (`barbers.is_active = false`) no
puede iniciar sesión: `POST /api/auth/login` responde igual que con una
contraseña incorrecta. Al reactivarlo entra con la misma contraseña.

## Reglas de autorización

- `role = 'barber'` → **siempre** actúa sobre su propio `barber_id`. Cualquier
  `barberId` que envíe (query o body) se ignora. No puede crear ni borrar
  cierres globales.
- `role = 'admin'` → indica `barberId` (obligatorio en horarios; opcional en
  citas y días libres, donde vacío = todos). `barberId: null` en `time-off`
  crea un cierre para todo el negocio.
- La **gestión de barberos** (`/api/panel/barbers/**` y las páginas
  `/panel/barberos/*`) es solo para `admin`: un barbero recibe `403 FORBIDDEN`
  en los endpoints y es redirigido a `/panel` en las páginas.

Los errores de validación de estos endpoints responden `422 VALIDATION_ERROR`
con `details = { campo: [mensajes en español] }`, que el panel muestra junto a
cada campo.

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

## Barberos (solo admin)

```
GET   /api/panel/barbers                       → { barbers: [{ …barber, serviceIds, servicesCount, username }] }
POST  /api/panel/barbers                       { name, phoneWhatsapp, role?, quote?, photoUrl?, serviceIds?, username? }
PATCH /api/panel/barbers/:id                   { name?, role?, quote?, phoneWhatsapp?, photoUrl?, serviceIds? }  // edita
PATCH /api/panel/barbers/:id                   { isActive: true | false }                                        // activa / desactiva
POST  /api/panel/barbers/:id/reset-password    → { credentials: { username, password } }
```

No existe `DELETE`: un barbero se **desactiva**. Inactivo no aparece en la web
ni en `GET /api/barbers`, no acepta reservas y no puede iniciar sesión; sus
citas e historial se conservan. Al desactivarlo se cierran sus sesiones.

`GET` lista **todos** (activos e inactivos, estos últimos al final) con el
conteo de servicios ofrecidos y el usuario de login.

`POST` crea **todo en una transacción**: la fila en `barbers` (el `slug` se
deriva del nombre: "Carlos Pérez" → `carlos-perez`, y `displayOrder` va al
final), sus `barber_services` (`serviceIds`; sin el campo, todos los servicios
activos), el horario semanal por defecto (`WEEKLY_SCHEDULE` en
`src/lib/barber-defaults.ts`, el mismo del seed) y su usuario del panel con
contraseña temporal. Responde `201 { barber, credentials }`; la contraseña solo
se entrega en esa respuesta (en la DB queda el hash).

- `username`: opcional. Si no viene se deriva del nombre (sin tildes,
  minúsculas, solo letras y números: `carlosperez`; si ya existe,
  `carlosperez2`, `carlosperez3`…). Si viene y ya existe → 422 con la
  sugerencia en `details.username`.
- `phoneWhatsapp`: 10–15 dígitos; se aceptan espacios y `+57`, se guardan solo
  dígitos y a un número de 10 dígitos se le antepone `57`
  (`"314 291 5681"` → `573142915681`).
- `role`: vacío → `"Master Barber"`. `quote`: opcional, máx. 160.
- `photoUrl`: opcional; ruta dentro de `/public` que empiece por `/`
  (`/carlos.jpg`) o URL `http(s)://`. Vacío → se muestran sus iniciales.
- `bufferMinutes` no se expone (queda en 0).

`PATCH` con `serviceIds` sincroniza `barber_services` **sin borrar filas**:
inserta los nuevos, vuelve a ofrecer los re-marcados y pone
`is_offered = false` a los desmarcados (se conservan precio/duración
personalizados). Los campos ausentes no se tocan. 404 si el barbero no existe.

`POST …/reset-password` es un **rescate explícito** del admin (el panel pide
confirmación): genera otra contraseña temporal para ese barbero e invalida sus
sesiones. Nunca se llama de forma automática y nunca toca a otros usuarios.
404 `USER_NOT_FOUND` si el barbero no tiene usuario.

```sh
curl -X POST http://localhost:4321/api/panel/barbers \
  -H 'Content-Type: application/json' -b 'nlb_session=…' \
  -d '{ "name": "Carlos Pérez", "phoneWhatsapp": "314 291 5681", "quote": "Estilo con navaja" }'
```

```json
{
  "barber": { "id": 5, "name": "Carlos Pérez", "slug": "carlos-perez", "role": "Master Barber", "phoneWhatsapp": "573142915681", "photoUrl": null, "isActive": true, "displayOrder": 5, "serviceIds": [1, 2, 3, 4, 5, 6, 7, 8, 9], "servicesCount": 9, "username": "carlosperez", "…": "…" },
  "credentials": { "username": "carlosperez", "password": "zX0Dj6p4j6_P" }
}
```

## Mi cuenta (admin y barberos)

```
POST /api/panel/account/password    { currentPassword, newPassword, confirmPassword }   → { ok: true }
```

Cambia la contraseña del usuario de la sesión. Verifica la actual; la nueva
debe tener al menos 8 caracteres, ser distinta de la actual y coincidir con la
confirmación (422 con `details` por campo si no). Al cambiarla se cierran las
**demás** sesiones del usuario y la actual sigue activa.
