const { applyActiveGenerationStaleCutoff, toIso } = require('./active_generation');
const { mergeDiscoveryPickerRuns } = require('./discovery_picker_merge');
const {
  anyLocalPathUnderConfiguredRoots,
  anyPosixPathUnderConfiguredRoots,
} = require('./workspace_scope');
const { agyAgentKindFromArtifactPath } = require('./antigravity_hook_signals');

// Antigravity's two surfaces are distinguished by their brain root: `antigravity-cli/` (command
// line) vs `antigravity/` (the desktop app). The snapshot stamps `agy_agent_kind` ('cli'|'app')
// when a real disk hook set it; fall back to deriving the kind from the transcript path. Map to
// Orchestra's surface kinds ('app' → 'desktop'); Antigravity has no editor-plugin surface.
function geminiSurfaceFromSnapshot(snap) {
  const kind =
    String(snap.agy_agent_kind || '').trim().toLowerCase() ||
    agyAgentKindFromArtifactPath(snap.transcript_path);
  if (kind === 'cli') return 'cli';
  if (kind === 'app') return 'desktop';
  return '';
}

/**
 * Convert a Gemini hook-store snapshot into a picker row.
 */
function snapshotToGeminiPickerRun(snap, source, remote, workspace) {
  const updatedMs = Date.parse(snap.updated_at || '') || 0;
  const isLegacyPermission =
    snap.event_name === 'Notification' && snap.notification_type === 'ToolPermission';
  const isPermission = isLegacyPermission || !!snap.permission_pending;
  const isQuestionPending = !!snap.question_pending;
  const hookGenerating =
    isPermission || isQuestionPending ? true : !!snap.generating && !snap.completion_hint;
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
    provider: 'gemini',
    source: source === 'ssh' ? 'ssh' : 'local',
    session_id: snap.session_id || '',
    transcript_path: snap.transcript_path || '',
    title: snap.title || '',
    surface: geminiSurfaceFromSnapshot(snap),
    workspace_path: snap.workspace_path || workspace || '',
    updated_at: snap.updated_at || '',
    mtime_ms: updatedMs,
    last_user_preview: snap.last_user_preview || snap.prompt || 'Awaiting user message',
    host: remote ? remote.host : null,
    projects_root: remote ? remote.projects_root : null,
    state_location: source === 'ssh' ? 'remote' : '',
    completion_hint: isPermission || isQuestionPending ? false : !!snap.completion_hint,
    notification_type: isPermission ? 'ToolPermission' : snap.notification_type || '',
    question_pending: isQuestionPending,
    ...activeGen,
  };
}

function normalizeId(id) {
  return String(id || '').trim().toLowerCase();
}

/**
 * Build picker rows from Gemini hook snapshots (local or remote).
 * @param {object[]} snapshots
 * @param {{ source: 'local'|'ssh', localWorkspaces?: string[], remotes?: Array<{host:string, projects_root?:string, workspaces?:string[]}>, excludeSessionIds?: Iterable<string> }} opts
 */
function pickerRunsFromGeminiSnapshots(snapshots, opts = {}) {
  const list = Array.isArray(snapshots) ? snapshots : [];
  // Sub-agent conversations get their own hook snapshot (session_id = the child conversationId),
  // so without this they show up as standalone picker rows alongside their parent. The parent's
  // INVOKE_SUBAGENT step is the only authoritative parent->child link; the caller resolves it into
  // this id set so the picker only offers top-level agy runs.
  const excluded = new Set([...(opts.excludeSessionIds || [])].map(normalizeId).filter(Boolean));
  const isSubAgent = (run) => excluded.size > 0 && excluded.has(normalizeId(run.session_id));
  if (opts.source === 'ssh') {
    const remotes = Array.isArray(opts.remotes) ? opts.remotes : [];
    const runs = [];
    for (const remote of remotes) {
      const allowedPaths = Array.isArray(remote.workspaces)
        ? remote.workspaces.map((p) => String(p || '').trim()).filter(Boolean)
        : [];
      const seenKeys = new Set();
      for (const snap of list) {
        if (!snap) continue;
        if (snap.remote_host !== remote.host) continue;
        const snapWs = String(snap.workspace_path || '').trim();
        let workspace = '';
        if (allowedPaths.length) {
          if (!anyPosixPathUnderConfiguredRoots(allowedPaths, snapWs)) continue;
          workspace = snapWs;
        } else {
          workspace = snapWs;
        }
        const run = snapshotToGeminiPickerRun(snap, 'ssh', remote, workspace);
        if (isSubAgent(run)) continue;
        const key = run.transcript_path || `${run.session_id}::${workspace}`;
        if (!key || seenKeys.has(key)) continue;
        seenKeys.add(key);
        runs.push(run);
      }
    }
    runs.sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0));
    return runs;
  }

  const localWorkspaces = Array.isArray(opts.localWorkspaces)
    ? opts.localWorkspaces.map((p) => String(p || '').trim()).filter(Boolean)
    : [];
  const runs = [];
  const seenKeys = new Set();
  for (const snap of list) {
    if (!snap) continue;
    if (snap.remote_host) continue;
    if (localWorkspaces.length) {
      const ws = String(snap.workspace_path || '').trim();
      if (!anyLocalPathUnderConfiguredRoots(localWorkspaces, ws)) continue;
    }
    const run = snapshotToGeminiPickerRun(snap, 'local', null, '');
    if (isSubAgent(run)) continue;
    const key = run.transcript_path || run.session_id;
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    runs.push(run);
  }
  runs.sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0));
  return runs;
}

