# Configuración del backend (Turso + Drizzle + Vercel)

Este proyecto usa **Turso** (SQLite/libSQL en la nube) como base de datos,
**Drizzle ORM** para el esquema y las migraciones, y el adaptador de **Vercel**
para desplegar Astro en modo servidor.

## 1. Requisitos

- Node.js ≥ 22.12 (`node -v`)
- Cuenta en [Turso](https://turso.tech) (plan gratuito es suficiente)
- Turso CLI:

```sh
brew install tursodatabase/tap/turso
# o: curl -sSfL https://get.tur.so/install.sh | bash
turso auth login
```

## 2. Crear la base de datos en Turso

```sh
# Crea la base de datos (elige la región más cercana a Colombia, p. ej. gru = São Paulo)
turso db create next-level-barbershop --location gru

# URL de conexión → TURSO_DATABASE_URL
turso db show next-level-barbershop --url

# Token de acceso → TURSO_AUTH_TOKEN
turso db tokens create next-level-barbershop
```

## 3. Variables de entorno

Copia `.env.example` a `.env` y pega los valores anteriores:

```sh
cp .env.example .env
```

```dotenv
TURSO_DATABASE_URL=libsql://next-level-barbershop-<tu-org>.turso.io
TURSO_AUTH_TOKEN=eyJ...
```

`.env` está en `.gitignore`; nunca lo subas al repositorio.

### Desarrollo local sin Turso

Puedes trabajar contra un archivo SQLite local (también ignorado por git):

```dotenv
TURSO_DATABASE_URL=file:local.db
TURSO_AUTH_TOKEN=
```

Todos los comandos siguientes funcionan igual con esta configuración.

### Notificaciones por email (Resend)

1. Crea una cuenta en [resend.com](https://resend.com) y una API key.
2. En `.env`:

```dotenv
RESEND_API_KEY=re_xxxxxxxx
RESEND_FROM_EMAIL=onboarding@resend.dev   # o reservas@barbernextlevel.com cuando el dominio esté verificado
NOTIFY_EMAIL=reservasnextlevel@gmail.com
PUBLIC_SITE_URL=https://barbernextlevel.com
```

> Con `onboarding@resend.dev` Resend **solo entrega al correo de tu propia
> cuenta**; para escribir a clientes verifica el dominio en Resend → Domains y
> cambia `RESEND_FROM_EMAIL`.

Se envían: aviso al dueño por cada reserva, confirmación al cliente (si dejó
correo) y aviso de cancelación (dueño + cliente) tanto desde el enlace del
cliente como desde el panel. Si `RESEND_API_KEY` está vacío, todo sigue
funcionando y solo aparece un aviso en la consola del servidor; un error de
Resend nunca revierte ni bloquea una reserva.

## 4. Aplicar el esquema (migraciones)

Las migraciones SQL viven en `drizzle/` y se generan a partir de
`src/db/schema.ts`.

```sh
npm run db:migrate     # aplica las migraciones pendientes a la base de datos
```

Cuando cambies `src/db/schema.ts`:

```sh
npm run db:generate    # crea un nuevo archivo SQL en drizzle/
npm run db:migrate     # lo aplica
```

Atajos útiles:

| Comando             | Qué hace                                                             |
| ------------------- | -------------------------------------------------------------------- |
| `npm run db:push`   | Sincroniza el esquema directamente sin generar migración (solo dev). |
| `npm run db:studio` | Abre Drizzle Studio para ver/editar datos en el navegador.           |

## 5. Cargar los datos iniciales (seed)

```sh
npm run db:seed
```

Inserta:

- 4 barberos (Oswar Avendaño, Stiven Tapia, Jesus Montoya, Jesus Toro)
- 9 servicios con precio en COP y duración de 60 min
- `barber_services`: todos los barberos ofrecen todos los servicios
- Horario semanal por barbero: lunes–sábado 09:00–21:00, domingo 10:00–21:00
- Usuario **admin** (`reservasnextlevel@gmail.com`) y un usuario por barbero

Al terminar imprime en consola una tabla con las **contraseñas temporales**.
Guárdalas: no se vuelven a mostrar. Con ellas entras al panel en `/login`
(el admin ve y edita a todos los barberos; cada barbero solo lo suyo).

El seed es idempotente: puedes ejecutarlo varias veces. Los usuarios que ya
existen conservan su contraseña. Para regenerarlas:

```sh
SEED_RESET_PASSWORDS=1 npm run db:seed
```

> El login no valida formato de email: los barberos usan su nombre de usuario
> simple y el admin su correo. Si la base tiene usuarios de un seed anterior
> (`<slug>@barbernextlevel.com`), el seed los renombra en sitio.

## 6. Tests

```sh
npm test
```

Cada archivo de test crea su propia base de datos SQLite temporal (en el
directorio temporal del sistema), aplica las migraciones de `drizzle/` y la
borra al terminar. No necesita Turso ni toca `.env`.

## 7. Desplegar en Vercel

El proyecto ya está configurado con `@astrojs/vercel` (`output: 'server'`).
La landing (`/`) se renderiza en el servidor (lee barberos y servicios de la
base de datos) con `Cache-Control: s-maxage=60`, así que el CDN de Vercel la
sirve cacheada y los cambios aparecen en ≤ 1 minuto. Las rutas `/api/*` son
funciones serverless. Por eso `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN` deben
existir en el entorno de **runtime** de Vercel, no solo en el build.

Configura las variables de entorno en Vercel (Project → Settings →
Environment Variables) o con la CLI:

```sh
vercel link
vercel env add TURSO_DATABASE_URL production
vercel env add TURSO_AUTH_TOKEN production
```

Luego `vercel --prod` o un push a `main` si el proyecto está conectado a GitHub.

## Estructura

```
drizzle.config.ts      # configuración de drizzle-kit (lee .env)
drizzle/               # migraciones SQL generadas (commitear)
src/db/schema.ts       # definición de tablas, relaciones y tipos
src/db/client.ts       # instancia única de Drizzle conectada a Turso
src/db/seed.ts         # datos iniciales
src/lib/password.ts    # hash/verificación de contraseñas (scrypt)
src/lib/time.ts        # conversión hora local Bogotá ⇄ UTC
src/lib/availability.ts# cálculo de slots disponibles
src/lib/appointments.ts# crear / consultar / cancelar citas
src/lib/whatsapp.ts    # enlaces y mensajes de WhatsApp (servidor y navegador)
src/lib/notifications.ts # emails con Resend (nunca lanzan)
src/lib/auth.ts        # login, sesiones (tabla sessions) y cookie
src/lib/panel.ts       # autorización por rol + horarios / días libres / citas
src/middleware.ts      # protege /panel/** y /api/panel/**, expone locals.user
src/pages/panel/       # dashboard, horario, días libres (Astro + JS plano)
src/pages/citas/       # /citas/<token>: el cliente ve y cancela su cita (enlace de los emails)
src/components/booking # BookingWidget.tsx (isla React) + cliente de la API
src/pages/api/         # endpoints REST (ver docs/API.md)
src/test/              # helpers de test y tests de integración de la API
```

## Convenciones del esquema

- **Precios**: enteros en pesos colombianos (`30000` = $30.000). Sin centavos.
  Para mostrar: `new Intl.NumberFormat('es-CO').format(30000)` → `30.000`.
- **Citas y bloqueos** (`appointments`, `barber_time_off`): fechas en **UTC**
  como timestamp en milisegundos.
- **Horarios** (`barber_schedules`): hora local de Bogotá como texto `"HH:MM"`.
  `end_time` es la hora de cierre; la última cita disponible se calcula como
  `cierre − duración del servicio`.
- **`day_of_week`**: `0` = lunes … `6` = domingo.
- **`barbers.buffer_minutes`**: `0` por defecto — las citas van seguidas
  (10:00 no bloquea 09:00 ni 11:00). Solo súbelo si quieres un descanso
  obligatorio entre citas.
- **`barber_time_off.barber_id = NULL`**: cierre para todo el negocio.
