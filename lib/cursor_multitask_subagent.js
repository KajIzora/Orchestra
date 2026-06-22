const fs = require('fs');
const path = require('path');
const { findLocalTranscriptPathByRunId } = require('./cursor_tracker');
const { normalizeConversationId } = require('./cursor_hook_store');

// Quiet window after the last subagent transcript write before treating children as done.
const DEFAULT_QUIESCENCE_MS = 8_000;

function composerModeIsMultitask(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === 'multitask';
}

function subagentDirFromParentTranscript(parentTranscriptPath) {
  if (typeof parentTranscriptPath !== 'string' || !parentTranscriptPath.trim()) return '';
  return path.join(path.dirname(path.resolve(parentTranscriptPath.trim())), 'subagents');
}

function listSubagentTranscriptPaths(parentTranscriptPath) {
  const dir = subagentDirFromParentTranscript(parentTranscriptPath);
  if (!dir || !fs.existsSync(dir)) return [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => path.join(dir, name))
    .sort();
}

function linkedAtMsFromTracking(cursorTracking) {
  return Date.parse(cursorTracking?.linked_at || '') || 0;
}

function multitaskSubagentBaselinePaths(cursorTracking) {
  return Array.isArray(cursorTracking?.multitask_subagent_baseline_paths)
    ? cursorTracking.multitask_subagent_baseline_paths
    : [];
}

function normalizeGenerationId(id) {
  return normalizeConversationId(id);
}

/**
 * Snapshot existing subagent transcript files so prior turns / rewinds do not
 * satisfy completion while this watch is active.
 */
function seedMultitaskSubagentBaseline(cursorTracking, parentTranscriptPath) {
  const paths = listSubagentTranscriptPaths(parentTranscriptPath);
  cursorTracking.multitask_subagent_baseline_paths = paths;
  cursorTracking.multitask_subagent_known_paths = [];
  cursorTracking.multitask_subagent_last_spawn_ms = 0;
  return paths;
}

function maybeRefreshMultitaskSubagentBaselineForGeneration(cursorTracking, hookMeta, parentTranscriptPath) {
  const nextGen = normalizeGenerationId(hookMeta?.generation_id);
  if (!nextGen || !parentTranscriptPath) return false;
  const prevGen = normalizeGenerationId(cursorTracking?.multitask_subagent_generation_id);
  if (!prevGen) {
    cursorTracking.multitask_subagent_generation_id = nextGen;
    return false;
  }
  if (prevGen === nextGen) return false;
  cursorTracking.multitask_subagent_generation_id = nextGen;
  seedMultitaskSubagentBaseline(cursorTracking, parentTranscriptPath);
  return true;
}

/**
 * Subagent transcripts that belong to the current watch turn only.
 */
function listSubagentTranscriptPathsForWatch(cursorTracking, parentTranscriptPath) {
  const baseline = new Set(multitaskSubagentBaselinePaths(cursorTracking));
  const linkedAtMs = linkedAtMsFromTracking(cursorTracking);
  return listSubagentTranscriptPaths(parentTranscriptPath).filter((subagentPath) => {
    if (baseline.has(subagentPath)) return false;
    if (linkedAtMs > 0) {
      const st = statFileSync(subagentPath);
      if (st.ok && st.mtimeMs > 0 && st.mtimeMs < linkedAtMs) return false;
    }
    return true;
  });
}

/** Call when linking a cursor watch so stale subagent files are ignored. */
function initializeMultitaskSubagentWatchOnLink(cursorTracking, hookMeta = null) {
  if (!cursorTracking || cursorTracking.kind !== 'cursor' || cursorTracking.source === 'ssh') return false;
  if (!isMultitaskBackupEligible(cursorTracking, hookMeta)) return false;
  const parentPath = resolveParentTranscriptPathForMultitask(cursorTracking, {
    conversationSnap: hookMeta,
  });
  if (!parentPath) return false;
  seedMultitaskSubagentBaseline(cursorTracking, parentPath);
  const genId = normalizeGenerationId(hookMeta?.generation_id);
  if (genId) cursorTracking.multitask_subagent_generation_id = genId;
  if (hookMeta?.composer_mode) cursorTracking.composer_mode = hookMeta.composer_mode;
  return true;
}

