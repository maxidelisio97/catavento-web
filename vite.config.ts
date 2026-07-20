/*
 * Configura Vite para compilar la aplicacion React.
 * Aca se ajustan plugins, base path de deploy y opciones de build.
 * Debo editarlo si cambia la publicacion o herramientas del proyecto.
 */

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Solo dev: en produccion Nginx proxea /api al backend directamente
    // (mismo origen). Esto le da al Vite dev server el mismo comportamiento
    // sin duplicar esa config.
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})