// ---- local discovery merge (in-flight generation fix) ----------------------------------------
// The gemini sibling of mergeLocalClaudeDiscoveryPickerRuns (lib/claude_picker_from_hooks.js):
// hook snapshots are in-memory only, so an agy run that started while Orchestra was down has no
// snapshot — discovered rows (discoverLocalAgyRuns, lib/gemini_discovery_from_db.js) are merged
// on EVERY local picker call, and a hook row always wins a collision.

// A gemini run's identity is its agy conversationId: hook snapshots carry it as session_id (for
// agy-app snapshots it is the ONLY identity — they have no transcript_path), and discovery reads
// it off the DB basename. The brain transcript path is derived from the same id on both sides,
// so it doubles as a secondary key, mirroring claudePickerRunKeys.
function geminiPickerRunKeys(run) {
  const keys = [];
  const transcript = typeof run?.transcript_path === 'string' ? run.transcript_path.trim() : '';
  const session = normalizeId(run?.session_id);
  if (transcript) keys.push(`t:${transcript}`);
  if (session) keys.push(`s:${session}`);
  return keys;
}

/**
 * Merge locally-discovered agy runs (discoverLocalAgyRuns output) into the LOCAL gemini picker
 * rows (snapshot-derived, post-enrichment).
 * - keeps only discovered rows the DB channel classifies as generating (done/stale history is
 *   the hook store's business — discovery exists purely to surface in-flight runs hooks missed);
 * - drops rows in the caller's sub-agent exclusion set (the same excludeSessionIds the snapshot
 *   path applies, so a child conversation a hook transcript knows about never surfaces);
 * - does NOT workspace-gate: FAIL-OPEN by locked design — the conversation DB has no cold
 *   workspace to gate on (see lib/gemini_discovery_from_db.js);
 * - stamps the fields snapshot rows carry but discovery rows lack, so the picker/client cannot
 *   tell them apart (host/projects_root null, state_location '', completion_hint false) — plus
 *   discovered:true so live tests can;
 * - dedupes by conversationId (s:) / transcript path (t:) via the shared core — hook rows win.
 */
function mergeLocalGeminiDiscoveryPickerRuns(snapshotRuns, discoveredRuns, opts = {}) {
  const excluded = new Set([...(opts.excludeSessionIds || [])].map(normalizeId).filter(Boolean));
  const candidates = [];
  for (const run of Array.isArray(discoveredRuns) ? discoveredRuns : []) {
    if (!run || typeof run !== 'object') continue;
    if (run.generating !== true) continue;
    if (excluded.size && excluded.has(normalizeId(run.session_id))) continue;
    candidates.push({
      ...run,
      source: 'local',
      host: null,
      projects_root: null,
      state_location: '',
      completion_hint: false,
      // Field parity with the snapshot picker row (snapshotToGeminiPickerRun): derive the surface
      // the same way. A discovered run carries no agy_agent_kind, but its brain transcript_path
      // encodes the surface (antigravity-cli/ vs antigravity/), so geminiSurfaceFromSnapshot falls
      // back to the path and yields the honest 'cli'|'desktop' kind.
      surface: geminiSurfaceFromSnapshot(run),
      discovered: true,
    });
  }
  const out = mergeDiscoveryPickerRuns(
    Array.isArray(snapshotRuns) ? snapshotRuns : [],
    candidates,
    { keyFor: geminiPickerRunKeys }
  );
  out.sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0));
  return out;
}

module.exports = {
  snapshotToGeminiPickerRun,
  pickerRunsFromGeminiSnapshots,
  geminiPickerRunKeys,
  mergeLocalGeminiDiscoveryPickerRuns,
};
