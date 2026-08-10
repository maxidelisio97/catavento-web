# SPEC — Módulo 9: Usuarios y Permisos

> Booking engine propio de Pousada Catavento (Taíba, Ceará).
> Spec de implementación para Claude Code. Fuente de verdad de las decisiones de M9.
> Redactada: 2026-07-24. Estado: **aprobada para implementar**.

---

## 0. Contexto y posición en el plan

M9 es el módulo que hace que **el panel deje de ser solo del dueño**. Hoy cualquier cuenta autenticada puede hacer todo (crear reservas, cobrar, cancelar, editar precios, todo). M9 agrega la capa de **autorización**: quién puede hacer qué.

**Se apoya en M6B** (autenticación): ya existen `users`, `sessions`, argon2id, login, sesiones opacas de 30 días, el hook `requireAuth`. M9 NO reescribe autenticación —construye **autorización** encima. Auth = "¿quién sos?" (ya resuelto). Authz = "¿qué podés hacer?" (esto es M9).

**El hallazgo que define el tamaño de M9:** los endpoints de M7 y M8 hoy solo chequean `requireAuth` (logueado sí/no), ninguno chequea *permiso*. El grueso de M9 no es la UI de usuarios —es **cablear el chequeo de permiso en todos los endpoints sensibles que ya existen**, sin cambiar su lógica. Es trabajo extenso y tiene que quedar parejo: un solo endpoint sensible sin gate es un agujero de seguridad.

**No toca:** auditoría / log de "quién hizo qué" (diferido a M10 — el `changed_by`/`created_by` que ya capturan M7/M8 se mantiene, pero la vista de auditoría es M10), OTAs (M12).

---

## 1. Principio rector (gobierna todo el módulo)

> **El permiso se chequea en el BACKEND. El frontend oculta botones por UX, pero eso NO es seguridad.**

Ocultar un botón que el usuario no puede usar es buena UX, pero no protege nada —alguien puede llamar al endpoint directamente saltándose la UI. La única barrera real es que el backend rechace la acción (403) si el usuario no tiene el permiso. Toda decisión de M9 se valida contra esto:

- **Backend (seguridad real):** cada endpoint sensible chequea el permiso antes de ejecutar. Sin permiso → 403.
- **Frontend (UX):** oculta/deshabilita lo que el usuario no puede hacer, para una interfaz limpia. Cosmético.

Si al implementar aparece la tentación de confiar en que "el frontend ya lo oculta, no hace falta chequear en el backend" — esa es la señal de parar. **Siempre en el backend, aunque el frontend también lo oculte.**

---

## 2. Modelo de permisos

### 2.1 Permisos granulares

Cada acción sensible del panel es un **permiso** individual, identificado por una clave estable (string). El permiso efectivo de un usuario determina qué endpoints puede llamar y qué ve en la UI.

**Lista inicial de permisos** (derivada de M7/M8 — extensible; guardar como datos, no hardcodear la lista en el código de chequeo de forma que agregar uno requiera tocar diez lugares):

*Reservas — ver y operar:*
- `reservations.view` — ver tape chart y reservas
- `reservations.create_manual` — crear reserva manual
- `reservations.move` — cambiar de cuarto (move-night / move-stay)
- `reservations.checkin` — check-in
- `reservations.checkout` — check-out
- `reservations.cancel` — cancelar / marcar no-show

*Dinero:*
- `payments.charge` — registrar pagos (depósito / saldo, Asaas o manual)
- `payments.extra` — agregar cargos extra
- *(futuro M10: `payments.refund`, `cash.*` — dejar el namespace previsto)*

*Configuración (M8):*
- `config.settings` — editar settings globales (depósito, hold, pet_fee) y precios base
- `config.calendar` — editar el calendario de overrides (precios/cupos/cierres por fecha)

*Administración (M9):*
- `admin.users` — crear / editar / desactivar usuarios, asignar roles y overrides
- `admin.roles` — crear / editar / borrar roles

