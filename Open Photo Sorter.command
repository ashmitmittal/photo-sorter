#!/bin/zsh
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is needed: https://nodejs.org"
  read -k1 "?Press any key to close."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing (first run only)…"
  npm install --no-audit --no-fund || exit 1
fi

URL="http://127.0.0.1:8765"
if curl -s "$URL/api/state" >/dev/null 2>&1; then
  open "$URL"
  exit 0
fi

node server.js --open "$@"
