# Next Level Barbershop

Sitio web y sistema de reservas de Next Level Barbershop (Neiva, Huila).

- **Frontend**: Astro 7 + Tailwind CSS v4
- **Backend**: Astro en modo servidor desplegado en Vercel
- **Base de datos**: Turso (SQLite/libSQL) con Drizzle ORM

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
[`docs/SETUP.md`](docs/SETUP.md).

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

## Estructura

```
src/
├── components/   # secciones de la landing (Team, Services, Reservation…)
├── db/           # schema.ts, client.ts, seed.ts
├── layouts/
├── lib/          # utilidades (password.ts)
├── pages/
└── styles/
drizzle/          # migraciones SQL
docs/SETUP.md     # guía de configuración del backend
```
