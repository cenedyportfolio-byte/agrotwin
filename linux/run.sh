#!/usr/bin/env bash
# Starts AgroTwin on Linux.
#   ./linux/run.sh              production: builds frontend when its source changed, then serves it
#   ./linux/run.sh dev          hot-reloading dev servers
#   ./linux/run.sh --lan        listen on 0.0.0.0 so tablets/phones can reach :8000 and :3000
#   ./linux/run.sh stop         stops servers cleanly

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$ROOT_DIR/.cache/run.pid"
MODE="prod"
LAN=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    dev|prod|stop)
      MODE="$1"
      shift
      ;;
    --lan|-Lan)
      LAN=true
      shift
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: $0 [prod|dev|stop] [--lan]"
      exit 1
      ;;
  esac
done

get_port_pids() {
  if command -v lsof &>/dev/null; then
    lsof -ti:8000,3000 2>/dev/null || true
  elif command -v ss &>/dev/null; then
    ss -tlnp 2>/dev/null | grep -E ':(8000|3000)\b' | grep -oP 'pid=\K[0-9]+' || true
  else
    fuser 8000/tcp 3000/tcp 2>/dev/null || true
  fi
}

if [[ "$MODE" == "stop" ]]; then
  echo "Stopping AgroTwin services..."
  if [[ -f "$PID_FILE" ]]; then
    SAVED_PID=$(cat "$PID_FILE" 2>/dev/null || true)
    if [[ -n "$SAVED_PID" ]] && kill -0 "$SAVED_PID" 2>/dev/null; then
      kill -TERM "$SAVED_PID" 2>/dev/null || true
      sleep 1
      kill -9 "$SAVED_PID" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi

  # Clean up any lingering uvicorn or next processes on ports 8000 or 3000
  PORT_PIDS=$(get_port_pids)
  if [[ -n "$PORT_PIDS" ]]; then
    for pid in $PORT_PIDS; do
      if ps -p "$pid" -o cmd= | grep -E 'uvicorn|next|node' &>/dev/null; then
        echo "Killing lingering process $pid..."
        kill -9 "$pid" 2>/dev/null || true
      fi
    done
  fi

  sleep 0.5
  REMAINING=$(get_port_pids)
  if [[ -n "$REMAINING" ]]; then
    echo "Warning: Port 8000 or 3000 is still in use by PID $REMAINING (external process)."
  else
    echo "AgroTwin stopped successfully."
  fi
  exit 0
fi

# Check if ports are already taken
ACTIVE_PIDS=$(get_port_pids)
if [[ -n "$ACTIVE_PIDS" ]]; then
  echo "AgroTwin (or another service) is already running on port 8000 or 3000 (PID: $ACTIVE_PIDS)."
  echo "To stop it, run: ./linux/run.sh stop"
  exit 1
fi

# Ensure cache and log directories exist
mkdir -p "$ROOT_DIR/logs" \
         "$ROOT_DIR/.cache/tmp" \
         "$ROOT_DIR/.cache/uv" \
         "$ROOT_DIR/.cache/pip" \
         "$ROOT_DIR/.cache/torch_extensions"

export TEMP="$ROOT_DIR/.cache/tmp"
export TMP="$TEMP"
export UV_CACHE_DIR="$ROOT_DIR/.cache/uv"
export PIP_CACHE_DIR="$ROOT_DIR/.cache/pip"
export TORCH_EXTENSIONS_DIR="$ROOT_DIR/.cache/torch_extensions"

# Select the Python: the first one whose torch sees a CUDA GPU (processing then
# runs on the NVIDIA GPU). AGROTWIN_PYTHON overrides; ~/.venvs/agrotwin is the
# Linux CUDA venv when the drive's own venvs are Windows builds.
PYTHON=""
FALLBACK=""
for c in "${AGROTWIN_PYTHON:-}" "$ROOT_DIR/backend/.venv-gpu/bin/python" "$HOME/.venvs/agrotwin/bin/python" "$ROOT_DIR/backend/.venv/bin/python"; do
  [[ -n "$c" && -x "$c" ]] || continue
  [[ -n "$FALLBACK" ]] || FALLBACK="$c"
  if "$c" -c "import torch, sys; sys.exit(0 if torch.cuda.is_available() else 1)" 2>/dev/null; then PYTHON="$c"; break; fi
