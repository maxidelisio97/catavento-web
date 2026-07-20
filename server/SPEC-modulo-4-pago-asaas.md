# SPEC — Módulo 4: Pago del depósito con Asaas

> Spec aprobada en el Project de claude.ai (2026-07-21). Fuente de
> verdad de este módulo. Implementar tal cual; proponer antes de
> cambiar. Se apoya en los módulos 1-3 (en producción) y en el PoC de
> pagos Asaas ya migrado a TS+Fastify (src/asaasClient.ts, plugins de
> payments/webhooks). REGLA DE SWITCH VIGENTE: /reservar sigue sin
> enlazarse desde el sitio; TODO en sandbox de Asaas hasta aprobación
> explícita de producción.

## Alcance

El huésped que creó una reserva en /reservar paga el DEPÓSITO online
(PIX o tarjeta, sin boleto) dentro de la ventana de retención; el
webhook de Asaas confirma la reserva. Incluye la tabla `settings`
(parámetros de negocio como datos). NO incluye: cobro del saldo
restante (queda registrado como pendiente; se gestiona manual y en el
panel M5), reembolsos automatizados, emails (módulo posterior), panel.

## Decisiones de negocio (no reabrir)

- Depósito: porcentaje CONFIGURABLE, inicial 50%. Vive en `settings`
  (`deposit_percent`), editable a futuro desde el panel. Se CONGELA
  por reserva al crearla, igual que el precio.
- Redondeo del depósito: a reales enteros (múltiplos de 100 cents),
  half-up. El saldo = total − depósito (absorbe el redondeo).
- Saldo restante: se cobra en la pousada, fuera del sistema. El
  sistema solo lo registra (balance_cents implícito = total − deposit).
- Métodos: PIX y tarjeta. SIN boleto (decidido en M3).
- Ventana de retención: pasa de hardcodeada a `settings`
  (`hold_minutes`, inicial 30). Mismo comportamiento actual.
- Principio general (va también a server/CLAUDE.md): parámetros de
  negocio como datos, nunca hardcodeados.

## Esquema

### Migración

```sql
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,           -- serializado; tipado en app con Zod por clave
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- seed: ('deposit_percent','50'), ('hold_minutes','30')

ALTER TABLE reservations ADD COLUMN deposit_cents INTEGER
  CHECK (deposit_cents >= 0);
-- congelado al crear la reserva (percent vigente + redondeo).
-- nullable por las filas históricas; toda reserva nueva lo lleva.

CREATE TABLE payments (
  id               SERIAL PRIMARY KEY,
  reservation_id   INTEGER NOT NULL REFERENCES reservations(id),
  asaas_payment_id TEXT NOT NULL UNIQUE,
  method           TEXT NOT NULL CHECK (method IN ('pix','card')),
  amount_cents     INTEGER NOT NULL CHECK (amount_cents > 0),
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','received','failed','refunded')),
  raw_last_event   JSONB,             -- último webhook recibido, para auditoría
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payments_reservation ON payments (reservation_id);
```

## Flujo

1. **POST /api/reservations** (M3, se extiende): al crear, lee
   `deposit_percent` y `hold_minutes` de settings, congela
   `deposit_cents` (redondeado) y `expires_at`. La respuesta suma
   `deposit_cents`.
2. **POST /api/reservations/:code/payment** (nuevo): body
   `{ method: 'pix' | 'card', ...datos según método }`.
   - Solo válido si la reserva está `pending_payment` y no expirada;
     409 si no.
   - Crea el cobro en Asaas por `deposit_cents` reusando/extendiendo
     el asaasClient del PoC. Un solo payment activo por reserva
     (reintentos: reusar el existente si sigue pendiente en Asaas, o
     crear uno nuevo si falló — proponer detalle al implementar).
   - PIX: responde QR code + copia-e-cola + vencimiento alineado a
     `expires_at`. Tarjeta: el mecanismo exacto (tokenización vs
     link/invoice de Asaas) se decide al implementar según lo que el
     PoC ya soporte y lo que MENOS datos de tarjeta haga pasar por
     nuestro servidor — preferir siempre la opción donde la tarjeta
     viaja directo a Asaas. Proponer antes de implementar esta parte.
