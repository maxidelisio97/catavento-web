SPEC — Módulo 6: Panel base (login + tape chart)

Proyecto: Catavento Booking Engine
Fecha: 2026-07-21
Estado: propuesta para aprobación
Precondición: M1–M5 en producción (sandbox Asaas)

0. Resumen y estrategia de entrega

Este módulo abre el panel de administración: primera vez que existe un frontend privado, autenticación y una vista operativa del inventario. Se propone dividirlo en tres entregas secuenciales, cada una mergeable y verificable por separado:

Entrega	Alcance	Por qué separada
6A — Modelo por noche	Tabla reservation_nights, migración de datos existentes, origin, refactor de asignación del M5, invariante "ninguna noche sin unidad"	Toca disponibilidad y pagos indirectamente. Requiere risk-review con contexto fresco antes del merge (regla §5 del CONTEXTO). Sale sin UI: se verifica con tests de integración.
6B — Auth + scaffold del panel	Tabla users, sessions, endpoints de login/logout/renovación, app React en panel/, deploy en painel.cataventotaiba.com, pantalla vacía tras login	Bloque de infraestructura puro (DNS, SSL, CI/CD, nueva app). Si falla, falla solo y no arrastra el mapa.
6C — Tape chart + detalle	Endpoints de lectura del mapa, grilla de 11×N, bloques por noche, resumen superior, panel de detalle de reserva	Depende de 6A (datos) y 6B (acceso). Es el único bloque con verificación visual.

Recomendación: no delegar las tres a la vez. Cada entrega cierra con su propia verificación contra esta spec.

ENTREGA 6A — Asignación de unidad por noche
6A.1 Cambio de modelo

Hoy: reservations.room_unit_id — una unidad para toda la estadía.
Desde ahora: la unidad se asigna por noche, para poder mover a un huésped una sola diaria sin partir la reserva.

Tabla nueva
reservation_nights
  id              bigserial PK
  reservation_id  bigint NOT NULL REFERENCES reservations(id) ON DELETE CASCADE
  night           date   NOT NULL          -- fecha de la noche (la noche del 10 = del 10 al 11)
  room_unit_id    bigint NOT NULL REFERENCES room_units(id)
  created_at      timestamptz NOT NULL DEFAULT now()

  UNIQUE (reservation_id, night)
  UNIQUE (room_unit_id, night)              -- ← anti-overbooking físico, a nivel base
  INDEX  (night)
  INDEX  (room_unit_id, night)

El segundo índice único es la pieza central: la base misma impide que dos reservas ocupen la misma unidad la misma noche. Deja de ser una garantía que depende solo del lock aplicativo.

Convención de fechas (dejarla explícita en el código y en los comentarios de la migración)

Una reserva con arrival = 2026-08-10 y departure = 2026-08-13 genera filas para las noches 10, 11 y 12. La fecha de departure nunca genera fila. Cantidad de filas = cantidad de noches = departure - arrival.

reservations.room_unit_id
No se borra en esta entrega. Se mantiene como columna derivada/legacy y se sigue escribiendo con la unidad de la primera noche.
Se marca en el código como deprecada; toda lectura nueva usa reservation_nights.
Su eliminación se evalúa en M7, cuando el arrastre haga que "la unidad de la reserva" deje de tener sentido.

Razón: evita que un punto olvidado del M5 rompa en silencio, y permite rollback de 6A sin pérdida de información.

Migración de datos existentes

Script idempotente, dentro de una transacción:

Crear reservation_nights.
Para toda reserva con estado activo (confirmada / pendiente-no-expirada) y room_unit_id no nulo, expandir a una fila por noche con esa misma unidad.
Verificar post-migración: count(noches esperadas) == count(reservation_nights) para cada reserva activa. Si no coincide, abortar la transacción.
Reservas canceladas o expiradas: no se migran (no ocupan inventario).

Antes de correr en producción: backup del dump. La migración debe poder correrse dos veces sin efecto adicional.

6A.2 Refactor de la asignación automática (M5)

El algoritmo del M5 no cambia de criterio: sigue eligiendo, dentro del lock, la unidad libre de label menor entre las del tipo reservado. Lo único que cambia es la escritura y el chequeo.

Al crear una reserva (dentro de la transacción con lock):