**Decisión de diseño (regla del dueño — "más capacidad que menos"):** la lista de permisos vive como **datos** (tabla `permissions` o un enum central + seed), de modo que agregar un permiso nuevo (M10, M11…) sea sumar una fila / una entrada, no refactorizar el sistema de chequeo. El mecanismo de chequeo es genérico: `requirePermission(clave)`.

### 2.2 Roles como plantilla

Un **rol** es un conjunto nombrado de permisos —una plantilla. Sirve para no marcar permisos uno por uno al crear cada empleado.

- Tabla `roles` (id, nombre, descripción, `is_system` para los que no se pueden borrar).
- Tabla `role_permissions` (role_id, permission) — qué permisos trae cada rol.
- **Roles de arranque (seed):**
  - **Dueño** (`is_system=true`): bypassa TODOS los permisos siempre (ver §2.4). No editable en sus permisos (los tiene todos por definición), no borrable.
  - **Recepción** (`is_system=false` o un flag que permita editarlo): existe pero **arranca sin permisos** — el dueño le asigna los que correspondan desde el panel. No se asumen permisos por defecto (decisión del dueño: lo configura él).
- El dueño puede **crear más roles** y editar los permisos de los no-system.

### 2.3 Override por persona

Sobre el rol heredado, cada usuario puede tener **overrides** individuales: sumar o quitar permisos puntuales.

- Tabla `user_permission_overrides` (user_id, permission, `granted` boolean) — `granted=true` suma un permiso que el rol no da; `granted=false` quita uno que el rol sí da.
- **Permiso efectivo de un usuario** = (permisos del rol) modificado por (overrides del usuario). Formalmente:
  - Si hay override para esa permission → gana el override (`granted` true/false).
  - Si no hay override → vale lo que dice el rol.
  - Excepción: rol Dueño → todo, siempre (los overrides no le quitan nada — ver §2.4).

### 2.4 El Dueño / superusuario (protección anti-autobloqueo)

Tiene que existir siempre al menos una cuenta que pueda todo, o el sistema puede quedar sin administrador (alguien se quita `admin.users` y ya nadie puede volver a asignarlo → panel bloqueado para siempre).

Reglas duras (no salteables):
- El rol **Dueño bypassa todos los permisos** — un usuario con rol Dueño puede llamar cualquier endpoint, sin importar overrides. Los overrides NO pueden quitarle permisos a un Dueño.
- **No se puede eliminar el último Dueño** ni desactivarlo ni cambiarle el rol a algo menor. El sistema debe rechazar cualquier operación que dejaría **cero cuentas Dueño activas**.
- Un Dueño **no puede quitarse a sí mismo** `admin.users` (implícito en que bypassa todo, pero el endpoint de edición debe rechazar explícitamente el intento por claridad).
- Puede haber **más de un Dueño** (recomendable: al menos dos, por si uno pierde acceso). El sistema solo bloquea llegar a cero.

---

## 3. Entregas

M9 se parte en tres, de mayor a menor riesgo de seguridad (primero la barrera real, después las herramientas):

- **9A — Modelo + chequeo backend.** El schema (roles, permisos, overrides), el cálculo del permiso efectivo, el hook `requirePermission`, y **el cableado del gate en TODOS los endpoints sensibles de M7/M8**. Sin UI nueva. Es la entrega que instala la seguridad real.
- **9B — UI de administración.** Las pantallas para crear/editar/desactivar usuarios, asignar rol, editar overrides, gestionar roles. Con el sistema de diseño del panel (ya rediseñado) — nace consistente.
- **9C — UX de permisos en el frontend.** Ocultar/deshabilitar en toda la app lo que el usuario no puede hacer (botones de cobrar, cancelar, config, etc. según permiso efectivo). Cosmético sobre la seguridad ya instalada en 9A.

---

## 4. Entrega 9A — Modelo + chequeo backend

### 4.1 Schema

