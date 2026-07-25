# SPEC — Módulo 7: Gestión operativa

> Booking engine propio de Pousada Catavento (Taíba, Ceará).
> Spec de implementación para Claude Code. Fuente de verdad de las decisiones de M7.
> Redactada: 2026-07-22. Estado: **aprobada para implementar**.

---

## 0. Contexto y posición en el plan

M7 es el **primer módulo que escribe sobre reservas desde el panel**. Todo lo anterior (M1–M6) o bien era solo-lectura en el panel (M6C tape chart) o escribía desde el flujo web público (M3/M4). Acá el operario autenticado crea, mueve, cobra, cancela y cierra reservas.

**Se apoya en:**
- **M5** — unidades físicas (`room_units`), doble chequeo de disponibilidad (agregado + físico).
- **M6A** — asignación por noche (`reservation_nights`, `UNIQUE (room_unit_id, night)` como anti-overbooking a nivel base), `reservations.origin`.
- **M6B** — auth del panel, hook `requireAuth`, sesiones opacas.
- **M6C** — tape chart de solo lectura. M7 le agrega interacción (arrastre).

**No toca:** OTAs/channel manager (M12), configuración de precios (M8), permisos por empleado (M9 — en M7 cualquier usuario autenticado puede todo), caja/gastos (M10).

---

## 1. Principio rector (gobierna TODO el módulo)

> **El panel puede saltar reglas comerciales con confirmación explícita, pero NUNCA la integridad física de una unidad-noche.**

- **Reglas comerciales (salteables con confirmación):** estadía mínima (`min-stay`), capacidad-del-tipo-vs-huéspedes. El dueño sabe lo que hace; el panel le pide confirmar y procede.
- **Reglas duras de espacio (NO salteables, ni por el dueño):** `adults_only` (Casal no admite niños/bebés) y mascotas en Casal. Son límites físicos, no de política — no hay confirmación que valga.
- **Integridad física (NUNCA salteable, sin escape hatch):** una `room_unit` no puede tener dos reservas la misma noche. El `UNIQUE (room_unit_id, night)` es ley absoluta. No existe "forzar overbooking" en el panel. Si el dueño quiere sobrevender a nivel *tipo de cuarto*, eso es problema del channel manager (M12), no de la asignación física.

Este principio se repite en cada operación de abajo. Si al implementar surge un caso que no encaja, **parar y preguntar**, no inventar un escape hatch.

---

## 2. Divorcio conceptual: estado ≠ pago

En el flujo web (M4) "confirmada" y "pagada" eran casi lo mismo: el webhook de Asaas confirmaba y la reserva valía. **En el panel se divorcian.** Hay que tratarlos como dos ejes ortogonales:

- **Estado de la reserva** (`reservations.status`): máquina de estados operativa. Ver §3.
- **Estado de pago**: cuánto se pagó vs cuánto se debe. Derivado de la suma de pagos confirmados. Ver §5.

Una reserva puede estar `confirmed` sin un centavo pagado (reserva manual sin pago). Puede estar `checked_in` con saldo pendiente. El check-out es el único punto donde los dos ejes se cruzan como precondición dura (ver §6).

**Advertencia para el implementador:** el error más fácil de M7 es reusar la lógica de M4 que asume "confirmar = pagar". Mantener los ejes separados desde el schema.

---

## 3. Máquina de estados de la reserva

```
                    ┌──────────────┐
   (web, pending    │   pending    │  (creada, esperando pago; expira por hold_minutes)
    de M4)          └──────┬───────┘
                           │ webhook Asaas confirma  /  operario confirma manual
                           ▼
                    ┌──────────────┐
   (manual nace     │  confirmed   │──────────────► cancelled
    acá)            └──────┬───────┘                (libera unidad-noche)
                           │ check-in (fecha llegada, operario)
                           ▼
                    ┌──────────────┐
                    │  checked_in  │──────────────► (no vuelve a cancelled)
                    └──────┬───────┘
                           │ check-out (requiere saldo = 0)
                           ▼
                    ┌──────────────┐
                    │ checked_out  │  (estado terminal)
                    └──────────────┘

   no_show: transición desde `confirmed` cuando el huésped no llegó.
            Terminal. Libera unidad-noche igual que cancelled.
   payment_conflict: estado heredado de M4, no lo toca M7.
```