Doble chequeo de disponibilidad, como hoy: agregado (calendario/OTAs) + físico.
El chequeo físico ahora consulta reservation_nights: una unidad está libre para el rango si no tiene ninguna fila en ninguna de las noches del rango.
Elegir la unidad libre de label menor para el rango completo — se sigue asignando una sola unidad a toda la estadía en la creación automática. Solo el operador (M7) fragmenta.
Insertar N filas en reservation_nights (una por noche) en la misma transacción.
El UNIQUE (room_unit_id, night) actúa como red de seguridad: si una carrera lo viola, la transacción falla y se devuelve el mismo error de "sin disponibilidad" que hoy.

Al expirar el hold: el job/lógica de expiración borra las filas de reservation_nights de la reserva junto con la liberación actual. La unidad queda libre automáticamente.

Al cancelar: mismo comportamiento — se borran las filas.

6A.3 Invariante: prohibido una noche activa sin unidad

Regla dura, verificada en tres capas:

Base: room_unit_id NOT NULL en reservation_nights.
Aplicación: ninguna ruta puede dejar una reserva activa con cantidad de filas distinta de su cantidad de noches. Se agrega una función de validación invocada al final de toda transacción que toque reservas.
Chequeo de consistencia: endpoint interno o comando CLI que detecta reservas activas huérfanas (0 filas, filas faltantes o filas de más). Se corre en los tests de integración y queda disponible para diagnóstico manual.

Si en algún momento no hay unidad física disponible para una noche, la operación falla; nunca se crea la reserva a medias.

6A.4 Campo origin
ALTER TABLE reservations
  ADD COLUMN origin text NOT NULL DEFAULT 'web'
  CHECK (origin IN ('web','manual','ota'));
Backfill: todo lo existente queda en 'web' (el default lo resuelve).
'manual' lo usará el M7 (reservas cargadas por la pousada).
'ota' lo usará el M12 (sincronización).
Se expone en el detalle de reserva del panel. No se expone en el GET público por código.
6A.5 Verificación de 6A

Tests de integración (sin UI):

Reserva de 3 noches → exactamente 3 filas, misma unidad, noches correctas, sin fila en la fecha de departure.
Reserva de 1 noche → 1 fila.
Dos reservas concurrentes por la última unidad de un tipo → una gana, la otra recibe error de disponibilidad; nunca dos filas para la misma unidad y noche.
Reserva que expira → filas borradas, unidad reasignable inmediatamente.
Reserva cancelada → filas borradas.
Reservas contiguas (una sale el 12, otra entra el 12) → conviven en la misma unidad sin conflicto (la noche del 12 pertenece solo a la segunda). Este es el test que valida la convención de fechas.
Chequeo de consistencia devuelve cero inconsistencias tras la migración.
Risk-review con contexto fresco antes del merge (regla §5 del CONTEXTO): toca disponibilidad y datos de huéspedes.
ENTREGA 6B — Autenticación y scaffold del panel
6B.1 Modelo de usuarios
users
  id             bigserial PK
  email          citext NOT NULL UNIQUE
  password_hash  text NOT NULL           -- argon2id
  name           text NOT NULL
  role           text NOT NULL DEFAULT 'admin'
                 CHECK (role IN ('admin','staff'))
  is_active      boolean NOT NULL DEFAULT true
  created_at     timestamptz NOT NULL DEFAULT now()
  updated_at     timestamptz NOT NULL DEFAULT now()
Dos cuentas creadas a mano (dueño y socio), ambas role = 'admin', vía script CLI de creación de usuario que pide la contraseña por stdin y nunca la loguea.
El esquema nace preparado para roles; no se implementa ninguna lógica de permisos por sección en este módulo. Todo admin ve todo. La gestión de usuarios y permisos granulares es el M9.
is_active = false deja de permitir login e invalida sesiones (útil antes de que exista M9).
No hay registro público. No hay recuperación de contraseña por email en este módulo (si se olvida, se resetea con el CLI en el VPS).
6B.2 Sesiones
sessions
  id              uuid PK DEFAULT gen_random_uuid()
  user_id         bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE
  token_hash      text NOT NULL UNIQUE     -- SHA-256 del token opaco; el token en claro nunca se guarda
  expires_at      timestamptz NOT NULL
  last_used_at    timestamptz NOT NULL DEFAULT now()
  created_at      timestamptz NOT NULL DEFAULT now()
  user_agent      text
  ip              inet
  revoked_at      timestamptz

  INDEX (user_id) WHERE revoked_at IS NULL
  INDEX (expires_at)

Sesiones opacas en base, no JWT. Motivo: "cerrar sesión en todos los dispositivos" y la revocación inmediata son requisitos explícitos, y con JWT exigirían igualmente una lista de revocación en base — el JWT no aportaría nada y complicaría.

