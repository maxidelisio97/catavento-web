/*
 * Punto de entrada de React para montar la aplicacion en el HTML.
 * Aca se importan los estilos globales y el componente App principal.
 * Solo deberia tocarlo si cambia la forma de iniciar la app.
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import ReservarPage from './pages/reservar/ReservarPage.tsx'

// Routing manual a proposito: hoy el sitio tiene una sola pagina enlazada
// (App) mas /reservar, accesible SOLO por URL directa (regla de switch,
// ver CLAUDE.md). No vale la pena sumar react-router para dos rutas. Si
// el panel interno del modulo 5 termina viviendo en este mismo frontend,
// ahi si conviene un router de verdad — no antes.
const page = window.location.pathname === '/reservar' ? <ReservarPage /> : <App />;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {page}
  </StrictMode>,
)
