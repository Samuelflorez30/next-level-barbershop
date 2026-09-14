// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
import vercel from '@astrojs/vercel';
import react from '@astrojs/react';

// https://astro.build/config
export default defineConfig({
  site: 'https://barbernextlevel.com', // <-- Esta línea genera la magia del sitemap
  // Modo servidor: la home lee barberos/servicios de la DB en cada request
  // (con caché CDN) y las rutas /api/* sirven el sistema de reservas.
  output: 'server',
  adapter: vercel(),
  vite: {
    plugins: [tailwindcss()]
  },
  // React se usa únicamente para la isla BookingWidget; el resto es Astro + JS plano.
  integrations: [
    react(),
    // Solo la home es indexable: el panel, el login y las citas quedan fuera
    // del sitemap (y con noindex + robots.txt).
    sitemap({
      filter: (page) => !/\/(login|panel|citas|api)(\/|$)/.test(new URL(page).pathname),
    }),
  ]
});