function statFileSync(filePath) {
  try {
    const st = fs.statSync(filePath);
    return { path: filePath, mtimeMs: st.mtimeMs, size: st.size, ok: true };
  } catch {
    return { path: filePath, mtimeMs: 0, size: 0, ok: false };
  }
}

/**
 * Track when new subagent transcript files appear so sequential spawns do not clear early.
 * Mutates cursorTracking multitask_subagent_* fields.
 */
function syncMultitaskSubagentSpawnTracking(cursorTracking, subagentPaths, nowMs = Date.now()) {
  const known = new Set(
    Array.isArray(cursorTracking.multitask_subagent_known_paths)
      ? cursorTracking.multitask_subagent_known_paths
      : []
  );
  let lastSpawnMs = Number(cursorTracking.multitask_subagent_last_spawn_ms) || 0;
  for (const subagentPath of subagentPaths) {
    if (!known.has(subagentPath)) {
      known.add(subagentPath);
      const st = statFileSync(subagentPath);
      const spawnMs = st.ok && st.mtimeMs > 0 && st.mtimeMs <= nowMs ? st.mtimeMs : nowMs;
      lastSpawnMs = Math.max(lastSpawnMs, spawnMs);
    }
  }
  cursorTracking.multitask_subagent_known_paths = subagentPaths.filter((p) => known.has(p));
  cursorTracking.multitask_subagent_last_spawn_ms = lastSpawnMs;
  return lastSpawnMs;
}

/**
 * Pure completion check from filesystem/hook metadata (testable).
 *
 * @param {object} input
 * @param {number} input.parentMtimeMs
 * @param {{ mtimeMs: number, ok?: boolean }[]} input.subagentStats
 * @param {number} input.lastNewSubagentAtMs
 * @param {number} [input.nowMs]
 * @param {number} [input.quiescenceMs]
 */
function evaluateCursorMultitaskSubagentCompletion(input = {}) {
  const {
    parentMtimeMs = 0,
    subagentStats = [],
    lastNewSubagentAtMs = 0,
    nowMs = Date.now(),
    quiescenceMs = DEFAULT_QUIESCENCE_MS,
  } = input;

  if (!subagentStats.length || !subagentStats.every((row) => row && row.ok !== false)) return false;
  if (nowMs - lastNewSubagentAtMs < quiescenceMs) return false;
  if (nowMs - parentMtimeMs < quiescenceMs) return false;

  let maxSubagentMtimeMs = 0;
  for (const row of subagentStats) {
    const mtimeMs = Number(row.mtimeMs) || 0;
    if (nowMs - mtimeMs < quiescenceMs) return false;
    maxSubagentMtimeMs = Math.max(maxSubagentMtimeMs, mtimeMs);
  }

  return parentMtimeMs > maxSubagentMtimeMs;
}

/**
 * True when no non-terminal parent hook activity for the watched generation within quiescence.
 */
function isScopedNonTerminalHookQuiet(cursorTracking, hookMeta, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const quiescenceMs = options.quiescenceMs ?? DEFAULT_QUIESCENCE_MS;
  if (hookMeta?.generating === true) return false;

  const watchGen = normalizeGenerationId(cursorTracking?.multitask_subagent_generation_id);
  const lastGen = normalizeGenerationId(hookMeta?.last_non_terminal_generation_id);
  const lastAt = Date.parse(hookMeta?.last_non_terminal_hook_at || '') || 0;
  if (!lastAt) return true;
  if (watchGen && lastGen && watchGen !== lastGen) return true;
  return nowMs - lastAt >= quiescenceMs;
}

