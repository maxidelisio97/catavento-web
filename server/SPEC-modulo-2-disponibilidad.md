# SPEC — Módulo 2: Disponibilidad y anti-overbooking

> Spec aprobada en el Project de claude.ai (2026-07-20). Fuente de
> verdad de este módulo. Implementar tal cual; si algo parece
> mejorable, proponer antes de cambiar. Se apoya en el módulo 1
> (SPEC-modulo-1-cuartos-y-tarifas.md), ya en producción.

## Alcance

Modelo de disponibilidad por conteo de unidades, tabla de reservas
(mínima, la extiende el módulo 3), la transacción anti-overbooking, y
un endpoint de consulta de disponibilidad de solo lectura. NO incluye:
flujo de creación de reserva desde la web (módulo 3), pagos (módulo 4),
ni panel (módulo 5).

## Decisiones de negocio (no reabrir)

- Inventario real: **Casal 6 unidades, Triplo 3, Quádruplo 2** (11
  cuartos). Los cuartos de un mismo tipo son intercambiables: NO se
  modela el cuarto físico, solo el tipo con stock (disponibilidad por
  conteo, como los channel managers). La asignación del cuarto físico
  al huésped es operación manual de la pousada, fuera del sistema.
- Una noche de un tipo está disponible si
  `reservas activas de esa noche < cupo de esa noche`.
- El cupo de una noche puede reducirse a mano desde el calendario
  (para descontar ventas de OTAs mientras siga HQBeds, o mantenimiento
  de un cuarto). `closed = true` sigue significando cupo 0.
- La noche de check-out NO se ocupa: una reserva del 10 al 13 ocupa
  las noches 10, 11 y 12.
- Estados de reserva: `pending_payment` → `confirmed` → (o)
  `cancelled`. Una reserva `pending_payment` RETIENE inventario
  mientras no expire (evita que dos huéspedes paguen lo mismo); la
  política exacta de expiración (cuánto tiempo) se define en el
  módulo 3-4 — acá solo se soporta con `expires_at`.

## Cambios de esquema (migración nueva; nunca editar migraciones ya
corridas)

```sql
-- 1) Stock por tipo
ALTER TABLE rooms ADD COLUMN total_units INTEGER NOT NULL DEFAULT 1
  CHECK (total_units >= 0);
-- seed/update: Casal = 6, Triplo = 3, Quádruplo = 2

-- 2) Cupo por fecha en el calendario existente
ALTER TABLE rate_overrides ADD COLUMN units_available INTEGER
  CHECK (units_available >= 0);
-- NULL = usar rooms.total_units. Si closed = true, el cupo es 0
-- sin importar units_available.

-- 3) Reservas (mínima; el módulo 3 la extiende)
CREATE TABLE reservations (
  id           SERIAL PRIMARY KEY,
  room_id      INTEGER NOT NULL REFERENCES rooms(id),
  check_in     DATE NOT NULL,
  check_out    DATE NOT NULL,
  guests       INTEGER NOT NULL CHECK (guests >= 1),
  status       TEXT NOT NULL DEFAULT 'pending_payment'
               CHECK (status IN ('pending_payment','confirmed','cancelled')),
  expires_at   TIMESTAMPTZ,           -- solo aplica a pending_payment
  total_cents  INTEGER NOT NULL CHECK (total_cents >= 0),  -- precio congelado (módulo 1)
  guest_name   TEXT,
  guest_email  TEXT,
  guest_phone  TEXT,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (check_out > check_in)
);

CREATE INDEX idx_reservations_room_dates
  ON reservations (room_id, check_in, check_out);
CREATE INDEX idx_reservations_status ON reservations (status);
```

Los campos de huésped son nullable a propósito: el módulo 3 define
cuáles son obligatorios en el flujo web. No agregar más campos ahora.

## Regla de disponibilidad (definición exacta)

Para el tipo R y la noche N:

1. `cupo(R,N)`:
   - si existe override (R,N) con `closed = true` → 0
   - si existe override (R,N) con `units_available` no nulo → ese valor
   - si no → `rooms.total_units`
