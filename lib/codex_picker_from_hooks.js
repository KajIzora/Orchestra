'use strict';

const { applyActiveGenerationStaleCutoff, toIso } = require('./active_generation');
const { mergeDiscoveryPickerRuns } = require('./discovery_picker_merge');
const { anyLocalPathUnderConfiguredRoots } = require('./workspace_scope');

/**
 * Convert a Codex hook-store snapshot into a LOCAL picker row.
 * Mirrors the shape the local codex branch of listCodexRunsFromHookStore consumes; the sibling of
 * claude's snapshotToClaudePickerRun. Relocated here (from server.js) so the row's field set is a
 * single source of truth that the discovery-merge parity test can verify against.
 */
function snapshotToLocalPickerRun(snap) {
  const updatedMs = Date.parse(snap.updated_at || '') || 0;
  const hookGenerating = !!snap.generating && !snap.completion_hint;
  const activeGen = applyActiveGenerationStaleCutoff(
    {
      generating: hookGenerating,
      start_signal_at: toIso(updatedMs),
      last_activity_at: toIso(updatedMs),
      inactive_reason: hookGenerating ? '' : 'completion_signal',
    },
    { mtimeMs: updatedMs }
  );
  return {
    kind: 'ide_agent',
    provider: 'codex',
    source: 'local',
    session_id: snap.session_id || '',
    transcript_path: snap.transcript_path || '',
    title: snap.title || '',
    workspace_path: snap.workspace_path || '',
    updated_at: snap.updated_at || '',
    mtime_ms: updatedMs,
    last_user_preview: snap.last_user_preview || snap.session_id || '',
    host: null,
    projects_root: null,
    state_location: '',
    completion_hint: !!snap.completion_hint,
    ...activeGen,
  };
}

// ---- codex dedup identity ---------------------------------------------------------------------
// Codex keys on transcript_path ONLY (unlike claude, which also keys on session_id). A hook
// snapshot stores codex's internal session_id, while a discovery row uses the rollout filename
// basename `rollout-<ts>-<uuid>` — the two ids DIFFER (verified: session_meta session_id
// 019f293c… vs filename id 019f293d…), so a session-id key would double-count the same run. Both
// sides carry the identical absolute rollout transcript_path under ~/.codex/sessions, which is the
// reliable shared identity.
function codexPickerRunKeys(run) {
  const transcript = typeof run?.transcript_path === 'string' ? run.transcript_path.trim() : '';
  return transcript ? [`t:${transcript}`] : [];
}

// ---- local discovery merge (in-flight generation fix) ----------------------------------------
// The codex sibling of mergeLocalClaudeDiscoveryPickerRuns. Codex hook snapshots are in-memory
// only, so an agent that started generating while Orchestra was down has no snapshot and would
// never appear in the picker. Discovery (discoverCodexRuns, bounded with recentOnlyMs) surfaces
// the in-flight rollout from disk. Deliberate divergences from the ssh discovery fallbacks:
// - ALWAYS merged, not gated on zero snapshot rows: once Orchestra is up, snapshots from OTHER
//   local runs arrive, so a zero-rows gate would re-hide the missed run the instant any one agent
//   fires a hook.
// - only rows the rollout classifies as generating are merged: done/stale local history is the
//   hook store's business; discovery exists purely to surface in-flight runs the hooks missed.

/**
 * Merge locally-discovered codex rollout runs (discoverCodexRuns output, bounded with
 * recentOnlyMs) into snapshot-derived LOCAL picker rows.
 * - keeps only discovered rows with generating === true (see above);
 * - applies the same workspace gating the local snapshot path uses (localWorkspaces);
 * - stamps the fields snapshot rows carry but discovery rows lack, so the picker/client cannot
 *   tell them apart (host/projects_root null, state_location '', completion_hint false) — plus
 *   discovered:true so live tests can;
 * - dedupes by transcript_path via the shared core (a snapshot row always wins).
 */
function mergeLocalCodexDiscoveryPickerRuns(snapshotRuns, discoveredRuns, opts = {}) {
  const localWorkspaces = Array.isArray(opts.localWorkspaces)
    ? opts.localWorkspaces.map((p) => String(p || '').trim()).filter(Boolean)
    : [];
  const candidates = [];
  for (const run of Array.isArray(discoveredRuns) ? discoveredRuns : []) {
    if (!run || typeof run !== 'object') continue;
    if (run.generating !== true) continue;
    if (localWorkspaces.length) {
      const ws = String(run.workspace_path || '').trim();
      if (!anyLocalPathUnderConfiguredRoots(localWorkspaces, ws)) continue;
    }
    candidates.push({
      ...run,
      source: 'local',
      host: null,
      projects_root: null,
      state_location: '',
      completion_hint: false,
      discovered: true,
    });
  }
  const out = mergeDiscoveryPickerRuns(
    Array.isArray(snapshotRuns) ? snapshotRuns : [],
    candidates,
    { keyFor: codexPickerRunKeys }
  );
  out.sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0));
  return out;
}

module.exports = {
  snapshotToLocalPickerRun,
  codexPickerRunKeys,
  mergeLocalCodexDiscoveryPickerRuns,
};
