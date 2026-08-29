#!/usr/bin/env bash
# Deploy manual de backend (server/) + panel (panel/) al VPS.
# Corre ESTE script parado en el VPS, dentro del checkout existente:
#   ssh catavento-vps
#   cd /var/www/catavento-web
#   bash scripts/deploy-panel-backend.sh
#
# No hay CI/CD (decisión deliberada, ver server/CLAUDE.md) — este script
# reemplaza a la lista de comandos pegada a mano, para que un deploy a
# producción no dependa de que el pegado no corte una línea.
#
# Este script SÍ hace `git pull` (paso 1) — si estás corriendo una
# versión vieja de este mismo archivo, el pull trae la versión nueva a
# disco pero bash ya tiene esta ejecución cargada en memoria: no hay
# jumps ni funciones que fuercen una relectura del archivo durante la
# corrida, así que es seguro. Si tenés dudas, hacé `git pull` a mano
# una vez antes de correr el script.
#
# set -e: cualquier comando que falle aborta todo el script en el acto
# (no sigue al panel si el backend no levantó bien).
set -euo pipefail

REPO_DIR="/var/www/catavento-web"
PANEL_DIST_DIR="/var/www/catavento-panel/dist"
BACKUP_DIR="/var/backups/catavento"

echo "=== Paso 0: backup de catavento_db ==="
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
DUMP_TMP="/tmp/catavento_db_${TIMESTAMP}.dump"
# pg_dump a secas falla por permisos — tiene que correr como el usuario postgres.
sudo -u postgres pg_dump -Fc catavento_db > "$DUMP_TMP"
sudo mkdir -p "$BACKUP_DIR"
# postgres no tiene permiso de escritura en $BACKUP_DIR; se escribe a
# /tmp primero y se mueve después con un usuario que sí puede.
sudo mv "$DUMP_TMP" "$BACKUP_DIR"/
ls -lh "$BACKUP_DIR" | tail -3

echo "=== Paso 1: backend ==="
cd "$REPO_DIR"
git pull origin main
cd server
npm ci
npm run build
npm run migrate:up
pm2 restart catavento-payments

echo "=== Verificación post-deploy: backend ==="
cd "$REPO_DIR"
echo "--- git log (commit esperado como HEAD) ---"
git log --oneline -3
# El log de arriba es para que lo leas vos; esto lo hace fallar solo si
# el pull no dejó el checkout apuntando a lo mismo que origin/main —
# la lección de 9B fue justo que un pull salteado "parecía" andar.
LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(git rev-parse origin/main)"
if [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
  echo "FALLO: HEAD ($LOCAL_HEAD) no coincide con origin/main ($REMOTE_HEAD) — el pull no trajo lo esperado." >&2
  exit 1
fi
echo "--- pm2 logs (sin errores de arranque) ---"
pm2 logs catavento-payments --lines 30 --nostream
echo "--- buscando el endpoint de overrides (9B) en el build compilado ---"
if grep -rq "/panel/users/:id/overrides" server/dist/; then
  echo "OK: el endpoint de overrides está presente en el build compilado del backend."
else
  echo "FALLO: el endpoint de overrides NO aparece en server/dist/ — el build del backend quedó viejo." >&2
  exit 1
fi

echo "=== Paso 2: panel ==="
cd "$REPO_DIR/panel"
npm ci
npm run build
rsync -a --delete dist/ "$PANEL_DIST_DIR/"
sudo chown -R www-data:www-data "$PANEL_DIST_DIR"

echo "=== Verificación post-deploy: panel ==="
echo "--- buscando el cambio del fix de overrides en el build servido ---"
if grep -rq "Salve a troca de papel antes de editar" "$PANEL_DIST_DIR"/assets/*.js; then
  echo "OK: el cambio está presente en el build servido."
else
  echo "FALLO: el cambio NO aparece en el build servido — el deploy del panel quedó viejo." >&2
  exit 1
fi

echo "=== Deploy completo ==="
