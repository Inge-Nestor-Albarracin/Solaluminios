import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// Public path where the app is published (VITE_BASE, default "/"). The
// manifest id, start_url and scope, and the service worker scope follow it.
const base = process.env.VITE_BASE ?? '/'

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [
    react(),
    // Installable PWA with ONE service worker of our own (src/sw/sw.ts):
    // precache of the static build, update on user confirmation and Web
    // Push. Registered by src/pwa/serviceWorker.ts (production builds only).
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src/sw',
      filename: 'sw.ts',
      injectRegister: false,
      manifestFilename: 'manifest.webmanifest',
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png', 'icons/badge-96.png'],
      injectManifest: {
        // Public static files of the build only: no API data is ever precached.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,webmanifest}'],
        globIgnores: ['icons.svg'],
      },
      manifest: {
        id: base,
        name: 'Solaluminios · Inventario',
        short_name: 'Solaluminios',
        description: 'Inventario por paquete, lectura RFID y tareas de Solaluminios (WeTracking).',
        lang: 'es-CO',
        dir: 'ltr',
        start_url: base,
        scope: base,
        display: 'standalone',
        orientation: 'any',
        theme_color: '#0B194F',
        background_color: '#0B194F',
        categories: ['business', 'productivity'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // Long-press shortcuts on Android; each opens an allowed view after login.
        shortcuts: [
          { name: 'Registrar paquete', short_name: 'Registrar', url: `${base}?view=register` },
          { name: 'Lectura masiva', short_name: 'Masiva', url: `${base}?view=bulk` },
          { name: 'Consultar chip', short_name: 'Chip', url: `${base}?view=lookup` },
          { name: 'Tareas', short_name: 'Tareas', url: `${base}?view=tasks` },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  // Fixed port: the API only accepts this origin through CORS_ORIGIN.
  server: { port: 5173, strictPort: true },
})
