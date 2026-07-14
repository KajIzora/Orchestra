#!/usr/bin/env bash
# Rebuild and install stable Orchestra.app (daily desktop). Data: ~/.orchestra/stable, port 47824.
# Run from any Orchestra checkout or worktree; builds and installs code from that tree.
# Usage: ./stable-update.sh [--sign]
#        HOST=0.0.0.0 ./stable-update.sh   # bake LAN host into the installed app
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
# shellcheck source=profiles/stable.env
source "$ROOT/profiles/stable.env"
set +a
[[ -n "${_saved_data}" ]] && ORCHESTRA_DATA_DIR="${_saved_data}"
[[ -n "${_saved_host}" ]] && HOST="${_saved_host}"
[[ -n "${_saved_port}" ]] && PORT="${_saved_port}"
if [[ -f "$ROOT/.env.stable" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ROOT/.env.stable"
  set +a
fi

STABLE_DIR="${ORCHESTRA_DATA_DIR/#\~/$HOME}"
LEGACY="${HOME}/.agent-task-tracker"
if [[ ! -e "${STABLE_DIR}/data.json" && -f "${LEGACY}/data.json" ]]; then
  echo "[stable-update] One-time migration: ${LEGACY} -> ${STABLE_DIR}"
  mkdir -p "$(dirname "${STABLE_DIR}")"
  cp -R "${LEGACY}" "${STABLE_DIR}"
fi

export ORCHESTRA_DATA_DIR HOST PORT
echo "[stable-update] Orchestra root: ${ROOT}"
echo "[stable-update] ORCHESTRA_DATA_DIR=${ORCHESTRA_DATA_DIR} HOST=${HOST} PORT=${PORT}"
echo "[stable-update] Running rebuild.sh --install-applications $*"
cd "${ROOT}"
exec ./rebuild.sh --install-applications "$@"