Reglas:

Token: 32 bytes aleatorios criptográficos, codificado en base64url. Se guarda solo su hash.
Duración: 30 días desde la creación.
Renovación automática mientras se use: en cada request autenticado, si expires_at está a menos de 25 días de distancia (es decir, pasaron más de 5 días desde la última extensión), se empuja expires_at a now() + 30 días. El umbral evita un UPDATE por cada request.
last_used_at se actualiza junto con la renovación (mismo umbral), no en cada request.
Sesión inválida si: no existe, revoked_at no nulo, expires_at < now(), o el usuario está inactivo.
Limpieza: las sesiones expiradas hace más de 30 días se borran (job diario o al login, lo que sea más simple).

Cookie:

Name:     catavento_session
HttpOnly: true
Secure:   true
SameSite: Lax
Path:     /
Domain:   painel.cataventotaiba.com
Max-Age:  30 días (se reemite cuando se renueva la sesión)

SameSite=Lax alcanza porque el panel no recibe navegación cross-site que necesite la cookie en POST. Con esto, no se necesita token CSRF adicional para 6B/6C (que además es solo lectura). Si M7 introduce mutaciones sensibles, se revisa.

6B.3 Endpoints de auth

Todos bajo /panel/auth, separados del namespace público.

Método	Ruta	Descripción
POST	/panel/auth/login	{ email, password } → set-cookie + { user: { id, name, email, role } }. Error genérico "credenciales inválidas" (nunca distinguir email inexistente de contraseña incorrecta).
POST	/panel/auth/logout	Revoca la sesión actual, limpia cookie.
POST	/panel/auth/logout-all	Revoca todas las sesiones del usuario, incluida la actual.
GET	/panel/auth/me	Devuelve el usuario de la sesión actual, o 401. Lo usa el front al arrancar.

Rate limiting en login: máximo 5 intentos fallidos por email y por IP en 15 minutos; luego 429 con backoff. Los intentos exitosos resetean el contador. Sin esto, dos cuentas con contraseña son un blanco fácil.

