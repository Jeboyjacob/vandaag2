#!/bin/sh
# Maakt de opslagmap schrijfbaar (op hosting is de schijf eigendom van root) en start de app als gewone gebruiker.
mkdir -p "${UPLOAD_DIR:-/data/uploads}"
chown -R node:node "$(dirname "${UPLOAD_DIR:-/data/uploads}")" 2>/dev/null || true
exec su node -s /bin/sh -c "exec node src/server.js"