2. `ocupadas(R,N)` = cantidad de filas de `reservations` con
   `room_id = R`, `check_in <= N < check_out` y estado "activo":
   - `confirmed` siempre cuenta
   - `pending_payment` cuenta solo si `expires_at IS NULL OR
     expires_at > now()`
   - `cancelled` nunca cuenta
3. `disponibles(R,N) = cupo(R,N) − ocupadas(R,N)` (mínimo 0).

Un rango [check_in, check_out) es reservable para R si
`disponibles(R,N) >= 1` para TODAS sus noches, y además cumple la
estadía mínima del módulo 1 (min_stay del override del check-in, o
default del cuarto).

## Transacción anti-overbooking (corazón del módulo)

Función `createReservation(roomId, checkIn, checkOut, guests, ...)`
que será consumida por el módulo 3. Dentro de UNA transacción:

1. `SELECT ... FROM rooms WHERE id = $roomId FOR UPDATE`
   — lockea la fila del tipo de cuarto y serializa toda creación de
   reservas de ese tipo (a esta escala, la simplicidad de un lock por
   tipo le gana a esquemas más finos; no optimizar sin pedirlo).
2. Recalcular disponibilidad de TODAS las noches del rango (regla de
   arriba) DENTRO de la transacción.
3. Si alguna noche no tiene cupo → ROLLBACK y error tipado
   (p.ej. `NO_AVAILABILITY` con la primera noche conflictiva).
4. Si hay cupo → calcular precio con el módulo 1, INSERT de la reserva
   en `pending_payment` con el precio congelado, COMMIT.

Regla absoluta: NINGUNA escritura sobre `reservations` que afecte
inventario (crear, confirmar, reactivar) ocurre fuera de este patrón
de transacción con lock. Cancelar sí puede ser una escritura simple.

## Endpoint (solo lectura)

`GET /api/availability?check_in=YYYY-MM-DD&check_out=YYYY-MM-DD&guests=N`

Respuesta: por cada tipo de cuarto activo con `capacity >= guests`:

```json
{
  "check_in": "...", "check_out": "...", "guests": 2,
  "rooms": [
    {
      "room_id": 1, "name": "Casal", "capacity": 2,
      "available": true,          // reservable el rango completo
      "units_left": 3,            // mínimo de disponibles(N) del rango
      "total_cents": 58000,       // precio del rango (módulo 1)
      "min_stay_ok": true
    }
  ]
}
```

Validación con Zod: fechas válidas, `check_out > check_in`, `guests
>= 1`, rango máximo razonable (60 noches). Sin autenticación por ahora
(es lectura pública, la va a consumir el sitio).

## Tests exigidos

Unitarios (contra catavento_db_test, NUNCA catavento_db):
1. Sin reservas: `disponibles = total_units` en cualquier noche.
2. Una reserva 10→13 ocupa las noches 10, 11 y 12 — la noche 13 queda
   libre (check-out no ocupa).
3. `units_available` en override reduce el cupo de esa noche.
4. `closed = true` da cupo 0 aunque `units_available` diga otra cosa.
5. Reserva `cancelled` no ocupa; `pending_payment` expirada no ocupa;
   `pending_payment` vigente sí ocupa.
6. `createReservation` rechaza con `NO_AVAILABILITY` cuando una sola
   noche del rango está llena, y no deja fila creada (rollback).
7. Estadía mínima: rechaza si `(check_out − check_in) < min_stay`
   aplicable.

De concurrencia (el test que justifica el módulo):
8. Con cupo 1 restante, dos `createReservation` simultáneas (dos
   conexiones reales en paralelo) → exactamente UNA gana y la otra
   recibe `NO_AVAILABILITY`. Nunca dos filas activas.

## Criterio de "hecho"

- Migración corrida (vía túnel) en catavento_db con los valores de
  stock reales (6/3/2).
- Los 8 tests verdes contra catavento_db_test.
- `GET /api/availability` respondiendo en local y, tras deploy manual,
  en el VPS.
- Nada del módulo 3 implementado "de paso" (ni endpoint de creación de
  reservas ni flujo de pago): `createReservation` existe y está
  testeada, pero no se expone por HTTP todavía.