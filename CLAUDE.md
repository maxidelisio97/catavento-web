# Pousada Catavento — Taiba

## Alcance de este archivo (monorepo)
Este repo contiene el frontend (raíz) y el backend (`server/`).
TODO lo que sigue en este archivo aplica SOLO al frontend, EXCEPTO las
secciones "Flujo de ramas" y "Delegación a agentes" de acá abajo, que
son reglas de todo el repo. El backend tiene su propio `server/CLAUDE.md`
con sus reglas — al trabajar dentro de `server/`, ese archivo manda y
las reglas de screenshots/layout/motion de acá no aplican.

## Delegación a agentes (todo el repo)
No uses el tool Agent para tareas en segundo plano salvo que el
usuario lo pida explícitamente. Motivo: una sesión de agente que falla
o tarda mucho puede consumir una cantidad grande de tokens sin
producir resultado verificable, y esto ya pasó — el usuario perdió
visibilidad sobre ese gasto más de una vez en la misma sesión.
Preferir implementación directa. Los agentes solo para tareas acotadas
y paralelizables, nunca un módulo completo — delegar el módulo 6A
entero costó ~200k tokens y trabajo duplicado.

## Flujo de ramas (todo el repo — frontend y backend)
- `main` es la única rama permanente y la única que se deploya. Deploy
  manual en ambos lados (sin CI/CD — decisión deliberada para tener
  control total, no reintroducir GitHub Actions sin pedido explícito).
- Todo trabajo nuevo se corta en una feature branch por módulo/tema
  desde `main` (ej. `modulo-2-disponibilidad`,
  `modulo-3-children-babies`).
- **Verificación de rama al empezar (no al cerrar).** Antes de escribir
  la primera línea de código de cualquier módulo/tema nuevo, correr
  `git branch --show-current` y confirmar que NO es `main`. Si lo es,
  cortar la feature branch ahí mismo, antes de tocar archivos — no al
  momento de commitear. Motivo: dos veces se detectó recién al cerrar
  que el trabajo se había hecho directo sobre `main` (ambas con
  archivos del frontend), obligando a reconstruir la separación de
  commits después del hecho.
- Al cerrar el módulo/tema: merge a `main`, push, y borrado inmediato
  de la rama (local y remota). No quedan ramas de feature vivas
  después de mergear.

## Contexto obligatorio
Antes de cualquier tarea de diseño, contenido o UX, lee `PRODUCT.md`.
Ese archivo define usuarios, objetivo de conversion, personalidad de
marca, anti-references y principios de diseño. Toda decision visual o
de copy se valida contra ese documento.

## Stack
- React + TypeScript + Vite
- Tailwind CSS (tokens custom en `index.css`: sand, stone, coral, warm)
- Tipografia: Fraunces (headings), Inter (body)
- react-day-picker (v10) para seleccion de rango de fechas en el
  formulario de reserva (estilado custom via `.rdp-root.booking-daypicker`)
- Deploy a producción (frontend): el VPS tiene un checkout git completo
  del repo en `/var/www/catavento-web` — NO es rsync de un build local,
  el build se rehace en el server. Nginx sirve estático desde
  `/var/www/catavento-web/dist` (config en
  `/etc/nginx/sites-available/cataventotaiba.com`), con SPA fallback
  (`try_files`). Sin restart de nada del lado del server, alcanza con:
  ```bash
  ssh catavento-vps
  cd /var/www/catavento-web
  git pull origin main
  npm ci
  npm run build
  ```
  Alias SSH (`catavento-vps`) vive en `~/.ssh/config` local, no en el repo.
- Deploy a producción (panel, `panel/`): el panel se buildea dentro de
  este mismo checkout y se copia a una carpeta servida aparte
  (`/var/www/catavento-panel/dist`, otro server_name en Nginx:
  `painel.cataventotaiba.com`). Después de bajar los cambios del repo:
  ```bash
  cd /var/www/catavento-web/panel
  npm ci
  npm run build
  rsync -a --delete dist/ /var/www/catavento-panel/dist/
  ```
  Si el sitio no refleja el cambio, puede ser permisos —
  `sudo chown -R www-data:www-data /var/www/catavento-panel/dist`
  resolvió esto en despliegues previos.
- Imagenes responsive: script `scripts/generate-responsive-images.mjs`
  (correr via `npm run images:hero` o el comando que corresponda) —
  genera variantes AVIF+WebP en 640/828/1080/1920px. Toda imagen nueva
  de contenido pasa por este pipeline, nunca un `<img>` con archivo
  original directo.

## Decisiones ya tomadas (no reabrir sin pedirlo)

### Diseño
- Propuesta A implementada: sin bloques de color solido a pantalla
  completa, coral como unico acento saturado, stone-* para neutros.
- El contenido debe ser visible sin JS y con `prefers-reduced-motion`.
  Las animaciones son mejora progresiva, nunca condicion para ver
  contenido.
