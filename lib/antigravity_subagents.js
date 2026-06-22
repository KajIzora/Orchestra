// Shared discovery of an agy (Antigravity) parent's sub-agents.
//
// When an agy agent delegates, its transcript records an INVOKE_SUBAGENT step whose `content`
// lists the spawned sub-agents — each with its own `conversationId` and `logAbsoluteUri`
// (file:// path to the child's transcript.jsonl). Sub-agents get sibling `brain/<conversationId>`
// dirs, so this is the only authoritative parent->child link (a parent only ever lists ITS own
// children, which makes it correct even when other agents run concurrently in the same workspace).
//
// Used by both the offline recording/timeline tooling (scripts/tail_to_signal_recording.js) and
// the live/replay cascade-completion logic (lib/gemini_poller_deps.js via server.js / signal_replay)
// — same parser, same result, for agy-cli and agy-app (identical transcript shape).

function uriToPath(uri) {
  return String(uri || '').replace(/^file:\/\//, '');
}

/**
 * Pull child {conversationId, transcriptPath} from a parent's INVOKE_SUBAGENT transcript rows.
 * @param {Array<string|object>} rawLines transcript jsonl lines (strings) or already-parsed entries
 * @returns {Array<{conversationId:string, transcriptPath:string}>}
 */
function subagentChildrenFromTranscriptLines(rawLines) {
  const children = [];
  for (const raw of rawLines || []) {
    let entry;
    try {
      entry = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      continue;
    }
    if (!entry || entry.type !== 'INVOKE_SUBAGENT') continue;
    const content = typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content || '');
    const ids = [...content.matchAll(/"conversationId"\s*:\s*"([0-9a-fA-F-]{36})"/g)].map((m) => m[1]);
    const uris = [...content.matchAll(/"logAbsoluteUri"\s*:\s*"([^"]+)"/g)].map((m) => uriToPath(m[1]));
    ids.forEach((id, i) => children.push({ conversationId: id, transcriptPath: uris[i] || '' }));
  }
  return children;
}

/**
 * Parse a parent's full transcript text (jsonl) for its direct sub-agent children.
 * @param {string} transcriptText raw transcript.jsonl contents
 * @returns {Array<{conversationId:string, transcriptPath:string}>}
 */
function parseSubAgentChildren(transcriptText) {
  const lines = String(transcriptText || '')
    .split(/\r?\n/)
    .filter((l) => l.trim());
  return subagentChildrenFromTranscriptLines(lines);
}

module.exports = {
  uriToPath,
  subagentChildrenFromTranscriptLines,
  parseSubAgentChildren,
};
