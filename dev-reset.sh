#!/usr/bin/env bash
# Stop the dev server and optionally wipe ~/.orchestra/dev (fresh tasks for testing).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_saved_port="${PORT-}"
set -a
# shellcheck source=profiles/dev.env
source "$ROOT/profiles/dev.env"
set +a
[[ -n "${_saved_port}" ]] && PORT="${_saved_port}"
DATA_DIR="${ORCHESTRA_DATA_DIR/#\~/$HOME}"

pids="$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "${pids}" ]]; then
  echo "[dev-reset] Stopping process(es) on port ${PORT}: ${pids}"
  # shellcheck disable=SC2086
  kill ${pids} 2>/dev/null || true
  sleep 0.5
else
  echo "[dev-reset] No listener on port ${PORT}"
fi

if [[ ! -d "${DATA_DIR}" ]]; then
  echo "[dev-reset] Data dir already absent: ${DATA_DIR}"
  exit 0
fi

printf 'Delete all dev data in %s? [y/N] ' "${DATA_DIR}"
read -r ans
if [[ "${ans}" =~ ^[Yy]$ ]]; then
  rm -rf "${DATA_DIR}"
  echo "[dev-reset] Removed ${DATA_DIR}"
else
  echo "[dev-reset] Kept data (server stopped only)."
fi
