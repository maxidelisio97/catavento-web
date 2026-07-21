# SPEC — Módulo 5: Unidades físicas y asignación

> Spec aprobada en el Project de claude.ai (2026-07-21). Fuente de
> verdad de este módulo. Implementar tal cual; proponer antes de
> cambiar. Se apoya en los módulos 1-4 (en producción).
> REGLA DE SWITCH VIGENTE: el sitio público no cambia en NADA con
> este módulo — el huésped sigue reservando un TIPO de cuarto y nunca
> ve un número de unidad.

## Alcance

Cambio de modelo: nacen las 11 unidades físicas y cada reserva pasa a
tener una unidad asignada. Incluye la lógica de asignación automática
y la adaptación de la disponibilidad/anti-overbooking al nuevo modelo.
NO incluye: panel, login, reasignación manual por UI (llega con el
panel), ni ningún cambio visible en /reservar.

Es el prerequisito del tape chart (mapa de 11 filas) del módulo
siguiente.

## Decisiones de negocio (no reabrir)

- **El huésped reserva un TIPO; la pousada asigna una UNIDAD.** El
  flujo público nunca expone números de cuarto. La asignación es
  información interna.
- Inventario real:
  - Casal (2 pax): **101, 102, 103, 104, 105, 106** (6 unidades)
  - Triplo (3 pax): **7, 8, 9** (3 unidades)
  - Quádruplo (4 pax): **10, 11** (2 unidades)
  - La numeración mezclada (3 cifras y 1 cifra) es correcta, así se
    llaman en la pousada. No "normalizar".
- Las unidades de un mismo tipo son **idénticas** (misma vista, cama,
  tamaño). Por eso el sistema puede autoasignar sin consultar a nadie,
  y reasignar libremente después.
- `rooms.total_units` deja de ser la fuente de verdad del stock: pasa
  a serlo la cantidad de unidades activas. Mantener la columna
  sincronizada o derivarla — proponer cuál al implementar.

## Esquema

```sql
CREATE TABLE room_units (
  id         SERIAL PRIMARY KEY,
  room_id    INTEGER NOT NULL REFERENCES rooms(id),
  label      TEXT NOT NULL UNIQUE,   -- '101', '7', '10'
  active     BOOLEAN NOT NULL DEFAULT true,
  notes      TEXT,                   -- uso interno (ej. "aire roto")
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_room_units_room ON room_units (room_id);

ALTER TABLE reservations ADD COLUMN room_unit_id INTEGER
  REFERENCES room_units(id);
CREATE INDEX idx_reservations_unit_dates
  ON reservations (room_unit_id, check_in, check_out);
```

`room_unit_id` es nullable a propósito: las reservas históricas no la
tienen, y una reserva `pending_payment` PUEDE existir sin unidad
asignada según la decisión de abajo. Toda reserva `confirmed` creada
desde este módulo en adelante DEBE tener unidad.

Seed idempotente con las 11 unidades reales.

## Decisión clave: cuándo se asigna la unidad

**Al crear la reserva (en `pending_payment`), no al confirmar.**
Motivo: la reserva pendiente ya retiene inventario (módulo 2); si no
se le asigna unidad, dos pendientes podrían quedar sin unidad
concreta disponible y el conflicto aparecería recién al pagar, que es
el peor momento. Asignar temprano hace que el conflicto se detecte
donde ya sabemos manejarlo (la transacción con lock).

Si la reserva expira o se cancela, la unidad queda libre por la misma
regla de estados del módulo 2 (no hace falta liberar nada a mano).

## Regla de asignación (algoritmo)

Dentro de la transacción con lock existente (`SELECT ... FOR UPDATE`
sobre `rooms`), al crear una reserva del tipo R para el rango
[check_in, check_out):

1. Listar unidades activas de R.
2. Descartar las que tengan alguna reserva activa (misma definición
   de "activa" del módulo 2: `confirmed`, o `pending_payment` no
   expirada) solapando el rango.