Middleware requireAuth: aplicado a todo /panel/* excepto login. Devuelve 401 sin cuerpo informativo. Nunca se aplica a rutas públicas.

Logging: se registran login exitoso, login fallido y logout-all con timestamp, email e IP. Nunca contraseñas ni tokens.

6B.4 Aplicación React en panel/

Ubicación: carpeta panel/ del mismo repo, aplicación Vite independiente (su propio package.json, vite.config.ts, index.html, build a panel/dist). No comparte router ni bundle con el sitio público.

Qué se comparte y qué no:

Se comparten: tipos de dominio del backend (paquete o carpeta shared/), tokens de Tailwind si conviene reusarlos.
No se comparte la identidad visual del sitio público. El panel es una herramienta operativa: prioriza densidad de información y legibilidad sobre atmósfera. No aplican los principios de motion ni la dirección "costero rústico" del PRODUCT.md — ese documento gobierna el sitio de cara al huésped, no el back office. Se permite una paleta neutra de panel; el único cruce razonable es el wordmark en el login.

Stack: React + TypeScript + Vite + Tailwind. Router mínimo (login / mapa). Estado del servidor con la librería de fetching que ya se use, o fetch + hooks propios si no hay ninguna — no introducir dependencias nuevas grandes por un módulo de dos pantallas.

Pantallas de 6B:

Login — email, contraseña, error genérico, estado de carga.
Layout autenticado — header con nombre del usuario, menú con "Cerrar sesión" y "Cerrar sesión en todos los dispositivos" (este último con confirmación), y un contenedor vacío donde 6C montará el mapa.

Arranque: el front llama a GET /panel/auth/me. Si 401 → login. Si 200 → layout. Cualquier respuesta 401 de cualquier endpoint → redirige a login.

El panel no se indexa: X-Robots-Tag: noindex en Nginx para todo el subdominio, más robots.txt con Disallow: /.

6B.5 Infraestructura
DNS: registro A de painel.cataventotaiba.com → IP del VPS. (Pendiente de crear — bloqueante para el deploy, no para el desarrollo local.)
SSL: certificado Let's Encrypt para el subdominio. (Pendiente.)
Nginx: server block nuevo que sirve panel/dist como SPA (fallback a index.html) y hace proxy de /panel/* y /api/* al backend Fastify. HTTP redirige a HTTPS.
CI/CD: extender el workflow existente de GitHub Actions con un job que buildee panel/ y despliegue a /var/www/catavento-panel/dist. El sitio público y el panel se despliegan por separado; un fallo en uno no bloquea al otro.
CORS: si el backend vive en otro origen que el panel, permitir explícitamente https://painel.cataventotaiba.com con credentials: true. Si se sirve todo bajo el mismo origen vía Nginx (preferible), no hace falta CORS.
6B.6 Verificación de 6B
Login correcto → cookie seteada, /me devuelve el usuario.
Login incorrecto → 401 con mensaje genérico; 6 intentos fallidos → 429.
Endpoint /panel/* sin cookie → 401.
Logout → sesión revocada; el mismo token deja de funcionar.
Logout-all desde el dispositivo A → la sesión del dispositivo B deja de funcionar (verificable con dos clientes HTTP).
Sesión con expires_at vencido manualmente en base → 401.
Renovación: request con sesión de 20 días de antigüedad → expires_at se empuja; request con sesión de 1 día → no se toca (verificar que no haya UPDATE por request).
Usuario con is_active = false → no puede loguear y sus sesiones vigentes dejan de servir.
Captura de la pantalla de login y del layout autenticado.
ENTREGA 6C — Tape chart y detalle de reserva
6C.1 Endpoints de lectura

GET /panel/tape-chart?from=YYYY-MM-DD&to=YYYY-MM-DD

Rango máximo aceptado: 60 días (evita consultas accidentales de un año). Devuelve:

jsonc
{
  "from": "2026-08-10",
  "to": "2026-08-23",
  "units": [
    { "id": 1, "label": "101", "room_type": "Casal", "capacity": 2, "sort_order": 1 }
    // ... 11 unidades, ordenadas
  ],
  "nights": [
    {
      "night": "2026-08-10",
      "room_unit_id": 1,
      "reservation_id": 42,
      "code": "CAT-XXXX",
      "guest_name": "María González",
      "has_balance_due": true,          // saldo pendiente > 0
      "is_first_night": true,           // primera noche de la reserva
      "is_last_night": false,           // última noche de la reserva
      "is_fragmented": false,           // la reserva usa más de una unidad
      "fragment_group": null            // null si no fragmentada; identificador estable si sí
    }
    // ... una entrada por noche ocupada
  ],
  "summary": {
    "arrivals_today": 3,
    "departures_today": 2,
    "occupied_today": 7,
    "total_units": 11
  }
}

Notas de implementación:

Se devuelven noches ocupadas, no un grid completo: el front arma la grilla y las celdas sin entrada son huecos. Con 11 unidades × 14 noches el payload es trivial.
has_balance_due = total_cents - paid_cents > 0. Se calcula en el servidor.
is_fragmented / fragment_group: verdadero cuando la reserva tiene filas con más de un room_unit_id distinto. fragment_group puede ser el reservation_id — sirve para que el front pinte el vínculo. En 6C ninguna reserva nacerá fragmentada (solo el M7 fragmenta), pero el mapa debe soportarlo desde el día uno, porque los datos ya lo permiten.
El resumen es siempre relativo a hoy, no al rango visible. "Llegan hoy" / "salen hoy" son datos operativos del día, no de la ventana que el usuario esté mirando. Si el rango visible no incluye hoy, el resumen se muestra igual, con la fecha explícita.
arrivals_today: reservas cuyo arrival = hoy. departures_today: departure = hoy. occupied_today: unidades con fila en reservation_nights para la noche de hoy.
Solo reservas activas (confirmadas y pendientes no expiradas). Canceladas y expiradas no aparecen.

GET /panel/reservations/:id

Detalle completo, solo lectura:

jsonc
{
  "id": 42,
  "code": "CAT-XXXX",
  "status": "confirmed",
  "arrival": "2026-08-10",
  "departure": "2026-08-13",
  "nights": 3,
  "room_type": { "id": 1, "name": "Casal" },
  "units": [ { "night": "2026-08-10", "unit_label": "101" }, /* ... */ ],
  "guests": {
    "adults": 2,
    "children": 1,
    "children_ages": [7],
    "babies": 0,
    "total": 3
  },
  "money": {
    "total_cents": 66000,
    "deposit_cents": 33000,
    "paid_cents": 33000,
    "balance_cents": 33000
  },
  "origin": "web",
  "contact": { "name": "...", "email": "...", "phone": "..." },
  "comments": "…",
  "created_at": "..."
}
Este endpoint sí expone datos de menores (edades de niños, bebés). Es un endpoint autenticado de back office, no el GET público por código — la restricción de la risk-review del M4 aplica al endpoint público y no se relaja acá. Que quede escrito para que ninguna sesión futura confunda ambos.
No se expone CPF/CNPJ (no se guarda, por decisión del M4).
Sin datos de tarjeta de ningún tipo.
6C.2 Tape chart — comportamiento