done
if [[ -z "$PYTHON" ]]; then
  if [[ -z "$FALLBACK" ]]; then
    echo "Error: no backend Python found (AGROTWIN_PYTHON, backend/.venv-gpu, ~/.venvs/agrotwin, backend/.venv)."
    echo "Create one using:"
    echo "  uv venv backend/.venv-gpu --python 3.11"
    echo "  uv pip install -r backend/requirements.txt"
    exit 1
  fi
  PYTHON="$FALLBACK"
  echo "WARNING: no Python with CUDA torch found - processing will run on the CPU"
fi
echo "Backend Python: $PYTHON"

if [[ ! -d "$ROOT_DIR/frontend/node_modules" ]]; then
  echo "Error: frontend/node_modules missing. Run: (cd frontend && npm ci)"
  exit 1
fi

# Relocate paths if drive was mounted under a new path
(cd "$ROOT_DIR/backend" && "$PYTHON" -m scripts.relocate_paths 2>/dev/null || true)

BIND="127.0.0.1"
if [[ "$LAN" == true ]]; then
  BIND="0.0.0.0"
fi

# Backend startup command
if [[ "$MODE" == "dev" ]]; then
  BACKEND_CMD=("$PYTHON" -m uvicorn app.main:app --host "$BIND" --port 8000 --reload --reload-dir app)
else
  BACKEND_CMD=("$PYTHON" -m uvicorn app.main:app --host "$BIND" --port 8000 --workers 1)
fi

echo "Starting Backend API on $BIND:8000..."
(cd "$ROOT_DIR/backend" && exec "${BACKEND_CMD[@]}") > "$ROOT_DIR/logs/backend.log" 2> "$ROOT_DIR/logs/backend.err.log" &
BACKEND_PID=$!

# Frontend startup command
NEXT="node_modules/next/dist/bin/next"
if [[ "$MODE" == "dev" ]]; then
  FRONTEND_CMD=(node "$NEXT" dev -H "$BIND" -p 3000)
else
  # rebuild when the source changed since the last build, or the old frontend keeps being served
  if [[ ! -f "$ROOT_DIR/frontend/.next/BUILD_ID" ]] || [[ -n "$(cd "$ROOT_DIR/frontend" && find app components lib next.config.ts package.json -newer .next/BUILD_ID -print -quit)" ]]; then
    echo "Building frontend (source changed since the last build)..."
    (cd "$ROOT_DIR/frontend" && node scripts/copy-cesium.mjs && node "$NEXT" build)
  fi
  FRONTEND_CMD=(node "$NEXT" start -H "$BIND" -p 3000)
fi

echo "Starting Frontend on $BIND:3000..."
(cd "$ROOT_DIR/frontend" && exec "${FRONTEND_CMD[@]}") > "$ROOT_DIR/logs/frontend.log" 2> "$ROOT_DIR/logs/frontend.err.log" &
FRONTEND_PID=$!

# Record PID
echo "$$" > "$PID_FILE"

cleanup() {
  echo ""
  echo "Shutting down AgroTwin..."
  kill -TERM "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  sleep 1
  kill -9 "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "Done."
}

trap cleanup SIGINT SIGTERM EXIT

echo ""
echo "=========================================================="
echo " AgroTwin is running!"
echo " Web UI:   http://localhost:3000"
echo " API Docs: http://localhost:8000/docs"
echo " Logs:     logs/backend.log | logs/frontend.log"
echo " Press Ctrl-C to stop."
echo "=========================================================="

if [[ "$LAN" == true ]]; then
  LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  if [[ -n "$LAN_IP" ]]; then
    echo " LAN URL:  http://${LAN_IP}:3000"
  fi
fi

# Wait for background processes
wait "$BACKEND_PID" "$FRONTEND_PID"
