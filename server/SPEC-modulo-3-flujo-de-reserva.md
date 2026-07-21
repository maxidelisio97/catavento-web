# SPEC — Módulo 3: Flujo de reserva web

> Spec aprobada en el Project de claude.ai (2026-07-20). Fuente de
> verdad de este módulo. Implementar tal cual; si algo parece
> mejorable, proponer antes de cambiar. Se apoya en los módulos 1 y 2
> (ya en producción). REGLA DE SWITCH VIGENTE: nada de esto se enlaza
> desde el sitio público — el form del hero sigue mandando a HQBeds.

## Alcance

El huésped puede, en una página nueva NO enlazada del sitio: consultar
disponibilidad, elegir tipo de cuarto, dejar sus datos y crear una
reserva `pending_payment` que retiene inventario por 30 minutos. El
módulo TERMINA ahí: la pantalla final es un "aguardando pago"
placeholder. El pago real (Asaas) es el módulo 4 y se enchufa en ese
punto. Sin panel, sin cancelación por el huésped, sin emails (módulos
posteriores).

## Decisiones de negocio (no reabrir)

- Flujo: fechas + huéspedes → tipos disponibles con precio total real
  → elige tipo → datos del huésped → reserva creada (30 min para
  pagar). El selector de tipo de cuarto EXISTE (la limitación era de
  HQBeds, ya no aplica).
- Datos del huésped: nombre completo, email y teléfono/WhatsApp
  OBLIGATORIOS; comentarios opcional. Nada más (sin documento ni
  dirección en esta etapa).
- Retención de inventario: `expires_at = now() + 30 minutos` al crear.
  Una reserva expirada no ocupa inventario (regla del módulo 2, ya
  implementada) — no hace falta job de limpieza en este módulo.
- Métodos de pago previstos: PIX y tarjeta. SIN boleto en el checkout
  web (incompatible con retención de 30 min). Esto condiciona al
  módulo 4, se fija acá.
- Idioma del checkout: solo PT (coherente con el sitio; i18n diferida).

## Backend

### Migración (nueva, no editar las corridas)

```sql
ALTER TABLE reservations ADD COLUMN code TEXT UNIQUE;
-- código público de referencia, p.ej. 8 chars alfanuméricos en
-- mayúscula sin ambiguos (sin 0/O/1/I). Generado por la app al crear.
-- Las filas de test existentes no lo tienen: nullable está bien;
-- toda reserva nueva creada por la API lo lleva SIEMPRE.
```

El `code` existe para no exponer IDs seriales en URLs públicas y para
que el huésped tenga una referencia ("Reserva ABC23XYZ") usable por
WhatsApp con la pousada.

### Endpoints nuevos

**POST /api/reservations** — crea la reserva.
- Body (Zod): `room_id`, `check_in`, `check_out`, `adults`,
  `children?` (default 0), `babies?` (default 0), `children_ages?`
  (default `[]`, un entero por niño, rango 3-17 inclusive — 0-2 es
  bebé por definición, no niño), `guest_name` (min 3), `guest_email`
  (email válido), `guest_phone` (min 8), `notes?` (max 500).
  **`guests` NO se acepta en el body** — lo calcula el server
  (`guests = adults + children`; los bebés nunca cuentan para el
  cupo) y nunca confía en un valor de guests mandado por el cliente
  (agregado 2026-07-21, ver SPEC-modulo-1 § Niños y bebés).
- Validaciones de negocio además del shape:
  - `children_ages.length === children`, cada valor entero en [3, 17].
  - Si el cuarto tiene `adults_only = true` y (`children > 0` o
    `babies > 0`) → 400 con mensaje `ADULTS_ONLY_ROOM: ...` (razón de
    rechazo distinta de la de cupo, para que el consumidor de la API
    las distinga).
  - `guests (adults + children) <= capacity` del cuarto; cuarto
    activo; mismas reglas de rango que /api/availability (check_out >
    check_in, máx 60 noches, fechas no pasadas).
- Internamente llama a `createReservation` del módulo 2 (transacción +
  lock — NO reimplementar), seteando `expires_at = now() + 30 min` y
  generando `code`.
- Respuestas: 201 con `{ code, status, check_in, check_out, guests,
  children, babies, children_ages, room: {id, name}, total_cents,
  expires_at }`. 409 con `NO_AVAILABILITY` si el lock rechaza. 400
  validación. NUNCA devolver el `id` serial ni datos que el cliente no
  mandó.

