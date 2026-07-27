# SPEC — Módulo 8: Configuración

> Booking engine propio de Pousada Catavento (Taíba, Ceará).
> Spec de implementación para Claude Code. Fuente de verdad de las decisiones de M8.
> Redactada: 2026-07-24. Estado: **aprobada para implementar**.

---

## 0. Contexto y posición en el plan

M8 le da al panel el control de la **configuración del negocio**: los parámetros y precios que hoy solo se editan por SQL directo contra la base. Es el módulo que vuelve el motor autónomo del código —el dueño ajusta precios, cupos, mínimos y parámetros sin tocar la base a mano.

**Hallazgo clave del descubrimiento (verificado contra el código, no asumido):** todo el backend de precio y disponibilidad **ya funciona de punta a punta**. M8 NO toca el motor de cálculo. Es 100% **capa de panel**: endpoints de lectura/escritura + UI, sobre datos que ya existen y ya se consumen.

- `settings` (tabla key/value, tipada por Zod en `settings.ts`): `deposit_percent`, `hold_minutes`, `pet_fee_cents` ya viven ahí y se leen con `getSetting`/`getBusinessSettings`.
- `room_rates` (`room_id` + `occupancy` → `weekday_cents`, `weekend_cents`): ya consumida por el cálculo de precio.
- `rate_overrides` (`room_id`, `date`, `price_cents`, `min_stay`, `closed`, `units_available`): **cableada de punta a punta** — `calculatePrice.ts` usa precio/min_stay/cierre, `calculateAvailability.ts` usa `units_available` (reduce cupo) y `closed` (fuerza cupo a 0).

**Lo que NO existe hoy:** ningún endpoint de configuración en el panel. M8 los crea todos desde cero, siguiendo el patrón ya establecido (`requireAuth(db)` como hook scoped por plugin, ver `panelTapeChart.ts`; Zod para request/response; Kysely tipado contra `db/types.ts`).

**No toca:** el motor de precio/disponibilidad (ya funciona), OTAs (M12), permisos por empleado (M9 — en M8 cualquier usuario autenticado puede editar toda la configuración).

---

## 1. Principio rector

> **M8 es capa de panel sobre un backend que ya funciona. Cero cambios al motor de precio/disponibilidad. Si al implementar aparece la tentación de tocar `calculatePrice` o `calculateAvailability`, parar y preguntar —probablemente sea señal de que algo del alcance se entendió mal.**

La única lógica nueva de M8 es de **validación de escritura** (qué valores se aceptan y con qué guardas), no de cálculo.

---

## 2. Reglas duras que NO son configurables

Estas son reglas de negocio, no parámetros. M8 **no** las expone como editables. Si la UI diera la impresión de que se pueden cambiar, está mal.

- **Mascotas: solo en Triplo y Cuádruple** (nunca en Casal). M8 edita el **monto** de la tarifa de mascota (`pet_fee_cents`), NO en qué cuartos aplica.
- **`adults_only` en Casal** (no admite niños ni bebés). Regla dura.
- **Fin de semana = viernes + sábado.** Regla dura del backend, define qué noches usan `weekend_cents`. No configurable.
- **Ocupaciones de cada cuarto** (las filas de `room_rates` por `occupancy`): las define el cuarto desde M1. M8 edita los precios de las filas existentes, NO crea ni borra filas de ocupación.

---

## 3. Entregas

M8 se parte en **tres entregas**, de menor a mayor complejidad. Cada una es usable por sí sola y se puede parar entre ellas.

- **8A — Settings globales.** La más chica: 3 valores sueltos, sin relación entre filas, sin guardas de integridad.
- **8B — Precios base por cuarto** (`room_rates`). Edición de precios existentes; sin guardas de integridad (el precio se congela por reserva, no invalida reservas viejas).
- **8C — Calendario de overrides** (`rate_overrides`). La pesada: dos modos de UI (grilla mensual + rango) y la única regla de integridad real del módulo (la guarda de `units_available`).

---

## 4. Entrega 8A — Settings globales

### 4.1 Alcance

Tres parámetros globales que hoy viven en `settings` y se editan por SQL:
- `deposit_percent` — porcentaje de depósito al reservar (default 50).
- `hold_minutes` — minutos que se sostiene una reserva sin pagar antes de expirar (default 30).
- `pet_fee_cents` — tarifa de mascota por noche, por reserva (default 3000 = R$30).

