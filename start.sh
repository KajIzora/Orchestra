#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# Browser + menu-bar mode: starts Node backend (and optional menubar.py).
# For a native window instead, use: npm run desktop:dev (see README).
# Dev defaults (HOST=0.0.0.0, PORT=47823, ~/.orchestra/dev): profiles/dev.env
if [[ -z "${ORCHESTRA_SKIP_DEV_PROFILE:-}" ]]; then
  _saved_data="${ORCHESTRA_DATA_DIR-}"
  _saved_host="${HOST-}"
  _saved_port="${PORT-}"
  set -a
  # shellcheck source=profiles/dev.env
  source "$ROOT/profiles/dev.env"
  set +a
  [[ -n "${_saved_data}" ]] && ORCHESTRA_DATA_DIR="${_saved_data}"
  [[ -n "${_saved_host}" ]] && HOST="${_saved_host}"
  [[ -n "${_saved_port}" ]] && PORT="${_saved_port}"
  export ORCHESTRA_DATA_DIR HOST PORT
fi

# Start backend in the background
node server.js &
BACKEND_PID=$!

# Give the backend a moment to write config.json
sleep 0.5

# Start menu bar helper (optional — skip if python3 or rumps missing)
MENUBAR_PID=""
if command -v python3 >/dev/null 2>&1; then
  if python3 -c "import rumps" 2>/dev/null; then
    ORCHESTRA_DATA_DIR="${ORCHESTRA_DATA_DIR:-}" python3 menubar.py &
    MENUBAR_PID=$!
  else
    echo "[start.sh] rumps not installed; skipping menu bar helper."
    echo "[start.sh]   Install with: pip3 install rumps"
  fi
else
  echo "[start.sh] python3 not found; skipping menu bar helper."
fi

cleanup() {
  [ -n "$MENUBAR_PID" ] && kill "$MENUBAR_PID" 2>/dev/null || true
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
}
trap cleanup EXIT

wait "$BACKEND_PID"
