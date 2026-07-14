#!/usr/bin/env bash
# Dev Orchestra: latest repo code, browser UI, agents. Data: ~/.orchestra/dev, port 47823.
# Run from any Orchestra checkout or worktree; uses that tree's code (not the main repo path).
set -euo pipefail
_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ensure_repo_ready.sh
source "$_SCRIPT_DIR/scripts/ensure_repo_ready.sh"
prepare_orchestra_repo "$_SCRIPT_DIR"
ROOT="$ORCHESTRA_ROOT"
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
echo "[dev-start] Orchestra root: ${ROOT}"
echo "[dev-start] ORCHESTRA_DATA_DIR=${ORCHESTRA_DATA_DIR} HOST=${HOST} PORT=${PORT}"
echo "[dev-start] Open http://127.0.0.1:${PORT} (or this machine's LAN IP if HOST=0.0.0.0)"
export ORCHESTRA_DATA_DIR HOST PORT
exec ./start.sh