function hookMetaForMultitask(cursorTracking, hookMeta) {
  if (hookMeta && typeof hookMeta === 'object') return hookMeta;
  return {
    composer_mode: cursorTracking?.composer_mode || '',
    subagent_spawn_count: cursorTracking?.subagent_spawn_count || 0,
    generation_id: cursorTracking?.multitask_subagent_generation_id || '',
  };
}

function isMultitaskBackupEligible(cursorTracking, hookMeta) {
  const meta = hookMetaForMultitask(cursorTracking, hookMeta);
  const mode = meta.composer_mode || cursorTracking?.composer_mode || '';
  return composerModeIsMultitask(mode);
}

/**
 * Resolve the parent transcript path for multitask checks (watch row may only have conversation_id).
 */
function resolveParentTranscriptPathForMultitask(cursorTracking, sources = {}) {
  const completionHint = sources.completionHint || null;
  const conversationSnap = sources.conversationSnap || sources.hookMeta || null;
  const fromTracking =
    typeof cursorTracking?.transcript_path === 'string' ? cursorTracking.transcript_path.trim() : '';
  if (fromTracking) return fromTracking;
  const fromHint =
    typeof completionHint?.transcript_path === 'string' ? completionHint.transcript_path.trim() : '';
  if (fromHint) return fromHint;
  const fromSnap =
    typeof conversationSnap?.transcript_path === 'string' ? conversationSnap.transcript_path.trim() : '';
  if (fromSnap) return fromSnap;
  const runId = normalizeConversationId(
    cursorTracking?.conversation_id ||
      cursorTracking?.run_id ||
      completionHint?.conversation_id ||
      conversationSnap?.conversation_id ||
      ''
  );
  if (!runId || cursorTracking?.source === 'ssh') return '';
  return findLocalTranscriptPathByRunId(runId) || '';
}

/**
 * True when this watch should use subagent transcript completion instead of a bare stop hook.
 * Applies only in multitask composer mode once Cursor spawns subagents.
 */
function isCursorMultitaskSubagentWatchActive(cursorTracking, hookMeta, sources = {}) {
  if (!cursorTracking || cursorTracking.kind !== 'cursor') return false;
  if (cursorTracking.source === 'ssh') return false;
  if (!isMultitaskBackupEligible(cursorTracking, hookMeta)) return false;

  if (cursorTracking.cursor_multitask_subagent === true) return true;

  const meta = hookMetaForMultitask(cursorTracking, hookMeta);
  if ((meta.subagent_spawn_count || 0) > 0) return true;

  const parentPath = resolveParentTranscriptPathForMultitask(cursorTracking, sources);
  return listSubagentTranscriptPathsForWatch(cursorTracking, parentPath).length > 0;
}

function activateCursorMultitaskSubagentWatch(cursorTracking, hookMeta, sources = {}) {
  if (!isCursorMultitaskSubagentWatchActive(cursorTracking, hookMeta, sources)) return false;
  cursorTracking.cursor_multitask_subagent = true;
  const meta = hookMetaForMultitask(cursorTracking, hookMeta);
  if (meta.composer_mode) cursorTracking.composer_mode = meta.composer_mode;
  if (meta.subagent_spawn_count) {
    cursorTracking.subagent_spawn_count = Math.max(
      Number(cursorTracking.subagent_spawn_count) || 0,
      Number(meta.subagent_spawn_count) || 0
    );
  }
  const parentPath = resolveParentTranscriptPathForMultitask(cursorTracking, sources);
  if (parentPath && !cursorTracking.transcript_path) {
    cursorTracking.transcript_path = parentPath;
  }
  return true;
}

/**
 * Called on subagentStart so the filesystem backup is armed before an early parent stop.
 */
function touchCursorSubagentWatchOnSpawn(cursorTracking, hookMeta, sources = {}) {
  return activateCursorMultitaskSubagentWatch(cursorTracking, hookMeta, sources);
}

/**
 * Suppress an early parent stop hook while background subagents are still outstanding.
 */