```sql
-- Permisos como datos (no hardcode disperso)
CREATE TABLE permissions (
  key         text PRIMARY KEY,     -- 'reservations.checkin', etc.
  description text NOT NULL
);

CREATE TABLE roles (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  description text,
  is_system   boolean NOT NULL DEFAULT false,  -- Dueño no borrable
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
  role_id     integer NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission  text    NOT NULL REFERENCES permissions(key),
  PRIMARY KEY (role_id, permission)
);

-- users ya existe (M6B). Agregar el rol:
ALTER TABLE users ADD COLUMN role_id integer REFERENCES roles(id);
-- (nullable al migrar; el backfill asigna Dueño a las cuentas admin existentes — ver §4.5)

CREATE TABLE user_permission_overrides (
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission  text    NOT NULL REFERENCES permissions(key),
  granted     boolean NOT NULL,     -- true = suma, false = quita
  PRIMARY KEY (user_id, permission)
);
```

- `is_system` marca el rol Dueño como no borrable / no editable en su naturaleza de "todo".
- Considerar una columna en `roles` o un mecanismo que identifique el rol Dueño como "bypassa todo" (ej. `is_owner boolean` o un nombre reservado) — no depender solo de que tenga todos los permisos listados, porque un permiso nuevo agregado después (M10) no estaría en su lista y el Dueño dejaría de poder algo. **El Dueño bypassa por naturaleza, no por tener la lista completa.** Definir esto explícito en el plan.

### 4.2 Cálculo del permiso efectivo

Función pura, testeable, central: `effectivePermissions(user) → Set<permission>` o `can(user, permission) → boolean`.

Lógica:
1. Si el rol del usuario es Dueño (bypassa todo) → `can` devuelve true para cualquier permiso, siempre. Fin.
2. Si no: partir de los permisos del rol.
3. Aplicar overrides: `granted=true` suma, `granted=false` quita.
4. El resultado es el set efectivo.

**Testear exhaustivamente** — este es el corazón del módulo. Casos: rol sin overrides, override que suma, override que quita, Dueño ignora overrides, usuario sin rol (¿qué pasa? — definir: sin rol = sin permisos, o rechazar la cuenta; proponer en el plan).

### 4.3 El hook `requirePermission`

Análogo a `requireAuth` (M6B), pero chequea un permiso concreto:

```
requirePermission('payments.charge')
```

- Corre DESPUÉS de `requireAuth` (primero identificar quién sos, después qué podés).
- Si el usuario no tiene el permiso efectivo → **403** (no 401 — 401 es "no autenticado", 403 es "autenticado pero sin permiso"). Mensaje claro pero sin filtrar qué permiso falta de forma explotable.
- Reutilizable, scoped por ruta igual que `requireAuth`.

### 4.4 Cableado en los endpoints existentes (EL grueso de 9A)

Cada endpoint sensible de M7/M8 recibe su `requirePermission` correspondiente, **sin tocar su lógica de negocio**. Mapa (verificar contra el código real los nombres/rutas exactos):

| Endpoint | Permiso |
|---|---|
| `GET /panel/tape-chart`, ver reservas | `reservations.view` |
| `POST /panel/reservations/manual` | `reservations.create_manual` |
| `POST .../move-night`, `.../move-stay` | `reservations.move` |
| `POST .../check-in` | `reservations.checkin` |
| `POST .../check-out` | `reservations.checkout` |
| `POST .../cancel`, `.../no-show` | `reservations.cancel` |
| `POST .../payment` | `payments.charge` |
| `POST .../extra` | `payments.extra` |
| `GET/PATCH /panel/settings`, `/panel/room-rates` | `config.settings` |
| `GET/PUT/PATCH /panel/rate-overrides*` | `config.calendar` |
| endpoints de usuarios/roles (9A nuevos) | `admin.users` / `admin.roles` |

- **Verificación de completitud (no negociable):** al terminar 9A, hacer un barrido de TODOS los endpoints bajo `/panel/*` y confirmar que cada uno sensible tiene su `requirePermission`. Un endpoint sensible sin gate es un agujero. Documentar el barrido (lista de endpoints × permiso asignado, o "solo requireAuth" justificado para los inofensivos como el propio "quién soy").
- Los endpoints de lectura pura muy básicos (ej. "datos del usuario logueado") pueden quedar solo con `requireAuth` — justificar cuáles y por qué.