- Formulario de disponibilidad: barra segmentada tipo pildora
  superpuesta al hero (card con overlap en md+, apilada en mobile),
  con celda unica de rango de fechas + hospedes + boton Verificar.
  SIN selector de tipo de quarto (decision deliberada, ver Reservas).
  Comportamiento del boton Verificar: ver seccion Motion.
- Identidad del header: wordmark CATAVENTO POUSADA + isotipo del
  molino (replicado del logo del sitio original cataventotaiba.com).
  El isotipo en el header es estatico; puede girar solo en hover.
  No sumarle motion permanente (el cupo esta ocupado).

### Reservas (estrategia comercial)
- Canal 1: motor de HQBeds (todas las reservas). Canal 2: WhatsApp
  (solo consultas/dudas, nunca presentado como canal de reserva).
- Booking.com NO es canal de reserva en el sitio. La mencion "10
  Booking" en testimonios y el aggregateRating del schema son
  atribucion de reseñas, no canal — no eliminarlas.
- Limitacion conocida del motor HQBeds (ya verificada con Playwright,
  no re-investigar): el checkout depende de la sesion, NO existe
  deep-link por habitacion. Por eso el form no ofrece seleccion de
  quarto. Todos los envios van a /rooms con arrival/departure/adults.
- adults: en el form general = hospedes elegidos (default 2). En los
  botones Reservar de las cards de Quartos = capacidad del cuarto
  (Casal 2, Triplo 3, Quadruplo 4).

### Datos reales verificados (no "corregir" de memoria)
- Rating: 8,8 sobre 10 en Booking, 167 reseñas (escala de 10, no
  convertir a 5).
- 3+ años de hospitalidade (no 10). 100m da praia (no 200).
- Sin recepcion 24h — la stat es "XL Guarda-kites".
- Los precios de las cards de Quartos (R$ 180/240/280) estan
  PENDIENTES de verificacion contra HQBeds — no son dato confirmado.
- Testimonios: texto exacto de reseñas reales de Booking, no
  corregir ortografia ni traducir.

## Motion (criterio del dueño)
- El principio rector es el del PRODUCT.md: motion sutil, ligado al
  contenido, nunca espectaculo. Al dueño le gusta el movimiento
  sutil — la regla no es "evitar movimiento" sino "evitar ruido".
- Motion permanente ESTA permitido cuando cumple las tres: (1) es
  muy lento (ritmo de brisa, no de mecanismo), (2) es chico o
  periferico (un icono, un detalle — nunca un bloque protagonista),
  (3) tiene significado de marca (viento/mar), no es decorativo.
- Direccion de microdetalles (revisada tras iterar con el dueño): van
  elementos de marca reconocibles, CON movimiento, en puntos de accion
  real — no acentos decorativos estaticos (se probo un glifo de kite
  en una stat, no convencio) ni motion permanente casi-imperceptible
  "de relleno" (se probo una ondulacion en el indicador Explorar, se
  revirtio). Si un microdetalle no tiene una accion o un gesto de marca
  real detras, no vale la pena implementarlo.
- El limite duro es la acumulacion: maximo 1-2 elementos con motion
  permanente visibles a la vez en cualquier pantalla. Hoy ese cupo
  tiene un solo ocupante: el molino del boton Verificar. Ante la duda,
  gatillado por usuario antes que permanente.
- prefers-reduced-motion desactiva TODO motion, sin excepciones.

### Boton Verificar (decision tomada)
- Icono `CataventoIcon` (`src/components/CataventoIcon.tsx`): replica
  simplificada del molino real del logo de cataventotaiba.com (roda
  de 8 aspas + mastro + torre, fieles al original). Props de tamano
  y color — componente reutilizable, pensado tambien para el header
  a futuro.
- Reposo: solo la roda (`.cv-wheel`) gira, muy lento (~11s por vuelta,
  ritmo de brisa) — mastro y torre quedan estaticos, como un molino
  real (no gira la estructura completa).
- Hover/focus (md+): la roda acelera brevemente y el icono se desliza
  fuera del boton con fade (~350ms) mientras entra una flecha desde
  el lado opuesto. Se revierte igual al salir el hover.
- prefers-reduced-motion: roda siempre estatica (sin giro de reposo);
  el hover queda como un simple crossfade de opacidad, sin desplazamiento.
- El morph de hover SOLO existe en md+ (depende de `:hover`, que no
  existe en touch). En mobile: boton full-width con icono estatico
  (mismo SVG, tamano reducido) + texto "Verificar" — evita que un
  `:hover` "pegado" de un tap en algunos navegadores mobile desplace
  el icono sin nada que lo reemplace.

### Pendiente abierto: indicador "Explorar"
- Hallazgo (no resolver sin pedirlo): en resoluciones de laptop muy
  comunes (ej. 1280x720) el indicador "Explorar" del hero queda
  parcial o totalmente tapado por el overlap de la card de reserva —
  hoy es poco o nada visible salvo en pantallas altas.