**Estados nuevos que agrega M7:** `checked_in`, `checked_out`, `cancelled`, `no_show`. (`pending`, `confirmed`, `payment_conflict` ya existen de M4.)

**Transiciones válidas (las únicas permitidas — cualquier otra es error 409):**

| Desde | Hacia | Disparador | Libera unidad-noche |
|---|---|---|---|
| `pending` | `confirmed` | webhook Asaas (ya existe M4) | no |
| `pending` | `cancelled` | operario | sí |
| `confirmed` | `checked_in` | operario (check-in) | no |
| `confirmed` | `cancelled` | operario | sí |
| `confirmed` | `no_show` | operario | sí |
| `checked_in` | `checked_out` | operario (check-out, saldo=0) | no (la estadía ya pasó) |

- **`checked_in` NO puede cancelarse ni marcarse no-show** (el huésped ya está adentro; si hay que sacarlo, es un problema operativo fuera del scope del software — o se maneja como check-out anticipado, decisión futura).
- **`checked_out` y `cancelled` y `no_show` son terminales.**
- Toda transición se registra con `changed_by` (user_id del operario) y timestamp, para auditoría. Ver §8.

---

## 4. Operaciones sobre unidades físicas (arrastre y cambio de cuarto)

### 4.1 Operación base: `moveNight` / `moveStay`

Ambas UIs (arrastre en tape chart, botón "cambiar de cuarto" en la ficha) escriben por **la misma operación de backend**. Cero lógica duplicada.

- **`moveNight(reservationCode, night, toUnitId)`** — mueve una sola diaria. Borra la fila `reservation_nights` de esa noche y escribe una nueva con `toUnitId`. La reserva queda legítimamente **fragmentada** (noches en distintas unidades). Estado válido de primera clase, no excepción.
  - ⚠️ **7C hace real la fragmentación por primera vez.** El tape chart de 6C ya lee por noche y la dibuja bien, pero **cualquier vista o lógica que asuma "una reserva = una unidad" se rompe**. Antes de implementar, revisar la ficha de reserva, el detalle del panel y `reservations.room_unit_id` (legacy desde 6A). Si algo muestra "la unidad" en singular, tiene que pasar a mostrar la asignación por noche.
- **`moveStay(reservationCode, toUnitId)`** — mueve todas las noches de la reserva a `toUnitId`. **Atómico: todo o nada.** Si `toUnitId` está ocupada aunque sea una de las noches del rango, la operación falla completa y no deja la reserva a medio mover.

### 4.2 Validaciones (en orden, dentro del lock)

1. **Lock primero.** La operación entra por el **mismo advisory lock** que `createReservation`. No un lock nuevo. Si dos operarios mueven a la vez, uno gana y el otro recibe 409 — nunca "último gana silencioso".
2. **Reserva existe y está en estado movible** (`confirmed` o `checked_in`; `pending` también se puede mover, pero `cancelled`/`no_show`/`checked_out` no → 409).
3. **Unidad destino existe.**
4. **Integridad física (dura, no salteable):** la(s) noche(s) en `toUnitId` deben estar libres. Chequeo contra `reservation_nights` para el rango. Si están ocupadas → 409, **sin opción de forzar**.
5. **Reglas comerciales (blandas, salteables con confirmación):**
   - Capacidad del tipo de `toUnitId` < huéspedes de la reserva.
   - `adults_only` del tipo destino incompatible con la reserva (tiene niños/bebés).
   - Restricción de mascotas (destino Casal + reserva con mascota).
   - Si alguna se viola, el backend responde con un **código de warning** (no un 409); el frontend muestra el warning, pide confirmación, y reenvía con un flag `force_commercial: true`. Con ese flag, el backend procede saltando SOLO las reglas comerciales (nunca la física).

