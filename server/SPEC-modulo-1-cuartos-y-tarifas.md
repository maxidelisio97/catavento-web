# SPEC — Módulo 1: Cuartos y tarifas

> Spec aprobada en el Project de claude.ai (2026-07-17). Fuente de verdad
> de los datos de este módulo. Implementar tal cual; si algo parece
> mejorable, proponer antes de cambiar (regla del workflow: plan → ok
> de Maxi → implementación).

## Alcance

Modelo de datos y seed inicial de cuartos, precios base y calendario de
overrides. NO incluye disponibilidad/reservas (módulo 2-3) ni panel
(módulo 5). Sí debe dejar los datos listos para que el panel futuro sea
una grilla de calendario editable estilo Booking.com (precio, estadía
mínima y cierre por noche y por cuarto).

## Decisiones de negocio (no reabrir)

- 3 cuartos: Casal (2 pax), Triplo (3), Quádruplo (4).
- Mascotas: solo Triplo y Quádruplo.
- Fin de semana = noches de **viernes y sábado**. Domingo a jueves =
  tarifa de semana.
- SIN temporadas en la base. El dueño edita precios a mano según
  demanda (precios base + overrides por fecha).
- Tarifa por cantidad de huéspedes: soportada desde el día 1 (aunque el
  seed cargue solo la ocupación máxima).
- Estadía mínima por defecto: **1 noche**, editable por cuarto y
  pisable por fecha.
- Descartado explícitamente (no implementar "de más"): temporadas,
  restricciones CTA/CTD (no check-in / no check-out por día).
- El precio de una reserva se congela al crearla (aplica al módulo 3;
  se menciona para que nada de este módulo asuma recálculo retroactivo).

## Esquema (Postgres 18)

Convenciones: dinero en **centavos, INTEGER** (nunca float). Fechas de
noche como DATE (la fila con date 2026-10-15 es la noche del 15 al 16).
Todas las tablas con created_at/updated_at (timestamptz, default now(),
updated_at mantenido por trigger o por la capa de datos).

```sql
CREATE TABLE rooms (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,          -- 'Casal', 'Triplo', 'Quádruplo'
  capacity         INTEGER NOT NULL CHECK (capacity >= 1),
  pets_allowed     BOOLEAN NOT NULL DEFAULT false,
  default_min_stay INTEGER NOT NULL DEFAULT 1 CHECK (default_min_stay >= 1),
  active           BOOLEAN NOT NULL DEFAULT true,
  description      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE room_rates (
  id            SERIAL PRIMARY KEY,
  room_id       INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  occupancy     INTEGER NOT NULL CHECK (occupancy >= 1),
  weekday_cents INTEGER NOT NULL CHECK (weekday_cents >= 0),
  weekend_cents INTEGER NOT NULL CHECK (weekend_cents >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (room_id, occupancy)
);

CREATE TABLE rate_overrides (
  id                 SERIAL PRIMARY KEY,
  room_id            INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  date               DATE NOT NULL,
  price_cents        INTEGER CHECK (price_cents >= 0),      -- NULL = usar base
  min_stay           INTEGER CHECK (min_stay >= 1),          -- NULL = usar default del cuarto
  closed             BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (room_id, date)
);

CREATE INDEX idx_rate_overrides_room_date ON rate_overrides (room_id, date);
```

Notas:
- `rate_overrides.price_cents` pisa el precio de esa noche sin importar
  si es semana o finde (el dueño ya decidió el número final para esa
  fecha). No hay override separado semana/finde por fecha: una fecha es
  un solo día.
- No validar por constraint que `occupancy <= capacity` (cross-table);
  validarlo en la capa de aplicación (Zod) al crear/editar tarifas.
- Una fila de override con los tres campos "vacíos" (price NULL,
  min_stay NULL, closed false) es inútil: la capa de aplicación debe
  borrarla en vez de guardarla.

## Regla de cálculo de precio (para módulos 2-3, definida acá)

Para una estadía de check-in C a check-out S con G huéspedes en el
cuarto R, se recorre cada noche N en [C, S):

1. Si existe override (R, N) con `closed = true` → no hay
   disponibilidad, fin.
2. Precio de la noche:
   - Si existe override (R, N) con `price_cents` no nulo → ese valor.
   - Si no: buscar en room_rates la fila (R, occupancy = G); si no
     existe, la fila de occupancy máxima de R. Usar `weekend_cents` si
     N es viernes o sábado, si no `weekday_cents`.
3. Total = suma de las noches. Este total se congelará en la reserva
   (módulo 3).

Estadía mínima: aplica la de la **fecha de check-in** — el `min_stay`
del override (R, C) si existe y no es nulo, si no
`rooms.default_min_stay`. Si (S − C) < ese valor → no se permite la
reserva.

## Seed (datos reales confirmados 2026-07-17)

| Cuarto | capacity | pets | occupancy seed | semana | finde |
|---|---|---|---|---|---|
| Casal | 2 | false | 2 | 18000 | 22000 |
| Triplo | 3 | true | 3 | 20000 | 25000 |
| Quádruplo | 4 | true | 4 | 23000 | 30000 |

`default_min_stay = 1` en los tres. Sin overrides iniciales.

El seed debe ser idempotente (correrlo dos veces no duplica datos).

## Criterio de "hecho"

- Migraciones versionadas (herramienta a elegir en el repo) que crean
  las tres tablas en catavento_db.
- Seed idempotente con los datos de arriba.
- Función/módulo de cálculo de precio con la regla exacta de esta spec,
  cubierta por tests unitarios que incluyan al menos: estadía solo
  semana, estadía que cruza viernes+sábado, override de precio en una
  noche del rango, noche cerrada dentro del rango, min_stay por
  override en el check-in, y fallback de ocupación (G menor sin fila
  propia → usa ocupación máxima).