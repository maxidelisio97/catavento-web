# Catavento Booking Engine — Backend (server/)

## Qué es esto
Motor de reservas propio de Pousada Catavento (Taíba, CE). Reemplaza
gradualmente a HQBeds. La planificación vive en un Project de claude.ai;
este repo recibe specs ya aprobadas (archivos SPEC-*.md en esta
carpeta). Las specs son fuente de verdad: implementar tal cual, y si
algo parece mejorable, proponerlo antes de cambiar.

## Stack
- Node.js + TypeScript + Fastify. Validación de entrada con Zod.
- Postgres 18 en el VPS (base `catavento_db`, usuario `catavento_app`).
  Cliente/ORM: a proponer al iniciar el módulo 1 (candidatos: pg,
  Drizzle, Kysely) — proponer con justificación y esperar ok.
- Pagos: Asaas (sandbox: sandbox.asaas.com). Docs: docs.asaas.com.
- Proceso gestionado con PM2 (`ecosystem.config.cjs`), detrás de Nginx
  (ver `nginx.conf.example`). Deploy manual (sin CI/CD, decisión
  deliberada para tener control total): `git pull` + `npm run build`
  + `pm2 restart` en el VPS.
- La base `catavento_db` y el usuario `catavento_app` YA EXISTEN en el
  VPS (verificado 2026-07-17, conexión funcional). Las migraciones
  crean/modifican TABLAS, nunca la base ni el usuario. No incluir
  pasos de creación de base/usuario en scripts ni docs de setup.

## Principio: parámetros de negocio como datos, nunca hardcodeados
Todo valor que Maxi pueda querer cambiar (precios, cupos, estadía
mínima, % de depósito, textos de política, tiempos de retención) vive
en la base y será editable desde el panel (M5). Si al implementar
aparece un número de negocio hardcodeado, es un smell: proponer
moverlo a datos. El código define REGLAS; los datos definen VALORES.

## Estado actual del código
Lo que hay en `src/` y `scripts/` es el proof of concept del pago con
Asaas (JavaScript plano, funcional, pago de prueba exitoso en sandbox).
**Primer paso antes del módulo 1: migrar este PoC a TypeScript** sin
cambiar su comportamiento. No tratar el PoC como arquitectura final:
es punto de partida.

## Workflow (heredado del proyecto)
- Validar antes de implementar: proponer plan → ok de Maxi →
  implementar. Nunca implementar directo sobre decisiones nuevas.
- Mantenimiento de este archivo: al cerrar un bloque de trabajo, si
  surgió una decisión durable, PROPONER el texto exacto a agregar y
  esperar aprobación. Nunca editar CLAUDE.md sin ok explícito.
  Criterio: "¿una sesión nueva sin este dato repetiría un error o
  reabriría una decisión?" Si no, no es regla.
- Sesiones separadas por tema para no inflar contexto.

## Reglas de seguridad (no negociables)
- `server/.env` está en .gitignore y NUNCA se commitea. Ninguna
  credencial (API key de Asaas, password de Postgres) en el repo, en
  logs ni en mensajes de error.
- API key de Asaas: solo backend, nunca expuesta al frontend. Antes de
  producción: mover credenciales a secret manager y rotar tanto la key
  de Asaas como la password de `catavento_app`.
- Sandbox de Asaas para TODO hasta aprobación explícita de producción.
- Postgres escucha solo en localhost del VPS. No abrir el puerto.
- Nunca confirmar una reserva sin webhook de pago confirmado de Asaas
  (verificado, no solo recibido).
- Toda escritura sobre disponibilidad pasa por transacción con lock
  (regla anti-overbooking; aplica desde el módulo 2).

## Revisión antes de mergear (módulos de pagos o datos de huéspedes)
Todo módulo que toque pagos, dinero, o datos personales de huéspedes
cierra con una pasada de revisión de riesgo (`review-risk` o
equivalente, con contexto fresco) sobre el diff completo ANTES del
merge a `main` — no alcanza con que los tests pasen. Motivo: en el
módulo 4 esa revisión encontró una race condition real que podía
duplicar el cobro del depósito en Asaas (dos requests concurrentes
podían pasar el chequeo "sin pago pendiente" y cobrar dos veces antes
de que el código local lo detectara) y un log que filtraba PII del
huésped — ninguno de los dos lo hubiera cazado un test unitario ni una
lectura rápida del propio autor del cambio.
Los hallazgos de la revisión se corrigen ANTES del merge (no se
anotan "para después"), o se justifica explícitamente por qué un
hallazgo puede esperar.

## Convenciones de datos
- Dinero: centavos como INTEGER, nunca float.
- Noches: DATE (la fila 2026-10-15 es la noche del 15 al 16).
- Fin de semana = noches de viernes y sábado.
- El precio de una reserva se congela al crearla.

## Módulo 7A — schema real y máquina de estados