function shouldDeferCursorHookCompletionForMultitask(cursorTracking, completionHint, conversationSnap) {
  if (!completionHint?.completion_hint) return false;
  if (
    completionHint.completion_status === 'aborted' ||
    completionHint.completion_status === 'cancelled'
  ) {
    return false;
  }
  return isCursorMultitaskSubagentWatchActive(cursorTracking, conversationSnap || completionHint, {
    completionHint,
    conversationSnap,
  });
}

/**
 * Whether a stop/sessionEnd hook should clear the watch immediately (hook POST path).
 */
function shouldApplyCursorHookCompletionNow(cursorTracking, snapshot, conversationSnap) {
  if (!snapshot?.completion_hint) return false;
  if (shouldDeferCursorHookCompletionForMultitask(cursorTracking, snapshot, conversationSnap)) {
    const parentPath = resolveParentTranscriptPathForMultitask(cursorTracking, {
      completionHint: snapshot,
      conversationSnap,
    });
    if (parentPath && !cursorTracking.transcript_path) {
      cursorTracking.transcript_path = parentPath;
    }
    activateCursorMultitaskSubagentWatch(cursorTracking, conversationSnap || snapshot);
    return false;
  }
  return true;
}

/**
 * Filesystem poller: clear when all subagent transcripts are quiet, no fresh spawn,
 * and the parent transcript was updated after the last subagent write.
 */
function cursorMultitaskSubagentWatchShouldClear(cursorTracking, hookMeta, options = {}) {
  if (!activateCursorMultitaskSubagentWatch(cursorTracking, hookMeta)) return false;

  const parentPath = resolveParentTranscriptPathForMultitask(cursorTracking, {
    conversationSnap: hookMeta,
  });
  if (!parentPath) return false;
  if (!cursorTracking.transcript_path) cursorTracking.transcript_path = parentPath;

  maybeRefreshMultitaskSubagentBaselineForGeneration(cursorTracking, hookMeta, parentPath);

  const parentStat = statFileSync(parentPath);
  if (!parentStat.ok) return false;

  const subagentPaths = listSubagentTranscriptPathsForWatch(cursorTracking, parentPath);
  if (!subagentPaths.length) return false;

  const nowMs = options.nowMs ?? Date.now();
  const quiescenceMs = options.quiescenceMs ?? DEFAULT_QUIESCENCE_MS;
  const lastNewSubagentAtMs = syncMultitaskSubagentSpawnTracking(cursorTracking, subagentPaths, nowMs);
  const subagentStats = subagentPaths.map((subagentPath) => statFileSync(subagentPath));

  if (
    !evaluateCursorMultitaskSubagentCompletion({
      parentMtimeMs: parentStat.mtimeMs,
      subagentStats,
      lastNewSubagentAtMs,
      nowMs,
      quiescenceMs,
    })
  ) {
    return false;
  }

  return isScopedNonTerminalHookQuiet(cursorTracking, hookMeta, { nowMs, quiescenceMs });
}

module.exports = {
  DEFAULT_QUIESCENCE_MS,
  composerModeIsMultitask,
  isMultitaskBackupEligible,
  subagentDirFromParentTranscript,
  listSubagentTranscriptPaths,
  listSubagentTranscriptPathsForWatch,
  linkedAtMsFromTracking,
  seedMultitaskSubagentBaseline,
  maybeRefreshMultitaskSubagentBaselineForGeneration,
  initializeMultitaskSubagentWatchOnLink,
  syncMultitaskSubagentSpawnTracking,
  evaluateCursorMultitaskSubagentCompletion,
  isScopedNonTerminalHookQuiet,
  isCursorMultitaskSubagentWatchActive,
  activateCursorMultitaskSubagentWatch,
  touchCursorSubagentWatchOnSpawn,
  shouldDeferCursorHookCompletionForMultitask,
  shouldApplyCursorHookCompletionNow,
  resolveParentTranscriptPathForMultitask,
  cursorMultitaskSubagentWatchShouldClear,
};
