const { buildHookForwarderBlock } = require('./hook_forwarder');

/** Bash forwarder posted to Orchestra by Gemini CLI hooks (local or remote). */
function getGeminiTaskAppHookScript() {
  const forwarder = buildHookForwarderBlock({
    envApiBase: 'GEMINI_HOOK_API_BASE',
    envToken: 'GEMINI_HOOK_TOKEN',
    envRemoteHost: 'GEMINI_HOOK_REMOTE_HOST',
    tokenField: 'gemini',
    endpoint: '/api/gemini-hooks/event',
    header: 'X-Gemini-Hook-Token',
    configEndpoint: '/api/gemini-hooks/config',
    appToken: true,
  });
  return `#!/bin/bash
set +e
HOOK_EVENT="\${1:-unknown}"
DEBUG_LOG="\${GEMINI_HOOK_DEBUG_LOG:-\$HOME/.gemini/antigravity-cli/scratch/hook-debug.log}"
DEBUG_DIR="\$(dirname \"\$DEBUG_LOG\")"
mkdir -p "\$DEBUG_DIR" 2>/dev/null || true

echo "=== HOOK START ===" >> "\$DEBUG_LOG"
echo "DATE: \$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "\$DEBUG_LOG"
echo "HOOK: \$HOOK_EVENT" >> "\$DEBUG_LOG"
echo "ARGS: \$@" >> "\$DEBUG_LOG"

# Read hook stdin until EOF. Stop hooks on cancel may never send stdin or close it;
# use a short max wait for Stop, longer for other hooks so agy has time to write JSON.
# NOTE: use python3 -c (not a heredoc) so agy's piped stdin is not consumed by the script body.
export HOOK_EVENT="\$HOOK_EVENT"
payload="\$(python3 -c '
import os, select, sys, time

hook = os.environ.get("HOOK_EVENT", "")
max_wait = float(os.environ.get("GEMINI_HOOK_STDIN_TIMEOUT", "15"))
if hook == "Stop":
    max_wait = float(os.environ.get("GEMINI_HOOK_STOP_STDIN_TIMEOUT", "2"))

deadline = time.time() + max_wait
chunks = []
got_data = False

while True:
    if not got_data and time.time() >= deadline:
        break
    timeout = min(0.2, deadline - time.time()) if not got_data else 0.2
    if timeout <= 0 and not got_data:
        break
    ready, _, _ = select.select([sys.stdin], [], [], max(0, timeout))
    if ready:
        data = sys.stdin.read(65536)
        if data == "":
            break
        chunks.append(data)
        got_data = True
    elif got_data:
        break

sys.stdout.write("".join(chunks))
' 2>/dev/null)"

echo "PAYLOAD: \$payload" >> "\$DEBUG_LOG"
echo "ALL_ENV:" >> "\$DEBUG_LOG"
env >> "\$DEBUG_LOG"
echo "=== HOOK END ===" >> "\$DEBUG_LOG"

# Stamp the hook event name onto the payload (remote_host is added per-target by the forwarder).
payload="\$(HOOK_EVENT="\$HOOK_EVENT" GEMINI_HOOK_PAYLOAD="\$payload" python3 - <<'PY' 2>/dev/null
import json, os, sys
raw = os.environ.get("GEMINI_HOOK_PAYLOAD", "")
try:
    data = json.loads(raw or "{}")
    if not isinstance(data, dict):
        data = {}
except Exception:
    data = {}
hook_event = os.environ.get("HOOK_EVENT", "").strip()
if hook_event and hook_event != "unknown":
    data["hook_event_name"] = hook_event
sys.stdout.write(json.dumps(data))
PY
)"

${forwarder}

# agy hooks must return valid protojson on stdout (not legacy {"ok": true}).
case "\$HOOK_EVENT" in
  PreToolUse)
    echo '{"decision":"allow"}'
    ;;
  *)
    echo '{}'
    ;;
esac
exit 0
`;
}

module.exports = {
  getGeminiTaskAppHookScript,
};