### 4.3 Contrato del flag `force_commercial`

- `force_commercial` **solo puede saltear reglas comerciales**, jamás la integridad física. Aunque venga en `true`, la validación física de §4.2.4 se ejecuta y bloquea igual.
- El backend NO decide solo saltar reglas: sin el flag, una violación comercial devuelve warning y no escribe nada. El operario tiene que confirmar explícitamente.

### 4.4 Endpoints

```
POST /panel/reservations/:code/move-night
  body: { night: "YYYY-MM-DD", toUnitId: number, force_commercial?: boolean }

POST /panel/reservations/:code/move-stay
  body: { toUnitId: number, force_commercial?: boolean }
```

Respuestas:
- `200` con la reserva actualizada (incl. nuevo detalle de noches).
- `409` conflicto físico (unidad ocupada) o estado inválido — **no salteable**.
- `422` warning comercial, con `{ warnings: [...] }` — reintentar con `force_commercial: true`.

### 4.5 Frontend

**Decisión de alcance (2026-07-23): el arrastre en el tape chart queda FUERA de 7C.** Se implementa solo el botón en la ficha, que funciona en desktop y mobile por igual. Razones: el drag sobre grilla (estados intermedios, feedback de celda válida/inválida, soporte touch) es la mayor parte del esfuerzo de 7C para una fracción del valor, y el botón es más preciso y mejor en mobile. Como ambas UIs comparten la misma operación de backend, el arrastre se puede agregar después sin tocar nada del servidor.

- **Ficha de reserva (única UI de 7C):** botón "Cambiar de cuarto" que abre un selector de unidad destino + opción "solo esta noche / toda la estadía". Llama a `moveNight`/`moveStay`.
  - El selector muestra **solo las unidades libres** para la(s) noche(s) en juego (evita que el operario tenga que saber de memoria qué está libre — es lo que compensa la falta del contexto visual del tape chart).
  - Si se elige "solo esta noche" en una estadía de varias noches, hay que poder elegir **cuál** noche.
- Warning comercial → modal de confirmación con el texto del warning antes de reenviar con `force_commercial`.
- **Futuro (no 7C):** drag de una celda-noche o de la barra completa en el tape chart (M6C) a otra fila de unidad, con optimistic update y rollback si el backend rechaza. Solo desktop (`:hover`/drag no existen en touch). No requiere cambios de backend.

---

## 5. Pagos: schema extendido y saldo

### 5.1 Cambio de schema central de M7

La tabla `payments` de M4 asume **un solo pago Asaas por reserva** (el depósito). M7 la generaliza:

```sql
ALTER TABLE payments ADD COLUMN kind   text NOT NULL DEFAULT 'deposit';
ALTER TABLE payments ADD COLUMN method text NOT NULL DEFAULT 'asaas';
-- kind:   'deposit' | 'balance' | 'extra'
-- method: 'asaas_pix' | 'asaas_card' | 'cash' | 'external' | 'pix_manual'
```

- **`kind`** — qué representa el pago: depósito (50% inicial), saldo (resto), o extra (consumos §7).
- **`method`** — cómo entró: por Asaas (pix/tarjeta) o registrado a mano por el operario (efectivo, PIX directo al dueño, transferencia externa).

**Migración / backfill:** los pagos existentes de M4 son todos depósitos vía Asaas. Backfillear `kind='deposit'`. Para `method`: si el schema M4 guardó el tipo de cobro Asaas (pix vs card), mapear a `asaas_pix`/`asaas_card`; si no lo distinguió, backfillear al genérico `method='asaas'` y no inventar. **Verificar qué guarda M4 antes de asumir** — no romper los pagos en producción.

### 5.2 Dos caminos de cobro del saldo

