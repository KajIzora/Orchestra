const { buildHookForwarderBlock } = require('./hook_forwarder');

/** Bash forwarder posted to Orchestra by Claude Code hooks (local or remote). */
function getClaudeTaskAppHookScript() {
  const forwarder = buildHookForwarderBlock({
    envApiBase: 'CLAUDE_HOOK_API_BASE',
    envToken: 'CLAUDE_HOOK_TOKEN',
    envRemoteHost: 'CLAUDE_HOOK_REMOTE_HOST',
    tokenField: 'claude',
    endpoint: '/api/claude-hooks/event',
    header: 'X-Claude-Hook-Token',
    configEndpoint: '/api/claude-hooks/config',
  });
  return `#!/bin/bash
set +e
payload="$(cat)"

${forwarder}
exit 0
`;
}

module.exports = {
  getClaudeTaskAppHookScript,
};