Estructura: grilla de 11 filas fijas (una por unidad física: Casal 101–106, Triplo 7–9, Quádruplo 10–11), agrupadas visualmente por tipo de cuarto, con las columnas siendo noches.

Ventana temporal:

Por defecto: dos semanas (14 noches), empezando hoy.
Navegable: botones anterior / siguiente (salto de una semana, no de dos — permite encabalgar la vista y no perder contexto), y botón "Hoy".
Selector de fecha para saltar a un período arbitrario.
La columna de hoy se marca visualmente.
Fines de semana (viernes y sábado, coherente con el modelo de tarifas) con fondo levemente distinto — ayuda a orientarse y refuerza el modelo de precios existente.

Bloques: una celda pintada por noche, no una barra continua. La reserva se lee como una hilera de celdas contiguas. Consecuencia deliberada: el M7 podrá mover una sola celda sin partir nada.

Se marca visualmente el inicio y el fin de la reserva (bordes redondeados o marca en la primera/última noche), para que la hilera se lea como una unidad sin dejar de ser celdas independientes.
La reserva contigua (una sale el 12, otra entra el 12) debe verse claramente como dos reservas distintas y adyacentes.

Contenido del bloque:

Nombre del huésped (truncado si no entra; tooltip con el nombre completo). Se muestra en la primera noche visible de la reserva dentro de la ventana actual — si la reserva empezó antes del rango, se muestra en la primera columna visible.
Icono de dinero si has_balance_due — la señal operativa central del mapa.
Nada más. Sin distinción visual por estado de pago (decisión tomada: las reservas pendientes no reciben tratamiento especial).

Fragmentación: cuando una reserva ocupa unidades distintas en noches distintas, los tramos llevan un indicador que los vincula — misma marca de color/patrón asignada por fragment_group, más un ícono de vínculo en el borde donde el tramo se corta y donde retoma en la otra fila. Al pasar el mouse sobre un tramo, se resaltan todos los tramos de la misma reserva.

Solo lectura. Sin arrastre, sin edición, sin creación. Clic en un bloque → panel de detalle. El arrastre para mover reservas es el M7 — el modelo por noche de 6A es precisamente lo que lo habilita, pero no se implementa nada de eso acá.

6C.3 Resumen superior

Barra sobre el mapa, siempre visible:

Llegan hoy: N
Salen hoy: N
Ocupación: X/11 (con el porcentaje entre paréntesis)

Con la fecha de hoy escrita explícitamente, para que no haya ambigüedad cuando el mapa esté mostrando otro período.

6C.4 Panel de detalle

Se abre al clickear cualquier bloque. Panel lateral (drawer) en desktop, hoja a pantalla completa en mobile. Cierra con Escape, con clic fuera y con botón explícito.

Contenido, en este orden:

Nombre del huésped y código de reserva (copiable con un clic).
Fechas (entrada, salida, cantidad de noches).
Tipo de cuarto + unidad(es) asignada(s). Si es fragmentada, el desglose noche por noche.
Huéspedes: adultos, niños con sus edades, bebés.
Dinero: total, depósito, pagado, saldo pendiente (destacado si es mayor a cero).
Origen (web / manual / OTA).
Contacto: nombre, email, teléfono. El teléfono con enlace a WhatsApp — es el canal real de la pousada.
Comentarios.
Al pie, en letra chica: estado de la reserva y fecha de creación.

Sin botones de acción en este módulo (los de M7 se agregarán acá mismo).

6C.5 Responsive

El caso de uso principal es un escritorio o notebook en la recepción, pero el dueño va a abrir esto desde el celular. No es opcional.

Desktop (≥1024px): grilla completa de 14 columnas.
Tablet: grilla con scroll horizontal, columna de unidades fija (sticky).
Mobile (<768px): el tape chart de 14 columnas es ilegible. Se reduce la ventana por defecto a 7 noches y se mantiene el scroll horizontal con la columna de unidades fija. El resumen superior y el panel de detalle son plenamente usables — en mobile, el resumen del día es probablemente lo que más se consulta.

