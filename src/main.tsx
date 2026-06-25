/*
 * Punto de entrada de React para montar la aplicacion en el HTML.
 * Aca se importan los estilos globales y el componente App principal.
 * Solo deberia tocarlo si cambia la forma de iniciar la app.
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