3. Descartar las noches cerradas por calendario: si `rate_overrides`
   marca `closed` o reduce `units_available` para alguna noche del
   rango, el cupo total sigue mandando — ver "Convivencia con el
   calendario" abajo.
4. Si no queda ninguna unidad libre → `NO_AVAILABILITY` (mismo error
   que hoy), rollback.
5. Si queda al menos una, elegir con este criterio determinista
   (documentarlo, no dejarlo al azar):
   **la unidad libre cuyo `label` ordena primero**, para que la
   ocupación se concentre y queden tramos largos libres — esto reduce
   la fragmentación. Empate imposible (label es único).

## Convivencia con el calendario (`units_available`)

`rate_overrides.units_available` sigue significando "cuántas unidades
de este tipo son vendibles esa noche" (sirve para descontar ventas de
OTAs mientras siga HQBeds). Regla combinada, para una noche N:

`vendibles(R,N) = min(cupo del calendario, unidades activas libres)`

O sea: el calendario puede REDUCIR, nunca aumentar. Si el calendario
dice 4 y hay 5 unidades libres, se pueden vender 4. La unidad concreta
que se descuenta no está identificada (la venta de OTA no dice cuál),
así que el bloqueo del calendario se aplica como conteo, no como
unidad. Si esto genera un conflicto real en el mapa (el panel muestra
5 libres pero el calendario permite 4), el panel lo mostrará como
advertencia — fuera de alcance de este módulo.

## Adaptación de lo existente

- `GET /api/availability`: sin cambios en su contrato público (sigue
  respondiendo por tipo). Internamente pasa a calcular sobre unidades.
  `units_left` = unidades libres reales del rango, acotado por el
  calendario.
- `createReservation`: suma la asignación descrita arriba.
- `GET /api/reservations/:code` (público): **NO expone la unidad**.
  El huésped reserva un tipo; el número de cuarto es interno.
- El 201 de creación tampoco expone la unidad.
- Ningún cambio en el frontend de /reservar.

## Tests exigidos

Contra catavento_db_test:
1. Seed: 11 unidades, con los labels exactos y su tipo correcto.
2. Asignación básica: reserva de Casal → obtiene una unidad de Casal
   (nunca de otro tipo), y es la de label menor entre las libres.
3. Solapamiento: dos reservas del mismo tipo en fechas superpuestas
   obtienen unidades DISTINTAS.
4. Sin fragmentación falsa: con todas las Casal ocupadas menos una,
   una reserva que solapa parcialmente con varias obtiene la única
   realmente libre en TODO el rango (no una libre "a medias").
5. Agotamiento: con las 6 Casal ocupadas en una noche del rango →
   `NO_AVAILABILITY`, sin fila creada.
6. Liberación: una reserva `cancelled` o `pending_payment` expirada
   libera su unidad para una reserva nueva.
7. Calendario: `units_available = 2` en una noche limita a 2 aunque
   haya 6 unidades libres; `closed` sigue bloqueando todo.
8. Concurrencia (adaptación del test del módulo 2): con UNA unidad
   libre, dos creaciones simultáneas → una gana, la otra
   `NO_AVAILABILITY`. Nunca dos reservas activas sobre la misma
   unidad en la misma noche.
9. El endpoint público de reserva por código NO devuelve la unidad
   (test que falla si alguien la agrega, mismo patrón que el de
   menores).

## Criterio de "hecho"

- Migración + seed corridos vía túnel en catavento_db.
- Tests verdes (los 9, más los existentes sin romper).
- Verificación en producción: crear una reserva de prueba en
  /reservar, confirmar por consulta directa a la base que quedó con
  `room_unit_id` asignado, y que la respuesta pública NO lo expone.
  Borrar la fila de prueba.
- El sitio público y /reservar se comportan EXACTAMENTE igual que
  antes (ningún cambio visible para el huésped).
- Risk-review antes del merge (toca datos de reservas).