No se implementa una vista alternativa tipo lista en este módulo, pero si al verificar en mobile el mapa resulta inusable, se reporta antes de inventar una solución.

6C.6 Accesibilidad
Navegación por teclado: se puede tabular entre bloques y abrirlos con Enter.
Contraste AA en el texto de los bloques (nombre del huésped sobre el color de fondo del bloque).
El icono de saldo pendiente no comunica por color solamente — es un ícono con aria-label.
La fragmentación tampoco se comunica solo por color: además de la marca, el vínculo tiene ícono y el detalle lo explica en texto.
Respeto de prefers-reduced-motion en las transiciones del drawer.
6C.7 Verificación de 6C
Reserva de 3 noches → 3 celdas contiguas en la misma fila, con marca de inicio y fin.
Dos reservas contiguas en la misma unidad (una sale el día que entra la otra) → se leen como dos bloques distintos, sin superposición ni hueco.
Reserva con saldo pendiente → ícono de dinero. Reserva saldada → sin ícono.
Reserva fragmentada (creada a mano en base para la prueba) → indicador de vínculo visible en ambos tramos; hover resalta ambos.
Reserva que empieza antes del rango visible → el nombre aparece en la primera columna visible.
Resumen: coincide con un conteo manual contra la base.
Rango de más de 60 días → error controlado, no consulta pesada.
Detalle: todos los campos presentes; edades de niños visibles; saldo destacado.
Sin sesión → el endpoint del mapa devuelve 401.
Screenshots targeted en .screenshots/: mapa completo desktop, bloque con saldo, reserva fragmentada, panel de detalle, mapa en 375px. Borrar lo que no sirva al cerrar.
7. Fuera de alcance (explícito)

Para que ninguna sesión futura los dé por incluidos:

Arrastrar y soltar reservas → M7
Crear reservas manuales, check-in/check-out, cobro del saldo → M7
Edición de precios, cupos, estadía mínima, calendario editable → M8
Gestión de usuarios, invitaciones, permisos por sección → M9
Caja → M10
Cualquier cambio en el flujo público de reserva o pago
Switch de Asaas a producción (sigue pendiente, documentado en RUNBOOK-asaas-prod.md)
i18n del panel: solo portugués, coherente con el resto del sistema
8. Riesgos y puntos de atención
Riesgo	Mitigación
La migración a reservation_nights corrompe reservas activas en producción	Backup previo, transacción única con verificación de conteos, script idempotente, chequeo de consistencia post-migración
Convención de fechas mal interpretada (noche de departure)	Test explícito de reservas contiguas; comentario en la migración y en el código de asignación
Se rompe la asignación del M5 al refactorizar	El UNIQUE (room_unit_id, night) convierte cualquier error de lógica en un fallo ruidoso, no en un overbooking silencioso
Dos cuentas con contraseña como única barrera del panel	Argon2id, rate limiting en login, cookie HttpOnly/Secure, sesiones revocables, noindex
El subdominio queda expuesto antes de tener SSL	El deploy no se ejecuta hasta que DNS + certificado estén listos; HTTP redirige a HTTPS sin excepción
Datos de menores en un endpoint nuevo	Documentado que la restricción del M4 es del endpoint público; el de panel es autenticado. Risk-review lo confirma antes del merge
9. Propuesta de adición al CLAUDE.md del backend

(Sujeto a aprobación explícita, según la regla de mantenimiento. Se propone agregar al cerrar 6A y 6C respectivamente.)

Tras 6A:

La asignación de unidad física es por noche (reservation_nights), no por reserva. Una reserva activa SIEMPRE tiene exactamente una fila por noche, con unidad asignada — no existe noche activa sin unidad. La noche de departure no genera fila. reservations.room_unit_id es legacy (primera noche); toda lectura nueva usa reservation_nights.
El UNIQUE (room_unit_id, night) es anti-overbooking a nivel base, no solo aplicativo. No removerlo al optimizar.

Tras 6C:

El panel vive en panel/ (app Vite separada) y se sirve en painel.cataventotaiba.com. NO hereda la identidad visual ni las reglas de motion del PRODUCT.md: es back office, prioriza densidad y legibilidad.
Los endpoints /panel/* son autenticados y SÍ exponen datos de menores. La restricción de la risk-review del M4 aplica solo al GET público por código. No confundirlos.
Sesiones opacas en base (no JWT), 30 días con renovación por uso, revocables individualmente y en masa.