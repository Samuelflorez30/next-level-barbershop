// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
import vercel from '@astrojs/vercel';

// https://astro.build/config
export default defineConfig({
  site: 'https://barbernextlevel.com', // <-- Esta línea genera la magia del sitemap
  // Modo servidor para las rutas dinámicas del sistema de reservas.
  // La landing (src/pages/index.astro) sigue siendo estática vía `prerender = true`.
  output: 'server',
  adapter: vercel(),
  vite: {
    plugins: [tailwindcss()]
  },
  integrations: [sitemap()]
});