**Camino A — saldo vía Asaas (reusa flujo M4):**
- Reusa `POST /reservations/:code/payment` con casi la misma mecánica: genera PIX (QR) o invoiceUrl de tarjeta hospedado por Asaas. La tarjeta NUNCA pasa por nuestro backend (invariante de M4, se mantiene).
- Diferencia: el nuevo pago se registra con `kind='balance'`.
- **El webhook idempotente de M4 tiene que saber QUÉ confirma.** Hoy confirma "el depósito → la reserva". Ahora un webhook puede corresponder a un pago `balance`. El webhook NO debe re-disparar la confirmación de la reserva (ya está `confirmed`); solo registra el pago y recalcula el saldo. Revisar la lógica de idempotencia para que distinga por el pago que referencia el webhook, no por la reserva.

**Camino B — saldo cobrado por fuera (efectivo / PIX directo):**
- NO toca Asaas. Es un registro contable escrito directamente por el operario autenticado.
- `payments` con `method='cash'` o `'external'` o `'pix_manual'`, `kind='balance'`, monto y fecha. Sin webhook, confirmado en el acto (lo confirma la autoridad del usuario logueado).

Ambos caminos son necesarios: mucha gente paga el saldo en efectivo al llegar. El panel soporta los dos.

### 5.3 Saldo pendiente (cálculo, no columna materializada)

**Decisión técnica:** el saldo se calcula, no se materializa.

- `amount_paid_cents` = `SUM(amount_cents)` sobre `payments` confirmados de la reserva.
- `balance_due_cents` = `total_cents` − `amount_paid_cents`.
- Exponer vía **vista SQL** (`reservation_balances` o similar) para lectura simple desde tape chart, ficha y check-out.
- Razón: el volumen de una pousada no justifica materializar, y una vista nunca se desincroniza. Si el perfil de performance lo pidiera algún día (no ahora), se materializa después.
- `total_cents` incluye extras (§7). Congelado por reserva salvo que se agregue un extra, que lo incrementa.

### 5.4 Endpoints de pago

```
POST /panel/reservations/:code/payment
  body: { kind: 'deposit'|'balance'|'extra', method: 'asaas_pix'|'asaas_card'|'cash'|'external'|'pix_manual', amount_cents: number }
  - method asaas_* → genera cobro Asaas, devuelve QR/invoiceUrl, pago queda 'pending' hasta webhook
  - method cash/external/pix_manual → registra pago confirmado en el acto
```

---

## 6. Check-in y check-out

### 6.1 Check-in

```
POST /panel/reservations/:code/check-in
```
- Precondición: `status = 'confirmed'`. (No se hace check-in de un `pending` sin pagar el depósito — o sí, decisión: **requiere `confirmed`**; para entrar sin depósito, primero confirmar manual.)
- Efecto: `status → 'checked_in'`, registra `checked_in_at` y `changed_by`.
- No exige saldo saldado (el huésped puede pagar el saldo al hacer check-out o durante la estadía).
- Idealmente solo habilitado en/desde la fecha de llegada, pero **no bloquear por fecha** (el operario puede tener razones para adelantar); mostrar warning si la fecha no coincide, no impedir.

### 6.2 Check-out

```
POST /panel/reservations/:code/check-out
```
- Precondición 1: `status = 'checked_in'`.
- **Precondición 2 (dura):** `balance_due_cents = 0`. **El check-out se BLOQUEA si hay saldo pendiente.** No hay warning-y-procedo; es un 409 hasta que el saldo esté en cero.
- Para saldar, el operario registra el pago faltante (§5.2, típicamente `cash` de un click) y recién ahí el check-out procede.
- Efecto: `status → 'checked_out'`, registra `checked_out_at` y `changed_by`. Estado terminal.
- La unidad-noche no se libera (la estadía ya transcurrió; las filas `reservation_nights` quedan como registro histórico).

