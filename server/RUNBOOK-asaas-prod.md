# RUNBOOK — Switch a Asaas PRODUCCIÓN

> Documentación de los pasos, per SPEC-modulo-4-pago-asaas.md § "Criterio
> de hecho". NO EJECUTAR nada de esto sin aprobación explícita de Maxi.
> Mientras no se ejecute, `ASAAS_ENV` sigue en `sandbox` y el sitio público
> sigue sin enlazar `/reservar`.

## Pre-requisitos

- Módulos 1-4 en `main`, deployados y probados en sandbox (incluye el
  flujo PIX end-to-end de este módulo, verificado por Maxi en `/reservar`
  con URL directa).
- Cuenta Asaas verificada para producción (no sandbox) — datos bancarios,
  documentación de la pousada aprobada por Asaas.
- Acceso a un secret manager (o al menos a variables de entorno del VPS
  fuera del repo) para la API key de producción — nunca en el repo, nunca
  en logs.

## Pasos

1. **Generar la API key de producción** en el panel de Asaas
   (Configurações → Integrações → API). Guardarla en el secret manager /
   `.env` del VPS, NUNCA en el repo.

2. **Rotar credenciales existentes**, per server/CLAUDE.md § "Reglas de
   seguridad":
   - Rotar la password de `catavento_app` en Postgres.
   - Si la API key de sandbox se compartió en algún canal no seguro
     durante el desarrollo, revocarla en el panel de Asaas.

3. **Registrar el webhook de producción**
   (`scripts/register-webhook.ts` apunta hoy a sandbox — para producción
   correrlo con `ASAAS_ENV=production` y la nueva API key). Confirmar en
   el panel de Asaas que el webhook quedó registrado apuntando a la URL
   pública de producción (`https://<dominio>/api/webhooks/asaas`), con
   HTTPS válido.

4. **Generar un nuevo `ASAAS_WEBHOOK_TOKEN`** (no reusar el de sandbox) y
   configurarlo tanto en el `.env` del VPS como en el registro del
   webhook en Asaas.

5. **Actualizar `.env` del VPS**:
   ```
   ASAAS_ENV=production
   ASAAS_API_KEY=<key de producción>
   ASAAS_WEBHOOK_TOKEN=<token nuevo>
   FRONTEND_BASE_URL=https://<dominio real de producción>
   ```
   Confirmar que `FRONTEND_BASE_URL` es el dominio público real — Asaas
   usa esa URL para el `callback.successUrl` que ve el huésped después de
   pagar con tarjeta.

6. **Prueba con pago real chico**: crear una reserva de prueba desde
   `/reservar` (todavía sin enlazar públicamente, acceso por URL
   directa), pagar el depósito con un monto mínimo real (PIX o tarjeta
   propios de Maxi), confirmar que:
   - El webhook llega y confirma la reserva.
   - El estado se refleja correctamente en `GET /api/reservations/:code`.
   - El dinero aparece en la cuenta Asaas de producción.
   Borrar la fila de prueba de `catavento_db` al terminar (mismo criterio
   que las pruebas de módulos anteriores).

7. **Recién ahí** se evalúa, en una tarea aparte y con aprobación
   explícita, enlazar `/reservar` desde el sitio público y dejar de
   enviar reservas a HQBeds — eso sigue siendo una decisión de negocio
   separada (ver server/CLAUDE.md § "Estrategia de switch"), no un paso
   técnico de este runbook.

## Rollback

Si algo falla después del switch: volver `ASAAS_ENV=production` a
`sandbox` en el `.env` del VPS y reiniciar el proceso (PM2) revierte
inmediatamente todos los cobros nuevos a sandbox. Las reservas ya
confirmadas con pago real de producción no se revierten solas —
requieren reembolso manual desde el panel de Asaas, igual que cualquier
`payment_conflict`.