### 4.5 Endpoints nuevos de 9A (administración — backend)

```
# Usuarios
GET    /panel/users                    → lista (requirePermission admin.users)
POST   /panel/users                    → crear (admin.users)
PATCH  /panel/users/:id                → editar (rol, activo/inactivo) (admin.users)
PATCH  /panel/users/:id/overrides      → editar overrides (admin.users)
POST   /panel/users/:id/deactivate     → desactivar (admin.users, con guarda anti-autobloqueo)

# Roles
GET    /panel/roles                    → lista (admin.roles)
POST   /panel/roles                    → crear (admin.roles)
PATCH  /panel/roles/:id                → editar permisos del rol (admin.roles)
DELETE /panel/roles/:id                → borrar (admin.roles, no si is_system, no si hay usuarios asignados)

# Permisos (catálogo, para poblar la UI)
GET    /panel/permissions              → lista de permisos disponibles (admin.users o admin.roles)

# Contexto del usuario actual (para el frontend de 9C)
GET    /panel/me/permissions           → permisos efectivos del usuario logueado (solo requireAuth)
```

- **Guardas anti-autobloqueo (§2.4)** en `PATCH /panel/users/:id`, `deactivate`, y cambio de rol: rechazar (409) cualquier operación que dejaría cero Dueños activos, o que un Dueño se quite a sí mismo la administración.
- Crear usuario: reutiliza el hashing argon2id de M6B. Definir si la contraseña la pone el admin o se genera y se comunica aparte (proponer — para una pousada chica, el admin la setea probablemente alcanza, pero pensar el flujo de "primera contraseña").
- **`GET /panel/me/permissions`** es clave para 9C: el frontend pregunta "qué puedo hacer" y oculta/muestra en base a eso. Solo `requireAuth` (cualquier logueado puede saber sus propios permisos).

### 4.6 Migración y backfill

- Al migrar: crear las tablas, seedear `permissions` (la lista de §2.1), seedear roles Dueño y Recepción.
- **Backfill crítico:** las cuentas admin que ya existen (creadas a mano en M6B) tienen que quedar como **Dueño**, o nadie podría administrar tras la migración. Asignar rol Dueño a las cuentas existentes en la misma migración. Verificar contra el código real cuántas y cuáles son.
- Este backfill es el punto más delicado del deploy de 9A: si sale mal, quedás sin admin. Probar en test primero, y en el deploy confirmar que las cuentas quedaron Dueño ANTES de dar por bueno el restart.

---

## 5. Entrega 9B — UI de administración

Pantallas nuevas en el panel (con el sistema de diseño ya aplicado — nace consistente):

- **Lista de usuarios:** nombre/email, rol, activo/inactivo, acción de editar.
- **Crear/editar usuario:** email, rol (dropdown), estado activo, y el editor de overrides (ver qué da el rol + sumar/quitar permisos puntuales, visualmente claro qué viene del rol y qué es override).
- **Gestión de roles:** lista de roles, crear/editar (nombre + checklist de permisos), con el Dueño marcado como no editable.
- **Feedback de las guardas:** si intentás desactivar el último Dueño o autobloquearte, mensaje claro del backend (409) mostrado bien, no un error genérico.

- Todo bajo el permiso correspondiente (`admin.users` / `admin.roles`) — un usuario sin esos permisos no ve esta sección (9C lo oculta, 9A lo bloquea en el backend).
- La UI de overrides es la más delicada de diseñar: tiene que dejar claro el permiso efectivo resultante (esto viene del rol, esto lo sumaste, esto lo quitaste). Proponer el diseño antes de implementar.

---

## 6. Entrega 9C — UX de permisos en el frontend

Sobre la seguridad ya instalada en 9A, el frontend oculta/deshabilita lo que el usuario no puede hacer:

- Al cargar, el frontend pide `GET /panel/me/permissions` y guarda el set efectivo.
- Cada botón/acción sensible se muestra/oculta/deshabilita según el permiso: sin `payments.charge` → no ve el botón de cobrar; sin `config.calendar` → no ve el tab Calendário; sin `admin.users` → no ve la sección de administración; etc.
- **Esto es UX, no seguridad (§1).** Aunque un botón se muestre por un bug de frontend, el backend igual rechaza (403). El frontend nunca es la barrera.
- Manejar el 403 con gracia: si por lo que sea el usuario llama algo que no puede (UI desincronizada), mostrar un mensaje claro ("no tenés permiso para esto"), no un error crudo.

---

## 7. Riesgo y revisión

M9 **toca seguridad y todos los endpoints existentes**, así que:

- **9A va con risk-review de contexto fresco obligatoria antes de mergear.** Foco: (a) ¿todos los endpoints sensibles tienen su gate, sin ninguno olvidado? (b) ¿el cálculo del permiso efectivo es correcto, incluido el bypass del Dueño y los overrides? (c) ¿las guardas anti-autobloqueo son sólidas —no hay camino a cero Dueños? (d) ¿el backfill de la migración deja las cuentas existentes como Dueño? Un error en (a) o (c) es crítico: (a) es un agujero de seguridad, (c) es un panel bloqueado sin retorno.
- **9B y 9C** son más livianos (UI sobre backend ya asegurado) pero 9B toca administración de cuentas — una pasada de revisión no sobra, aunque más corta.
- **El chequeo se prueba en el backend:** tests que confirmen que un endpoint sensible devuelve 403 sin el permiso y 200 con él. Para cada permiso, al menos un test de "sin permiso → 403". Aplica la regla del repo: sacar el `requirePermission` de un endpoint tiene que hacer fallar su test de 403 —si pasa igual, el test no prueba el gate.

---

## 8. Reglas de implementación (heredadas)

- **Verificación de rama como PRIMER paso.**
- **Validar-antes-de-implementar:** plan de cada entrega → OK → implementar.
- **Descubrimiento primero:** antes de 9A, verificar el estado real — cuántas cuentas admin existen (para el backfill), los nombres/rutas exactos de TODOS los endpoints `/panel/*` (para el mapa de gates), cómo está `users` hoy tras M6B.
- **Backend es la seguridad, frontend es UX** (§1) — nunca confiar en el ocultamiento de UI.
- **La suite del backend es determinística** (5/5 verde tras la barrera): un rojo es señal real. El panel no tiene suite propia (verificación visual) — pero 9A es backend, sí tiene tests, y son críticos.
- **Delegación por partes:** el cableado de gates (9A) es mecánico pero extenso; hacerlo por grupos de endpoints, verificando cada grupo, no todo de un saque.
- **Al cerrar, proponer texto exacto** para `server/CLAUDE.md` si surge decisión durable (ej. la convención de nombres de permisos, la regla del bypass del Dueño).

---

## 9. Resumen de endpoints de M9

```
# Administración (9A backend)
GET/POST/PATCH  /panel/users, /panel/users/:id, /panel/users/:id/overrides
POST            /panel/users/:id/deactivate
GET/POST/PATCH/DELETE  /panel/roles, /panel/roles/:id
GET             /panel/permissions
GET             /panel/me/permissions

# + requirePermission cableado en TODOS los endpoints sensibles de M7/M8
```

---

## 10. Orden de construcción

- **9A** — modelo + chequeo backend + cableado de gates + backfill. La entrega de seguridad. Risk-review obligatoria. **Es la más importante y la más delicada del módulo** (toca todos los endpoints + la migración que no puede dejarte sin admin).
- **9B** — UI de administración, sobre el backend ya asegurado y el sistema de diseño ya aplicado.
- **9C** — UX de ocultamiento por permiso en toda la app.

Cada entrega usable: tras 9A el sistema es seguro (aunque se administre por SQL/API); 9B le da la UI de administración; 9C pule la experiencia. Se puede parar entre entregas.