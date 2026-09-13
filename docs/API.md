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
(`pending`/`confirmed`) expandidas por `barbers.buffer_minutes`, bloqueos
(`barber_time_off`, propios o globales) y horas ya pasadas.

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

La verificación de solape se repite **dentro de una transacción** antes de
insertar, y la base de datos tiene un índice único parcial
(`barber_id`, `start_datetime`) sobre citas activas, así que dos solicitudes
simultáneas nunca reservan el mismo turno: una recibe 201 y la otra 409.

## GET /api/appointments/:token

Detalle de la cita (con barbero y servicio) usando el `confirmationToken`.
404 si el token no existe.

```sh
curl http://localhost:4321/api/appointments/<confirmationToken>
```

## PATCH /api/appointments/:token

Cancela la cita. Idempotente: si ya estaba cancelada responde 200 con
`alreadyCancelled: true`. 422 si está `completed` o `no_show`.

```sh
curl -X PATCH http://localhost:4321/api/appointments/<confirmationToken> \
  -H 'Content-Type: application/json' \
  -d '{ "action": "cancel", "reason": "No puedo asistir" }'
```