### Schema real (nombres — no asumir de memoria)
- payments.status: 'pending'|'received'|'failed'|'refunded'. "Pago
  confirmado" = status='received' (NO 'confirmed', no existe).
- payments.method: 'asaas_pix'|'asaas_card'|'cash'|'external'|'pix_manual'.
- payments.kind: 'deposit'|'balance'|'extra'|'refund'.
- reservations.status: 'pending_payment'|'confirmed'|'checked_in'|
  'checked_out'|'cancelled'|'no_show'|'payment_conflict' (NO 'pending').

### isReservationActive (no romper)
- Debe contar checked_in Y checked_out como ACTIVOS. Si no, el barrido
  perezoso borra las reservation_nights de un huésped con checkout hecho
  — esas filas son registro histórico (M7 §6.2). Bug encontrado y
  corregido en 7A; no "optimizar" esta función sin releer esto.

### Migraciones sobre base de test
- npm run migrate:up:test aplica migraciones contra catavento_db_test
  (scripts/migrateTestDb.ts). Usar eso, no tocar .env a mano.

## Módulo 6A — asignación de unidad por noche (reservation_nights)
- La asignación de unidad física es por noche (`reservation_nights`), no
  por reserva. Una reserva activa SIEMPRE tiene exactamente una fila por
  noche con unidad asignada. La noche de departure no genera fila.
  `reservations.room_unit_id` es legacy (unidad de la primera noche);
  toda lectura nueva usa `reservation_nights`.
- `UNIQUE (room_unit_id, night)` es anti-overbooking a nivel base, no
  solo aplicativo. No removerlo al optimizar.
- No existe cron de expiración: las filas de reservas inactivas se
  liberan con barrido perezoso dentro del lock de `createReservation`,
  acotado a las unidades del tipo pedido y las noches del rango.
  Consecuencia crítica: una reserva vencida puede quedar sin filas antes
  de que llegue su webhook tardío de Asaas. Por eso
  `confirmPendingReservation` re-chequea disponibilidad física antes de
  confirmar y va a `payment_conflict` si la unidad ya no está libre —
  nunca confirmar sin verificar filas.
- El predicado "reserva activa" vive en un solo helper
  (`isReservationActive`). No reescribirlo a mano en ningún lugar de
  lectura ni en el barrido.
- `assertReservationNightsConsistency` se invoca al final de toda
  transacción que toque reservas. Si agregás una ruta nueva que las
  modifique, cableala también.

## Módulo 6C — tape chart y detalle de reserva
- `rooms.sort_order` es la fuente de orden de los grupos de tipo de
  cuarto en el tape chart (hoy: Casal 1, Triplo 2, Quádruplo 3). Es una
  columna explícita, no un CASE por nombre en la query — así, cuando
  el M8 permita renombrar un tipo de cuarto desde el panel, el orden
  del mapa no se desordena en silencio.
- El panel (`panel/`, painel.cataventotaiba.com) NO hereda la
  identidad visual ni las reglas de motion del PRODUCT.md: es back
  office, prioriza densidad y legibilidad de la información.
- Los endpoints `/panel/*` son autenticados y SÍ exponen datos de
  menores (edades de niños, cantidad de bebés). La restricción de la
  risk-review del M4 aplica solo al GET público por código
  (`/api/reservations/:code`). No confundir ambos endpoints.
- El mobile del panel está resuelto a nivel funcional (grilla con
  scroll + drawer), sin pulido visual. Decisión deliberada: el
  rediseño del panel como app queda para después del M7/M8, cuando
  las acciones reales estén definidas. No invertir en pulido visual
  del panel mobile hasta entonces.

## Flujo de ramas
Ver CLAUDE.md raíz — regla de todo el repo, no solo del backend.

## Entornos
- Desarrollo: Windows (PowerShell). Producción: Ubuntu en VPS.
  Los scripts del repo deben ser cross-platform (usar scripts npm y
  Node, no bash-isms ni comandos de un solo sistema).

## Verificación
- Acá NO aplican las reglas de screenshots del frontend. El equivalente
  del backend: tests unitarios para lógica pura (cálculo de precios,
  reglas de estadía) y tests de integración contra el sandbox de Asaas
  para el flujo de pago.
- **`catavento_db_test`** es la única base permitida para tests
  automatizados (mismo Postgres del VPS, mismo usuario `catavento_app`).
  Migraciones y seed de datos reales van SIEMPRE contra `catavento_db`.
  Ningún test debe conectarse a `catavento_db`.

## Plan de módulos (orden; se puede parar en cualquier punto)
1. Cuartos y tarifas (spec: SPEC-modulo-1-cuartos-y-tarifas.md)
2. Disponibilidad (anti-overbooking)
3. Flujo de reserva (pendiente de pago)
4. Pago Asaas (confirma la reserva)
5. Panel interno (calendario editable estilo Booking)
6. Sync con OTAs — ⚠️ HQBeds sigue activo hasta que este módulo esté
   resuelto; es lo único que protege contra overbooking cruzado.