### 4.2 Backend

```
GET   /panel/settings   → { deposit_percent, hold_minutes, pet_fee_cents }
PATCH /panel/settings   → body parcial, actualiza solo las keys enviadas
```

- Bajo `requireAuth`, patrón scoped por plugin.
- Validación Zod **reusando los schemas de `settings.ts`** (ya existen tipados por key — no redefinir). Si `settings.ts` no expone un schema reutilizable por key, crear uno mínimo, pero primero verificar qué hay.
- Validaciones de valor (definir en el plan, pero al menos):
  - `deposit_percent`: entero 0–100. (¿Se permite 0? ¿100? — 0 significaría "sin depósito, se paga todo al final"; 100 "se paga todo al reservar". Ambos son configuraciones de negocio válidas. Permitir 0–100 salvo que haya razón para acotar.)
  - `hold_minutes`: entero positivo, con un mínimo sensato (un hold de 0 minutos rompería el flujo de pago). Proponer un piso.
  - `pet_fee_cents`: entero ≥ 0 (0 = mascotas gratis, válido).
- El PATCH escribe en `settings` con el mismo mecanismo que ya usa el backend para leer. **No cachear** de forma que el cambio no se refleje —verificar si `getBusinessSettings` cachea en memoria y, si lo hace, que el PATCH invalide el cache o que el cache tenga TTL corto. Este es el único punto sutil de 8A.

### 4.3 Frontend

- Form simple, 3 campos, en una sección "Configuración" del panel.
- Mostrar valores actuales al cargar (GET), guardar con PATCH.
- Feedback claro de guardado exitoso / error de validación.
- `pet_fee_cents` y `deposit_percent` se muestran en unidades humanas (R$ y %), se convierten a cents/entero al enviar.

### 4.4 Sin guardas de integridad

Cualquier valor válido se aplica de inmediato. Cambiar estos parámetros **no invalida reservas existentes**: `deposit_cents` y el total se congelan por reserva al crearla (confirmado en el código). Un cambio de `pet_fee_cents` afecta solo reservas nuevas.

---

## 5. Entrega 8B — Precios base por cuarto (`room_rates`)

### 5.1 Alcance

Editar los precios base por tipo de cuarto y ocupación: `weekday_cents` y `weekend_cents` de cada fila existente de `room_rates`.

### 5.2 Backend

```
GET   /panel/room-rates          → todas las filas, agrupadas por cuarto
PATCH /panel/room-rates/:id      → editar weekday_cents / weekend_cents de una fila
```

(o un PATCH batch si conviene para la UI de tabla — decidir en el plan.)

- Bajo `requireAuth`.
- **No crea ni borra filas de ocupación** (eso lo define el cuarto en M1). Solo edita precios de filas existentes.
- Validación: `weekday_cents` / `weekend_cents` enteros ≥ 0. (¿Precio 0 válido? Probablemente sí para casos raros, pero un precio 0 accidental es peligroso —proponer si se advierte o se permite libre.)

### 5.3 Frontend

- Tabla por tipo de cuarto × ocupación, con `weekday_cents` / `weekend_cents` editables inline.
- Mostrar en R$, convertir a cents al enviar.
- Guardado claro por fila o batch.

### 5.4 Sin guardas de integridad

Cambiar un precio base **no invalida reservas ya congeladas** — el precio se congela en `createReservation` (confirmado). El cambio afecta solo reservas nuevas.

---

## 6. Entrega 8C — Calendario de overrides (`rate_overrides`)

La entrega pesada: dos modos de interacción y la única guarda de integridad real del módulo.

### 6.1 Alcance

Por cuarto + fecha, pisar cualquiera de:
- `price_cents` — precio de esa noche (override del precio base).
- `min_stay` — estadía mínima de esa noche (default 1, editable).
- `closed` — cerrar la noche (fuerza cupo a 0, no se puede reservar).
- `units_available` — cupo parcial de esa noche (reduce las unidades disponibles).

**Las cuatro columnas conviven en la misma fila por noche.** Un override puede pisar solo una o varias.

### 6.2 Backend — lectura