**Frontend:** en la ficha, si hay saldo, el botón "Check-out" está deshabilitado con un mensaje claro ("Falta cobrar R$ X — registrá el pago para poder cerrar") y un acceso directo a registrar el pago.

---

## 7. Reservas manuales

### 7.1 Naturaleza

Caso de uso: llamó por teléfono / vino un conocido / entró por Instagram y el operario le reserva la fecha. **No hay flujo de pago Asaas obligatorio** — el dueño no se auto-manda un PIX.

- Nace con `origin='manual'` y **`status='confirmed'` desde el primer momento** (la crea un humano con autoridad, no es un carrito web esperando pago).
- **NO tiene `hold_minutes`. NO expira sola. NUNCA entra al barrido perezoso de expiración.**
  - ⚠️ **Crítico para el implementador:** el modelo de expiración de M4/M6A libera reservas inactivas con un barrido perezoso dentro del lock de `createReservation`. Ese barrido identifica candidatas por estado `pending` + hold vencido. Una reserva manual es `confirmed`, así que por estado ya queda fuera — **pero verificar explícitamente que ninguna manual pueda ser barrida**, y agregar un test que lo garantice. Una reserva manual que desaparece sola es el peor bug posible de este módulo.

### 7.2 Creación

```
POST /panel/reservations/manual
  body: {
    roomTypeId, arrival, departure,
    guestName, guestContact (opcional),
    adults, children?, children_ages?, babies?, pets?,
    payment_status: 'none' | 'deposit_paid' | 'paid_full',
    payment_method?: 'cash'|'external'|'pix_manual',  // si hubo pago
    override_total_cents?: number,  // opcional: pisar el precio calculado (§10 dec.1)
    force_commercial?: boolean
  }
```

- **Disponibilidad:** confirma unidad de inmediato dentro del **mismo lock** y con el **mismo doble chequeo** (agregado + físico) que la web (M5). Asignación automática de unidad: misma lógica (label menor entre las libres), escribiendo N filas `reservation_nights` (M6A).
- **Integridad física NO salteable:** una manual sobre una unidad-noche ya ocupada se rechaza siempre, sin escape hatch (decisión de negocio confirmada). Si no hay ninguna unidad del tipo libre para el rango → 409, no se crea.
- **Reglas comerciales salteables** con `force_commercial` igual que en move (§4.3): p.ej. cargar una reserva bajo `min-stay` o con capacidad excedida, con confirmación.
- **Precio:** se congela al crear, con la misma lógica de tarifa que la web (M1: `room_rates` por cuarto + ocupación, finde vs semana). El operario ve el total calculado y **puede pisarlo** con `override_total_cents` (§10 dec.1) — campo opcional en el body de creación. Si viene, ese es el total congelado.
- **Pago al crear** (según `payment_status`):
  - `none` → reserva confirmada sin ningún registro en `payments`. Saldo = total.
  - `deposit_paid` → registra un `payments` `kind='deposit'`, `method` = el elegido, monto = `deposit_percent` del total.
  - `paid_full` → registra un `payments` (o dos: deposit+balance, o uno `kind='balance'` por el total — **implementar como un solo registro que cubre el total**, `kind='balance'` con monto = total, para que `balance_due` dé 0).

### 7.2b Mascotas (campo + tarifa nuevos, cierra deuda de 7C) — decidido 2026-07-23

7C descubrió que la regla de mascotas (§4.2.5) no era implementable: no existía en `reservations` ningún campo que indicara si la reserva trae mascota (solo `rooms.pets_allowed` del lado del cuarto). 7D agrega el campo y la tarifa.

