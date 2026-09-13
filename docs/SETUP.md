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
- Usuario **admin** (`davidflorezramirez1602@gmail.com`) y un usuario por barbero

Al terminar imprime en consola una tabla con las **contraseñas temporales**.
Guárdalas: no se vuelven a mostrar.

El seed es idempotente: puedes ejecutarlo varias veces. Los usuarios que ya
existen conservan su contraseña. Para regenerarlas:

```sh
SEED_RESET_PASSWORDS=1 npm run db:seed
```

> Los emails de los barberos (`<slug>@barbernextlevel.com`) son provisionales;
> edítalos en `src/db/seed.ts` cuando tengas los reales.

## 6. Tests

```sh
npm test
```

Cada archivo de test crea su propia base de datos SQLite temporal (en el
directorio temporal del sistema), aplica las migraciones de `drizzle/` y la
borra al terminar. No necesita Turso ni toca `.env`.

## 7. Desplegar en Vercel

El proyecto ya está configurado con `@astrojs/vercel` (`output: 'server'`).
La landing (`/`) se prerenderiza y se sirve como HTML estático; las rutas del
sistema de reservas correrán como funciones serverless.

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
- **`barber_time_off.barber_id = NULL`**: cierre para todo el negocio.