```
GET /panel/rate-overrides?room_id=X&from=YYYY-MM-DD&to=YYYY-MM-DD
    → filas de override existentes en el rango, para pintar la grilla
```

- Devuelve solo las noches que tienen override (las que no, usan el precio base / min_stay default / cupo total — el frontend las pinta como "sin override").
- Para la grilla mensual: el frontend pide un mes (o el rango visible) y pinta cada día con su override si existe.

### 6.3 Backend — escritura

Dos operaciones:

```
PUT   /panel/rate-overrides                → día puntual (una noche, un cuarto)
      body: { room_id, date, price_cents?, min_stay?, closed?, units_available? }

PATCH /panel/rate-overrides/range          → aplicar a un rango de noches
      body: { room_id, from, to, price_cents?, min_stay?, closed?, units_available? }
```

- Campos opcionales: se pisan solo los enviados. Enviar `price_cents` sin `min_stay` pisa solo el precio, deja el resto como estaba.
- Para "quitar" un override de un campo (volver al base): definir en el plan cómo se expresa —¿un `null` explícito borra el override de ese campo?, ¿un valor centinela? Proponer. Importante que se pueda **volver al precio base** sin borrar toda la fila si otros campos siguen pisados.
- Bajo `requireAuth`, escritura bajo transacción.

### 6.4 La guarda de integridad — `units_available` (LA regla del módulo)

**`price_cents`, `min_stay` y `closed` no tienen guarda** — cambiarlos no rompe nada existente (el precio se congela por reserva; subir el min_stay no afecta reservas ya hechas; `closed` no des-reserva a nadie, solo impide nuevas).

**`units_available` SÍ tiene guarda dura:**

> No se puede bajar `units_available` de una noche por debajo de las unidades **ya ocupadas** esa noche.

Ejemplo: un cuarto tiene 6 unidades físicas, 4 ya están reservadas para el 15 de enero. Poner `units_available = 3` para esa noche es imposible —no se puede des-reservar a nadie. El backend debe **rechazar** ese valor.

- Antes de aceptar una baja de cupo, contar las unidades ya ocupadas esa noche (vía `reservation_nights` / el mecanismo de disponibilidad ya existente).
- Si el nuevo `units_available` < unidades ocupadas esa noche → **rechazo de esa noche**, con detalle: cuántas hay reservadas.
- Aplica tanto al día puntual como a cada noche de un rango.

### 6.5 Comportamiento del rango parcial (decisión de negocio cerrada)

Cuando un PATCH de rango incluye `units_available` y **una o más noches** del rango no pueden bajar el cupo (ya tienen más reservas que el nuevo valor):

**Decisión: aplicar lo que se pueda, informar lo que no (parcial, no todo-o-nada).**

- Las noches que **sí** pueden se aplican.
- Las noches que **no** pueden se dejan como estaban.
- La respuesta informa **exactamente qué noches fallaron y por qué**, no un genérico.

**Requisito de UX (no negociable):** el reporte de resultado tiene que ser específico. Si se pisan 30 noches y 3 fallan, la respuesta dice **cuáles 3** (las fechas) y **cuántas reservas tiene cada una**. Un "algunas noches no se aplicaron" genérico deja al dueño en un estado parcial sin saber qué pasó —eso es peor que rechazar todo. La UI muestra ese detalle de forma clara (ej. "Se aplicó a 27 noches. No se pudo en el 15/01 (4 reservas), 16/01 (5 reservas), 22/01 (4 reservas) — el cupo pedido era menor a lo ya reservado").

- **Importante:** esta lógica parcial aplica **solo a `units_available`**. Para `price_cents`, `min_stay` y `closed`, un rango se aplica **siempre entero** (nunca fallan por integridad). Si un mismo PATCH de rango incluye precio Y cupo, el precio se aplica a todo el rango y el cupo aplica parcial —definir en el plan cómo se reporta un resultado mixto (probablemente: precio/min/closed aplicados a todo, y el detalle de cupo aparte).

### 6.6 Frontend

Dos modos, ambos sobre el mismo backend:

**Grilla mensual (vista rápida + edición puntual):**
- Un mes a la vista, por cuarto (o todos los cuartos —decidir en el plan qué es más usable; el dueño pidió "grilla tipo Booking").
- Cada día muestra su estado: precio (base u override), min_stay si != 1, cerrado, cupo si está reducido.
- Click en un día → editar ese override (PUT día puntual).
- Distinguir visualmente día con override vs día en base.

