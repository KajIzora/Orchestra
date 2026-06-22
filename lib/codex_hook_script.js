const { buildHookForwarderBlock } = require('./hook_forwarder');

/** Bash forwarder posted to Orchestra by Codex hooks. */
function getCodexTaskAppHookScript() {
  const forwarder = buildHookForwarderBlock({
    envApiBase: 'CODEX_HOOK_API_BASE',
    envToken: 'CODEX_HOOK_TOKEN',
    envRemoteHost: 'CODEX_HOOK_REMOTE_HOST',
    tokenField: 'codex',
    endpoint: '/api/codex-hooks/event',
    header: 'X-Codex-Hook-Token',
    configEndpoint: '/api/codex-hooks/config',
  });
  return `#!/bin/bash
set +e
payload="$(cat)"

${forwarder}

# Codex hooks may parse stdout as control/context output. Keep this valid and inert.
echo '{"continue": true, "suppressOutput": true}'
exit 0
`;
}

module.exports = {
  getCodexTaskAppHookScript,
};
