// Vite config de la app del panel — independiente de la del sitio público
// (raíz del repo). Build propio a panel/dist, sin compartir bundle ni
// router con el frontend público.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/panel': 'http://localhost:3001',
      '/api': 'http://localhost:3001',
    },
  },
});