**Selección de rango (edición en lote):**
- Seleccionar un rango de fechas (ej. "todo enero") y aplicar un cambio de una (PATCH rango).
- Ej. de uso real del dueño: "subí el precio de todo enero", "cerrá del 20 al 25", "poné mínimo 3 noches en carnaval".
- Mostrar el resultado del rango, con el detalle de noches fallidas de cupo (§6.5) cuando aplique.

### 6.7 Nota sobre `closed` vs `units_available`

Son cosas distintas que conviven en la fila:
- `closed = true` → la noche no se puede reservar, cupo forzado a 0 (independiente de `units_available`).
- `units_available = N` → cupo reducido a N (pero abierto).

La UI tiene que dejar clara la diferencia: "cerrado" (nadie entra) vs "cupo reducido" (entran hasta N). Cerrar una noche que ya tiene reservas: `closed` no des-reserva a los que ya están (igual que subir precio no los afecta), solo impide **nuevas** reservas —así que `closed` NO tiene la guarda de `units_available`. Confirmar este comportamiento contra `calculateAvailability` al implementar.

---

## 7. Reglas de implementación (heredadas)

- **Verificación de rama como PRIMER paso** de todo trabajo nuevo.
- **Validar-antes-de-implementar:** proponer plan de cada entrega → OK → implementar.
- **Descubrimiento primero:** antes de cada entrega, verificar el estado real del código relevante (schema, funciones que consumen los datos) — no asumir de memoria. (M8 nació de un descubrimiento que confirmó que todo el backend ya funciona; mantener ese rigor por entrega.)
- **La suite es determinística** (5/5 verde tras el trabajo de la barrera): un rojo ahora es señal real, no flake. No tratar un fallo como ambiental.
- **Toda escritura que afecte disponibilidad** (el `units_available` de 8C) con el cuidado de siempre. La guarda de cupo se cuenta contra el estado real de `reservation_nights` bajo la consistencia adecuada —si dos operarios editan el cupo de la misma noche a la vez, o si entra una reserva mientras se edita, la guarda no puede quedar desactualizada. Definir en el plan de 8C si hace falta lock o basta la transacción.
- **Delegación por partes:** backend de una entrega, después su frontend; cada parte verificada contra su sección.
- **Al cerrar, proponer texto exacto** para `server/CLAUDE.md` si surge decisión durable.

## 8. Riesgo y revisión

M8 **no toca dinero en tiempo real** (no hay pagos, no hay confirmación de reservas), así que no gatilla la regla de risk-review obligatoria de M7. **Excepción: la guarda de `units_available` de 8C toca disponibilidad física** — bajar mal el cupo podría, en teoría, permitir un overbooking si la guarda se cuenta contra un estado desactualizado. Por eso **8C sí merece una risk-review de contexto fresco antes de mergear**, enfocada en: ¿puede la guarda de cupo quedar desincronizada del estado real de reservas? 8A y 8B no la necesitan (no tocan disponibilidad ni dinero).

---

## 9. Resumen de endpoints de M8

```
# 8A
GET   /panel/settings
PATCH /panel/settings

# 8B
GET   /panel/room-rates
PATCH /panel/room-rates/:id        (o batch)

# 8C
GET   /panel/rate-overrides?room_id&from&to
PUT   /panel/rate-overrides                    (día puntual)
PATCH /panel/rate-overrides/range              (rango, cupo parcial)
```

Todos bajo `requireAuth`. Ninguno toca el motor de precio/disponibilidad —solo leen y escriben los datos que ese motor ya consume.

---

## 10. Orden de construcción sugerido

- **8A** primero — la más chica, valida el patrón de endpoint de config + UI de settings. Cierra rápido.
- **8B** — reusa el patrón de 8A sobre `room_rates`. Tabla editable.
- **8C** — la pesada, al final. Backend (lectura + día puntual + rango con guarda de cupo) → frontend (grilla + rango). Su propia risk-review antes de mergear por tocar disponibilidad.

Cada entrega usable y verificable por sí sola; se puede parar entre ellas y seguir editando por SQL lo que falte.