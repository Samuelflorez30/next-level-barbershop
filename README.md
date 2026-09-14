# Next Level Barbershop

Sitio web y sistema de reservas de Next Level Barbershop (Neiva, Huila).

- **Frontend**: Astro 7 + Tailwind CSS v4 (React solo para la isla del
  widget de reservas, `src/components/booking/`)
- **Backend**: Astro en modo servidor desplegado en Vercel
- **Base de datos**: Turso (SQLite/libSQL) con Drizzle ORM
- **Panel** (`/login` → `/panel`): cada barbero gestiona su horario, días
  libres y citas; el admin gestiona los de todos.
- **Emails** (Resend): aviso al dueño por cada reserva, confirmación al
  cliente y avisos de cancelación. Opcional: sin `RESEND_API_KEY` el sitio
  funciona igual.

## Primeros pasos

```sh
npm install
cp .env.example .env   # y completa las credenciales de Turso
npm run db:migrate
npm run db:seed
npm run dev
```

La guía completa para crear la base de datos en Turso, correr migraciones,
cargar los datos iniciales y desplegar en Vercel está en
[`docs/SETUP.md`](docs/SETUP.md). Los endpoints de reservas están
documentados en [`docs/API.md`](docs/API.md).

## Comandos

| Comando               | Acción                                                  |
| :-------------------- | :------------------------------------------------------ |
| `npm run dev`         | Servidor de desarrollo en `localhost:4321`              |
| `npm run build`       | Build de producción (salida para Vercel)                |
| `npm run preview`     | Previsualiza el build localmente                        |
| `npm run db:generate` | Genera una migración SQL a partir de `src/db/schema.ts` |
| `npm run db:migrate`  | Aplica las migraciones pendientes                       |
| `npm run db:push`     | Sincroniza el esquema sin migración (solo desarrollo)   |
| `npm run db:seed`     | Carga barberos, servicios, horarios y usuarios iniciales |
| `npm run db:studio`   | Abre Drizzle Studio                                     |
| `npm test`            | Corre los tests (Vitest) contra una SQLite temporal     |

## Estructura

```
src/
├── components/   # secciones de la landing (Team, Services, Reservation…)
│   └── booking/  # BookingWidget.tsx (React) + cliente de la API
├── db/           # schema.ts, client.ts, seed.ts
├── layouts/      # Layout.astro (sitio) y PanelLayout.astro (panel)
├── middleware.ts # sesión + protección de /panel y /api/panel
├── lib/          # availability.ts, appointments.ts, time.ts, whatsapp.ts, api.ts, password.ts
├── pages/
│   ├── api/      # endpoints REST públicos, auth y panel (ver docs/API.md)
│   └── panel/    # dashboard, horario, días libres
├── styles/
└── test/         # helpers de test + tests de integración de la API
drizzle/          # migraciones SQL
docs/             # SETUP.md (configuración), API.md (endpoints)
```