**GET /api/reservations/:code** — consulta pública por código.
- Devuelve un subset seguro: `{ code, status, check_in, check_out, guests,
  room: {id, name}, total_cents, deposit_cents, expires_at }` + los campos
  de pago (`payment_status`, `payment`). Sin email/teléfono completos, y
  (decisión 2026-07-21) sin `children`/`babies`/`children_ages` — el código
  no es un secreto fuerte (viaja por WhatsApp, queda en capturas), y esos
  campos son dato de menores que nadie necesita leer desde un endpoint
  compartible; solo el 201 de creación los incluye. 404 si no existe.
- Si está `pending_payment` y ya expiró, devolver `status: "expired"`
  (estado calculado, no hace falta escribir en la base).

Ambos públicos, sin auth. Mismo origen que el sitio (sin CORS
especial).

### Infraestructura

- Nginx del VPS: agregar `location /api/ { proxy_pass al puerto del
  backend }` para que la API sea accesible desde el dominio público
  (hoy solo responde en localhost del VPS). Actualizar
  `nginx.conf.example` y pasar a Maxi los pasos manuales para aplicar
  en el VPS real. Esto expone /api/rooms, /api/availability y los dos
  endpoints nuevos: todos públicos por diseño.

## Frontend (página no enlazada)

Ruta nueva `/reservar` en el sitio React existente. NO se agrega
ningún link desde el sitio; se accede solo por URL directa (regla de
switch). Aplican las reglas del CLAUDE.md raíz (visual system sand/
stone/coral, Fraunces/Inter, verificación con screenshots, alt text).

Flujo en la página:
1. **Fechas + huéspedes**: reusar el patrón del form del hero (rango
   con react-day-picker + huéspedes). Acepta también llegar con
   `?arrival&departure&adults` en la URL (deja listo el enganche
   futuro del form del hero, sin activarlo).
2. **Resultados**: cards por tipo de cuarto desde /api/availability —
   nombre, capacidad, precio TOTAL del rango en R$ (formatear desde
   cents), unidades restantes solo si <= 2 ("¡Últimas 2!" discreto,
   coherente con la marca: sin urgencia agresiva). Tipos sin
   disponibilidad: mostrarlos deshabilitados con "sin disponibilidad
   para esas fechas" (no ocultarlos).
3. **Datos**: nombre, email, teléfono, comentarios. Validación en
   cliente espejando la del backend.
4. **Confirmación**: POST → pantalla con código de reserva, resumen,
   total, y aviso de 30 minutos. Placeholder claro de "acá va el pago
   (módulo 4)". Countdown simple de expiración es bienvenido pero no
   requisito.
5. Errores: 409 → "esas fechas se acaban de ocupar" + volver al paso
   1 con las fechas cargadas. 400 → mensajes por campo.

Copy en PT, tono de la marca (cálido, sin gritar urgencia). El copy
nuevo de esta página no pasa por la regla de "no reescribir copy"
(es contenido nuevo), pero sí mostrar la página a Maxi antes del
merge.

## Tests exigidos

Contra catavento_db_test (guard vigente):
1. POST happy path: 201, code generado, expires_at ≈ now+30min,
   status pending_payment, total_cents correcto (reusa cálculo M1).
2. guests > capacity → 400.
3. Fechas sin disponibilidad → 409 NO_AVAILABILITY, sin fila creada.
4. Validaciones de shape: email inválido, nombre corto, rango
   invertido → 400 con mensaje por campo.
5. GET por code: shape seguro (sin email/teléfono), 404 si no existe,
   `expired` calculado cuando expires_at quedó en el pasado.
6. El POST respeta el lock: reusar el patrón del test de concurrencia
   del módulo 2 a través del endpoint HTTP (dos POST simultáneos por
   la última unidad → un 201 y un 409).

Frontend: verificación visual según reglas del CLAUDE.md raíz
(screenshots targeted de los 4 pasos, batería de anchos si hay layout
nuevo).

## Criterio de "hecho"

- Migración corrida vía túnel en catavento_db.
- 6 tests backend verdes + verificación visual del frontend.
- Nginx del VPS proxeando /api (pasos manuales aplicados por Maxi).
- Flujo completo probado en producción POR URL DIRECTA: crear una
  reserva de prueba real en /reservar, verla por GET /api/reservations/:code,
  y confirmarla expirada 30 min después. Borrar la fila de prueba al
  terminar.
- El sitio público sigue idéntico: form del hero → HQBeds, cero links
  a /reservar.