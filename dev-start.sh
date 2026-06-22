#!/usr/bin/env bash
# Dev Orchestra: latest repo code, browser UI, agents. Data: ~/.orchestra/dev, port 47823.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
if [[ -f "$ROOT/.env.dev" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ROOT/.env.dev"
  set +a
fi
cd "$ROOT"
echo "[dev-start] ORCHESTRA_DATA_DIR=${ORCHESTRA_DATA_DIR} HOST=${HOST} PORT=${PORT}"
echo "[dev-start] Open http://127.0.0.1:${PORT} (or this machine's LAN IP if HOST=0.0.0.0)"
export ORCHESTRA_DATA_DIR HOST PORT
exec ./start.sh