- Falta decidir: si el indicador sigue teniendo sentido en su posicion
  actual, si conviene reposicionarlo, o si conviene eliminarlo. No
  implementar ninguna opcion sin que el dueño elija.

## Estado de idiomas
- El sitio hoy es SOLO portugues. La internacionalizacion (ES/EN)
  esta pospuesta hasta que el contenido PT este congelado — no
  generar contenido multiidioma ni montar i18n sin pedido explicito.
- Cuando se haga: los tres idiomas se adaptan culturalmente, no se
  traducen literal. Los testimonios quedan en su idioma original.

## Workflow / eficiencia de tokens
- Screenshots: por defecto capturar solo la seccion relevante al
  cambio, no fullPage. FullPage solo al cerrar un bloque de trabajo
  como verificacion completa, o cuando se pida explicitamente.
- Guardar todos los screenshots en `.screenshots/` (ignorada en git),
  nunca en la raiz del proyecto.
- Builds: agrupar 2-4 fixes relacionados y buildear una sola vez al
  final. No un build por micro-cambio, pero tampoco agrupar tantos
  cambios que un build roto sea dificil de diagnosticar.
- Exploracion: si el usuario indica archivo/componente, ir directo ahi.
  Explorar el arbol completo solo cuando la ubicacion del problema es
  genuinamente desconocida.

## Verificacion con navegador
- Cambios de logica/comportamiento: verificar por estado/texto
  (snapshot acotado al elemento en juego), sin screenshots.
- Cambios visuales (layout, CSS, componentes nuevos): screenshots
  targeted del componente afectado — pocos, del area justa.
- Todo cambio de UI cierra con al menos una captura en `.screenshots/`
  que el usuario pueda revisar. El ahorro de tokens nunca reemplaza
  la verificacion visual de cambios visuales.
- Al cerrar cada verificacion, borrar de `.screenshots/` lo que ya
  no sirva; la carpeta no acumula entre sesiones.

## Verificacion de layout
- Cualquier chequeo de overflow horizontal o revision visual de layout
  se hace contra esta bateria completa de anchos, no solo 375/768/1440:
  375, 480, 640, 768, 1024, 1280, 1366, 1440, 1536, 1728 y 1920px.
- Para overflow horizontal: comparar `document.documentElement.scrollWidth`
  vs `window.innerWidth` en cada ancho, y escanear el DOM buscando
  elementos cuyo `getBoundingClientRect()` exceda el viewport.
- Grid/flex items que envuelven una `<img>` deben llevar `min-w-0`
  (o `overflow-hidden`) — sin eso, el ancho intrinseco de la imagen
  puede forzar el track a expandirse mas alla del contenedor.

## Reglas de contenido
- El copy existente no se reescribe sin aprobacion explicita. Si un
  texto no entra en el layout, resolverlo con tipografia/breakpoints
  y avisar, no reescribiendo.
- Alt text descriptivo y especifico en toda imagen.

## Mantenimiento de este archivo
- Al cerrar un bloque de trabajo, si surgio una decision durable
  (de negocio, de arquitectura, o una leccion tecnica que evitaria
  repetir un error), PROPONE el texto exacto a agregar a este
  archivo y espera aprobacion. Nunca edites CLAUDE.md sin ok
  explicito del usuario.
- Criterio para proponer: ¿una sesion nueva sin este dato podria
  deshacer una decision tomada, repetir una investigacion ya hecha,
  o cometer un error ya cometido? Si no cumple eso, no es regla,
  es circunstancia — no la propongas.
- Si una regla existente quedo obsoleta por un cambio nuevo,
  proponer tambien su actualizacion o eliminacion, no solo agregar.

### Reservas (estrategia comercial)
- EN DESARROLLO (no implementar nada aun): existe un plan para
  reemplazar HQBeds por un booking engine propio (backend Node+TS
  +Fastify+Postgres, pagos via Asaas), planificado en un Project
  de claude.ai. Mientras no se indique lo contrario, HQBeds sigue
  siendo el canal 1 y TODAS las reglas de esta seccion siguen
  vigentes. Cuando el motor propio llegue al flujo de reserva, se
  reabrira la decision del selector de quarto (la limitacion de
  deep-link era de HQBeds, no de negocio).

## Estrategia de switch (regla de negocio, no negociable)
- El sitio publico sigue mandando TODAS las reservas a HQBeds hasta
  que el motor propio este COMPLETO y probado (modulos 3+4+5 como
  minimo) y Maxi apruebe explicitamente el switch.
- Los modulos 3-5 se desarrollan sin tocar el flujo publico: el
  checkout propio vive en rutas nuevas no enlazadas desde el sitio.
- Ningun cambio en el form de reserva del frontend (destino HQBeds,
  parametros arrival/departure/adults) sin esa aprobacion.