**Regla de negocio (confirmada con el dueño):**
- **Casal:** mascotas PROHIBIDAS. Regla DURA, NO salteable ni con `force_commercial` — es límite de espacio físico, misma familia que `adults_only` (Casal ya no admite niños/bebés por la misma razón). Intentar una reserva con mascota en Casal → rechazo, sin opción de confirmar.
- **Triplo y Cuádruple:** mascotas permitidas, sin restricción.
- **Tarifa:** R$30 **por noche, por reserva** (no por mascota — cargo plano aunque traigan más de una). Se suma al `total_cents` como componente de tarifa (igual que el hospedaje: `noches × tarifa_mascota`), congelado al crear la reserva. NO es un extra manual (§7 dec.4) — es parte del precio, entra en el total desde la creación, lo refleja el saldo y lo exige el check-out.

**Modelado:**
- **Schema:** columna `reservations.pets` (boolean o smallint, siguiendo el molde de `children`/`babies` — no inventar uno nuevo).
- **Tarifa configurable:** el monto de mascota vive en la tabla `settings` (donde ya están `deposit_percent` y `hold_minutes`), NO hardcodeado. Default R$30 (3000 cents). Editable desde el panel a futuro (M8), pero el parámetro se crea ahora. El valor se congela por reserva al crear, igual que el resto del precio.
- **Formulario manual:** control "trae mascota" igual que el de niños/bebés. Al tildarlo sobre un tipo Triplo/Cuádruple, el total mostrado incluye `noches × tarifa_mascota`. Sobre Casal, el control se bloquea o el submit se rechaza (regla dura).

**Cierra la deuda de 7C:** con el campo existiendo, la validación de mascotas en `moveReservation` (que 7C omitió) ahora se implementa — pero como regla DURA, no como warning salteable. Mover una reserva con mascota a un Casal se rechaza siempre (mismo trato que la ocupación física). Ojo: un move que cambie el tipo de cuarto puede alterar el cargo de mascota — si se mueve de Triplo a Casal la mascota no puede ir; de Triplo a Cuádruple el cargo se mantiene. Definir en el plan qué pasa con el `total_cents` congelado ante un move entre tipos (probablemente fuera de scope de 7C/7D si el move no recalcula precio — pero anotarlo explícitamente, no dejarlo implícito). Actualizar la nota de deuda en `server/CLAUDE.md` (de "no implementable, falta el dato" a "resuelto en 7D, regla dura").

### 7.3 Frontend

- Formulario de nueva reserva manual en el panel (no en el sitio público). Selector de tipo de cuarto, rango de fechas (reusar react-day-picker del sitio si conviene, o el que use el panel), huéspedes, datos de contacto, estado de pago.
- Accesible desde el tape chart (botón "+ Reserva" o click en celda vacía) y desde una vista de listado.

---

## 8. Cancelación y no-show

```
POST /panel/reservations/:code/cancel    body: { reason?: string }
POST /panel/reservations/:code/no-show    body: { reason?: string }
```

- **Cancel:** válido desde `pending` o `confirmed`. `status → 'cancelled'`.
- **No-show:** válido desde `confirmed` (el huésped confirmó pero no llegó). `status → 'no_show'`.
- Ambos **liberan las unidad-noche**: borran (o marcan inactivas) las filas `reservation_nights`, dejando esas noches disponibles de nuevo. Hacerlo **dentro del lock** para no competir con una reserva entrante sobre la misma unidad-noche.
- Ambos registran `changed_by`, timestamp y `reason` opcional.
- **Pagos y cancelación:** M7 NO implementa reembolsos automáticos vía Asaas. Si una reserva cancelada tenía un depósito pagado, el depósito queda registrado en `payments` como histórico; el reembolso (si aplica) se maneja por fuera (efectivo, o vía panel de Asaas manualmente). Anotarlo como decisión, no como pendiente urgente. Ver §10.
- **`checked_in` no se puede cancelar ni marcar no-show** (§3).

---

## 9. Auditoría

Toda escritura de M7 (move, pago manual, cambio de estado, creación manual, cancel/no-show) registra quién y cuándo. Dos opciones de implementación — **elegir la más simple que sirva:**

