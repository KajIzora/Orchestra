const { applyActiveGenerationStaleCutoff, toIso } = require('./active_generation');
const { isClaudePermissionAttentionReason } = require('./claude_tracker');
const {
  anyLocalPathUnderConfiguredRoots,
  anyPosixPathUnderConfiguredRoots,
} = require('./workspace_scope');

/**
 * Convert a Claude hook-store snapshot into a picker row.
 * Mirrors the shape produced by the old discovery+enrichment pipeline.
 */
function snapshotToClaudePickerRun(snap, source, remote, workspace) {
  const updatedMs = Date.parse(snap.updated_at || '') || 0;
  const isPermission = isClaudePermissionAttentionReason(snap.attention_reason);
  const hookGenerating = isPermission
    ? true
    : !!snap.generating && !snap.completion_hint;
  const completionHint = isPermission ? false : !!snap.completion_hint;
  const activeGen = applyActiveGenerationStaleCutoff(
    {
      generating: hookGenerating,
      start_signal_at: toIso(updatedMs),
      last_activity_at: toIso(updatedMs),
      inactive_reason: hookGenerating ? '' : (snap.attention_reason || 'completion_signal'),
    },
    { mtimeMs: updatedMs }
  );
  return {
    kind: 'ide_agent',
    provider: 'claude',
    source: source === 'ssh' ? 'ssh' : 'local',
    session_id: snap.session_id || '',
    transcript_path: snap.transcript_path || '',
    title: snap.title || '',
    workspace_path: snap.workspace_path || workspace || '',
    updated_at: snap.updated_at || '',
    mtime_ms: updatedMs,
    last_user_preview: snap.last_user_preview || snap.session_id || '',
    host: remote ? remote.host : null,
    projects_root: remote ? remote.projects_root : null,
    state_location: source === 'ssh' ? 'remote' : '',
    completion_hint: completionHint,
    attention_reason: snap.attention_reason || '',
    ...activeGen,
  };
}

/**
 * Build picker rows from Claude hook snapshots.
 * @param {object[]} snapshots - claudeHookStore.listSnapshots() output
 * @param {object}   opts
 * @param {'local'|'ssh'} opts.source
 * @param {string[]} [opts.localWorkspaces] - if non-empty, only snapshots whose
 *                    workspace_path matches one of these are kept (local mode).
 * @param {Array<{host:string, projects_root?:string, workspaces?:string[]}>} [opts.remotes]
 *                    Resolved remote configs; required for ssh mode.
 *                    workspaces[] (optional) restricts to those paths.
 */
function pickerRunsFromClaudeSnapshots(snapshots, opts = {}) {
  const list = Array.isArray(snapshots) ? snapshots : [];
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
        const run = snapshotToClaudePickerRun(snap, 'ssh', remote, workspace);
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
    const run = snapshotToClaudePickerRun(snap, 'local', null, '');
    const key = run.transcript_path || run.session_id;
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    runs.push(run);
  }
  runs.sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0));
  return runs;
}

// ---- ssh discovery fallback -----------------------------------------------------------------
// Hook snapshots are the primary ssh picker source, but they only exist when the remote hooks
// reached Orchestra — with the reverse tunnel down at prompt time, the run's UserPromptSubmit
// never arrives and the run would NEVER appear in the picker (arm-never-appears). These helpers
// let the server fall back to ssh transcript discovery (discoverRemoteClaudeRuns) for exactly the
// hosts that produced no snapshot-derived rows, and merge the discovered rows in without
// duplicating anything a snapshot already covers.

function claudePickerRunKeys(run) {
  const keys = [];
  const transcript = normalizeClaudePickerTranscriptPath(run?.transcript_path);
  const session = normalizeClaudePickerSessionId(run?.session_id);
  if (transcript) keys.push(`t:${transcript}`);
  if (session) keys.push(`s:${session}`);
  return keys;
}

function normalizeClaudePickerSessionId(id) {
  if (typeof id !== 'string') return '';
  return id.trim();
}

function normalizeClaudePickerTranscriptPath(p) {
  if (typeof p !== 'string') return '';
  return p.trim();
}

/** Remotes with ZERO snapshot-derived picker rows — the hosts that need discovery fallback. */
function remoteHostsNeedingClaudeDiscovery(runs, remotes) {
  const hostsWithRows = new Set();
  for (const run of Array.isArray(runs) ? runs : []) {
    const host = run && typeof run.host === 'string' ? run.host.trim() : '';
    if (host) hostsWithRows.add(host);
  }
  return (Array.isArray(remotes) ? remotes : []).filter(
    (remote) => remote && remote.host && !hostsWithRows.has(remote.host)
  );
}

/**
 * Merge discovery rows (discoverRemoteClaudeRuns output) into snapshot-derived picker rows.
 * - dedupes by transcript path first, session id second (a snapshot row always wins);
 * - applies the same workspace gating the snapshot path uses (remote.workspaces);
 * - stamps the remote identity fields downstream host-gating relies on: host / projects_root
 *   (client row filtering + watch link), remote_host (watch-link body fallback), and
 *   state_location:'remote' (parity with snapshot rows).
 */
function mergeClaudeDiscoveryPickerRuns(snapshotRuns, discoveredRuns, remote) {
  const out = Array.isArray(snapshotRuns) ? [...snapshotRuns] : [];
  const remoteHost = remote && typeof remote.host === 'string' ? remote.host.trim() : '';
  const seen = new Set();
  for (const run of out) {
    // Dedupe within the host being merged: the same transcript path (same username/layout) can
    // legitimately exist on two different remote hosts.
    const runHost = run && typeof run.host === 'string' ? run.host.trim() : '';
    if (remoteHost && runHost && runHost !== remoteHost) continue;
    for (const key of claudePickerRunKeys(run)) seen.add(key);
  }
  const allowedPaths = Array.isArray(remote?.workspaces)
    ? remote.workspaces.map((p) => String(p || '').trim()).filter(Boolean)
    : [];
  for (const run of Array.isArray(discoveredRuns) ? discoveredRuns : []) {
    if (!run || typeof run !== 'object') continue;
    const keys = claudePickerRunKeys(run);
    if (!keys.length || keys.some((key) => seen.has(key))) continue;
    if (allowedPaths.length) {
      const ws = String(run.workspace_path || '').trim();
      if (!anyPosixPathUnderConfiguredRoots(allowedPaths, ws)) continue;
    }
    const host = (remote && remote.host) || run.host || null;
    for (const key of keys) seen.add(key);
    out.push({
      ...run,
      source: 'ssh',
      host,
      projects_root: (remote && remote.projects_root) || run.projects_root || null,
      remote_host: host || '',
      state_location: 'remote',
    });
  }
  out.sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0));
  return out;
}

module.exports = {
  snapshotToClaudePickerRun,
  pickerRunsFromClaudeSnapshots,
  remoteHostsNeedingClaudeDiscovery,
  mergeClaudeDiscoveryPickerRuns,
};