3. **Webhook Asaas** (extiende el plugin existente): en
   PAYMENT_RECEIVED / PAYMENT_CONFIRMED del payment:
   - Idempotente: si ya se procesó ese evento/estado, 200 sin efectos.
   - Marca payment `received` y guarda raw_last_event.
   - Confirma la reserva DENTRO de una transacción con el lock del
     módulo 2 (SELECT FOR UPDATE sobre rooms): si la reserva sigue
     `pending_payment` (aunque expires_at haya pasado, ver caso
     límite), re-verifica disponibilidad y pasa a `confirmed`.
   - **Caso límite (pago después de expirar):** si al llegar el
     webhook la reserva expiró pero las noches SIGUEN disponibles →
     confirmar igual (el huésped pagó, hay lugar, todos felices). Si
     ya NO hay disponibilidad → NO confirmar: dejar payment
     `received` + reserva en nuevo estado `payment_conflict`, y
     loguear con nivel error. La devolución se gestiona MANUAL desde
     el panel de Asaas por ahora; el M5 mostrará estos casos. Agregar
     'payment_conflict' al CHECK de status de reservations en la
     migración.
   - Regla absoluta vigente: NUNCA confirmar sin webhook verificado
     (token timingSafeEqual ya existente).
4. **GET /api/reservations/:code** (M3, se extiende): suma
   `deposit_cents`, `payment_status` y, si pending, los datos de pago
   activos (QR PIX). El frontend hace polling de este endpoint.

## Frontend (/reservar, paso final)

Reemplaza el placeholder "aguardando pago":
- Selección PIX / tarjeta.
- PIX: QR + botón copiar código + countdown de expiración + polling
  (cada ~5s) hasta `confirmed` → pantalla de confirmación con código
  de reserva, resumen, depósito pagado y saldo a pagar en la pousada.
- Tarjeta: según el mecanismo elegido en backend.
- Estados de error: pago fallido (reintentar), reserva expirada
  (volver a empezar con fechas cargadas).
- Copy PT, tono de marca; mostrar la página a Maxi antes del merge.

## Tests exigidos

Unitarios (catavento_db_test):
1. Cálculo del depósito: 50% de 58000 → 29000; redondeo a real entero
   (p.ej. 50% de 12500 → 6300, verificar half-up); congelamiento (el
   percent cambia en settings, la reserva vieja no).
2. POST payment sobre reserva expirada/confirmada/inexistente → 409/404.
3. Webhook idempotente: mismo evento dos veces → un solo efecto.
4. Webhook confirma: pending → confirmed dentro del lock.
5. Caso límite: webhook post-expiración CON disponibilidad → confirmed;
   SIN disponibilidad → payment_conflict, reserva no confirmada, y la
   unidad no queda doblemente ocupada.
6. settings: lectura tipada con Zod, error claro si falta una clave.

Integración (sandbox Asaas, como el PoC):
7. Flujo PIX completo en sandbox: crear reserva → payment → simular
   pago → webhook → confirmed. (Los scripts del PoC ya saben simular
   la confirmación en sandbox.)

## Criterio de "hecho"

- Migración corrida vía túnel en catavento_db (y test).
- Tests 1-6 verdes + flujo 7 demostrado contra sandbox.
- Flujo completo probado por Maxi en /reservar (URL directa) con
  sandbox: reservar, pagar con PIX de sandbox, ver la reserva
  confirmada. Borrar los datos de prueba.
- El switch a Asaas PRODUCCIÓN no es parte de este módulo: queda
  explícitamente pendiente de aprobación de Maxi (API key de
  producción en secret manager + webhook de producción + prueba con
  pago real chico). Documentar los pasos en un RUNBOOK-asaas-prod.md
  pero NO ejecutarlos.
- El sitio público sigue idéntico; /reservar sigue sin enlazar.