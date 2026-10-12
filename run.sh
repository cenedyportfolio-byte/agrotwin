#!/usr/bin/env bash
# Starts AgroTwin from this folder (any machine / mount point).
#   ./run.sh        production: builds the frontend when its source changed, then serves it
#   ./run.sh dev    hot-reloading dev servers (slow from a USB/exFAT drive)
# Backend :8000, frontend :3000. Ctrl-C stops both.
# The production server lists frontend/public at startup: after building new
# tiles / models / splats, restart it (Ctrl-C, ./run.sh) so they are served.
set -euo pipefail
cd "$(dirname "$0")"
MODE="${1:-prod}"
NEXT="node node_modules/next/dist/bin/next"   # no node_modules/.bin on exFAT

# The backend's Python: the first one whose torch sees a CUDA GPU, so mosaics,
# band orthophotos and analysis run on the NVIDIA GPU. AGROTWIN_PYTHON
# overrides; ~/.venvs/agrotwin is the Linux CUDA venv when the drive's own
# venvs are Windows builds (exFAT drive shared with Windows).
PY=""
FALLBACK=""
for c in "${AGROTWIN_PYTHON:-}" "$PWD/backend/.venv-gpu/bin/python" "$HOME/.venvs/agrotwin/bin/python" "$PWD/backend/.venv/bin/python"; do
  [ -n "$c" ] && [ -x "$c" ] || continue
  [ -n "$FALLBACK" ] || FALLBACK="$c"
  if "$c" -c "import torch, sys; sys.exit(0 if torch.cuda.is_available() else 1)" 2>/dev/null; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  [ -n "$FALLBACK" ] || { echo "run ./setup.sh first"; exit 1; }
  PY="$FALLBACK"
  echo "WARNING: no Python with CUDA torch found - processing will run on the CPU"
fi
echo "backend python: $PY"
( cd backend && "$PY" -m scripts.relocate_paths >/dev/null ) || true

cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM

( cd backend && exec "$PY" -m uvicorn app.main:app --host 0.0.0.0 --port 8000 $([ "$MODE" = dev ] && echo --reload) ) &

if [ "$MODE" = dev ]; then
  ( cd frontend && exec $NEXT dev -H 0.0.0.0 ) &
else
  # Rebuild when there is no production build or the source changed since the
  # last one: otherwise the server keeps serving the old frontend.
  ( cd frontend
    if [ ! -f .next/BUILD_ID ] || [ -n "$(find app components lib next.config.ts package.json -newer .next/BUILD_ID -print -quit)" ]; then
      echo "Building the frontend (source changed since the last build)..."
      node scripts/copy-cesium.mjs && $NEXT build
    fi
    exec $NEXT start -H 0.0.0.0 ) &
fi
echo "AgroTwin: http://localhost:3000  (API http://localhost:8000/docs)"
wait
