#!/usr/bin/env bash
# Run after unzipping a new version over this folder (your .env is kept).
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
npm install --omit=dev --no-audit --no-fund
if [ -d dist ]; then
    echo "Rebuilding the protected pages ..."
    npm install --no-save --no-audit --no-fund terser javascript-obfuscator >/dev/null 2>&1 && npm run build || { rm -rf dist; echo "Build failed - using the normal pages."; }
fi
pm2 restart bingo --update-env
sleep 3
curl -fs http://127.0.0.1:3000/health && echo && echo "✅ Updated and running."
