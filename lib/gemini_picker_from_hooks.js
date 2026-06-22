const { applyActiveGenerationStaleCutoff, toIso } = require('./active_generation');
const {
  anyLocalPathUnderConfiguredRoots,
  anyPosixPathUnderConfiguredRoots,
} = require('./workspace_scope');

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

module.exports = {
  snapshotToGeminiPickerRun,
  pickerRunsFromGeminiSnapshots,
};