- **Opción liviana (recomendada para M7):** columnas `*_by` / `*_at` en `reservations` para los hitos (`checked_in_by/at`, `checked_out_by/at`, `cancelled_by/at`, `created_by` para manuales) + `changed_by` en `payments`.
- **Opción completa (diferible a M9/M10):** tabla `audit_log` genérica (entity, entity_id, action, actor, timestamp, payload). Más potente pero es scope de "usuarios y permisos" (M9). **No implementar en M7 salvo que caiga solo.**

M7 usa la opción liviana. Dejar la tabla `audit_log` documentada como futura.

---

## 10. Decisiones cerradas y abiertas

### Cerradas (implementar así)

1. **Pisar precio en reserva manual: SÍ.** El operario puede sobrescribir el total calculado al cargar una manual (tarifa especial a un conocido, etc.) mediante un campo opcional `override_total_cents` en `reservations`. Si viene, se usa como `total_cents` congelado; si no, se usa el calculado con la lógica de tarifa de M1. El precio pisado también entra en el cálculo de saldo (§5.3) y de check-out (§6.2) normalmente. El override queda registrado (quién lo puso, vía `created_by`).

2. **Reembolsos: `kind='refund'` en el enum desde ahora, sin UI en M7.** Se agrega `'refund'` al enum de `payments.kind` para dejar el hook listo, pero M7 NO implementa flujo de reembolso automático vía Asaas ni UI de reembolso. Si una reserva cancelada tenía depósito, el reembolso (si aplica) se maneja por fuera (efectivo o panel de Asaas manual) y opcionalmente se registra a mano como `kind='refund'` con monto negativo. La UI de reembolso es futura (M8/M10).

### Abiertas (menores, no bloquean — confirmar durante implementación)

3. **Check-out anticipado / early departure:** fuera de scope M7. Si se saca a alguien antes, hoy es check-out normal. Confirmar que no se necesita ajuste de tarifa por noches no usadas en M7.
4. **Extras — alcance de UI: lista libre (decidido 2026-07-23).** La UI de "agregar cargo" es una lista libre de concepto (texto) + monto, no un catálogo de conceptos predefinidos. Un catálogo queda para M8/M10 si el volumen lo justifica. `reservation_extras` (§11) ya soporta esto tal cual (`concept text` + `amount_cents`).

---

## 11. Resumen de cambios de schema

```sql
-- payments: generalizar de "un depósito Asaas" a cualquier pago
ALTER TABLE payments ADD COLUMN kind   text NOT NULL DEFAULT 'deposit';
ALTER TABLE payments ADD COLUMN method text NOT NULL DEFAULT 'asaas';
-- kind:   'deposit' | 'balance' | 'extra' | 'refund'
--         ('refund' entra en el enum ahora; su UI es futura, ver §10 dec.2)
-- method: 'asaas_pix' | 'asaas_card' | 'cash' | 'external' | 'pix_manual'
-- backfill existentes: kind='deposit', method según lo que guarde M4

-- reservations: nuevos estados + auditoría liviana + override de precio
-- status enum: agregar 'checked_in','checked_out','cancelled','no_show'
ALTER TABLE reservations ADD COLUMN checked_in_at   timestamptz;
ALTER TABLE reservations ADD COLUMN checked_in_by   integer REFERENCES users(id);
ALTER TABLE reservations ADD COLUMN checked_out_at  timestamptz;
ALTER TABLE reservations ADD COLUMN checked_out_by  integer REFERENCES users(id);
ALTER TABLE reservations ADD COLUMN cancelled_at    timestamptz;
ALTER TABLE reservations ADD COLUMN cancelled_by    integer REFERENCES users(id);
ALTER TABLE reservations ADD COLUMN cancel_reason   text;
ALTER TABLE reservations ADD COLUMN created_by      integer REFERENCES users(id); -- null para web
ALTER TABLE reservations ADD COLUMN override_total_cents integer; -- null = usar precio calculado (§10 dec.1)

-- extras: cargos sumados al total (si kind='extra' necesita detalle)
CREATE TABLE reservation_extras (
  id          serial PRIMARY KEY,
  reservation_id integer NOT NULL REFERENCES reservations(id),
  concept     text NOT NULL,
  amount_cents integer NOT NULL,
  created_by  integer NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- total_cents de la reserva pasa a incluir SUM(extras). Definir si se
-- recalcula al vuelo (vista) o se actualiza total_cents al agregar extra.

-- vista de saldo (no materializada)
CREATE VIEW reservation_balances AS
  SELECT r.id,
         r.total_cents,
         COALESCE(SUM(p.amount_cents) FILTER (WHERE p.status='confirmed'), 0) AS amount_paid_cents,
         r.total_cents - COALESCE(SUM(p.amount_cents) FILTER (WHERE p.status='confirmed'), 0) AS balance_due_cents
  FROM reservations r
  LEFT JOIN payments p ON p.reservation_id = r.id
  GROUP BY r.id;
```

---

## 12. Endpoints de M7 (resumen)

```
POST /panel/reservations/manual                  crear reserva manual
POST /panel/reservations/:code/move-night        mover una diaria
POST /panel/reservations/:code/move-stay         mover toda la estadía
POST /panel/reservations/:code/payment           registrar pago (asaas o manual)
POST /panel/reservations/:code/check-in          check-in
POST /panel/reservations/:code/check-out         check-out (bloquea si saldo>0)
POST /panel/reservations/:code/cancel            cancelar
POST /panel/reservations/:code/no-show           marcar no-show
POST /panel/reservations/:code/extra             agregar cargo extra
GET  /panel/reservations/:code                   ficha completa (con saldo)
```

Todos bajo `requireAuth` (M6B). Todas las escrituras sobre disponibilidad/estado pasan por el advisory lock de `createReservation`.

---

## 13. Reglas de implementación heredadas (recordatorio)

- **Verificación de rama como PRIMER paso** de todo trabajo nuevo (no al commitear).
- **Validar-antes-de-implementar:** proponer plan de cada parte → ok de Maxi → implementar.
- **Toda escritura sobre disponibilidad pasa por transacción con lock** (anti-overbooking).
- **Sandbox de Asaas** para todo hasta aprobación explícita de producción.
- **Revisión de riesgo con contexto fresco antes de mergear** (M7 toca pagos, dinero y estados de reserva — obligatoria).
- **Tests de integración contra sandbox de Asaas** como equivalente backend de la verificación visual del frontend. Incluir explícitamente: test de que una reserva manual nunca es barrida por expiración; test de que el check-out se bloquea con saldo>0; test de que un move con conflicto físico se rechaza aún con `force_commercial:true`.
- **Delegación por partes**, cada parte verificada contra su sección de esta spec. No delegar el módulo entero a un agente (200k tokens de lección en 6A).
- Al cerrar, **proponer texto exacto** para el CLAUDE.md del backend si surgió decisión durable.

---

## 14. Orden de construcción sugerido (entregas)

- **7A — Schema + estados + saldo.** Migraciones (§11), máquina de estados (§3), vista de saldo (§5.3), sin UI nueva. Base para todo lo demás.
- **7B — Pagos y check-in/out.** Endpoints de pago con `kind`/`method` (§5.4), webhook que distingue depósito/saldo, check-in/check-out con bloqueo por saldo (§6). Frontend de ficha con saldo y botones.
- **7C — Movimiento de unidad.** `moveNight`/`moveStay` (§4), botón "Cambiar de cuarto" en la ficha, warnings comerciales. **Sin arrastre en el tape chart** (recortado del alcance, ver §4.5) — queda como mejora futura sin cambios de backend.
- **7D — Reservas manuales + cancelación.** Formulario manual (§7), cancel/no-show (§8), extras (§7 dec. abierta 4).

Cada entrega es usable y verificable por sí sola; se puede parar entre entregas y seguir con HQBeds para lo que falte.