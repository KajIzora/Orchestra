const { isCodexQuestionGateEvent } = require('./codex_hook_store');

function normalizeSessionId(id) {
  if (typeof id !== 'string') return '';
  return id.trim();
}

function normalizeTranscriptPath(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function snapshotHost(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return '';
  if (typeof snapshot.remote_host === 'string' && snapshot.remote_host.trim()) {
    return snapshot.remote_host.trim();
  }
  if (typeof snapshot.host === 'string' && snapshot.host.trim()) return snapshot.host.trim();
  return '';
}

function watchHost(watchTracking) {
  return typeof watchTracking?.host === 'string' ? watchTracking.host.trim() : '';
}

function codexWatchMatchesSnapshot(watchTracking, snapshot) {
  if (!watchTracking || watchTracking.kind !== 'ide_agent' || watchTracking.provider !== 'codex') {
    return false;
  }
  const targetHost = snapshotHost(snapshot);
  const currentHost = watchHost(watchTracking);
  if (targetHost && currentHost && targetHost !== currentHost) return false;

  const targetTranscript = normalizeTranscriptPath(snapshot.transcript_path);
  const targetSessionId = normalizeSessionId(snapshot.session_id);
  const watchTranscript = normalizeTranscriptPath(watchTracking.transcript_path);
  const watchSessionId = normalizeSessionId(watchTracking.session_id);
  const transcriptMatch = targetTranscript && watchTranscript && targetTranscript === watchTranscript;
  const sessionMatch = targetSessionId && watchSessionId && targetSessionId === watchSessionId;
  return !!(transcriptMatch || sessionMatch);
}

function shouldResumePausedCodexWatch(task, watchTracking, snapshot) {
  if (!task || task.status !== 'todo' || !task.watch_finished?.needs_input) return false;
  // Resume either gate kind: a permission gate or a question (request_user_input) gate. The OFF edge
  // for a question is the PostToolUse landing (generating=true), the same resume signal as permission.
  if (!watchTracking || (watchTracking.clear_gate !== 'permission' && watchTracking.clear_gate !== 'question')) return false;
  if (!snapshot || snapshot.completion_hint || snapshot.generating !== true) return false;
  if (!codexWatchMatchesSnapshot(watchTracking, snapshot)) return false;

  const pausedAtMs = Date.parse(task.watch_finished.paused_at || watchTracking.clear_signal_at || '') || 0;
  const snapMs = Date.parse(snapshot.updated_at || '') || 0;
  return !!snapMs && (!pausedAtMs || snapMs > pausedAtMs);
}

/**
 * Clear waiting Codex ide_agent watches when a hook snapshot has completion_hint
 * (Stop or PermissionRequest).
 * Mirrors getCompletionHintForTracking matching rules (session/transcript, linked_at, host).
 */
function applyCodexHookCompletion(getState, onEachTask, snapshot, options = {}) {
  if (!snapshot) return 0;
  const snapMs = Date.parse(snapshot.updated_at || '') || 0;
  let completedCount = 0;
  for (const project of getState().projects || []) {
    for (const task of project.tasks || []) {
      if (task.status === 'todo' && task.watch_finished?.needs_input && task.paused_watch_tracking) {
        const wt = task.paused_watch_tracking;
        if (shouldResumePausedCodexWatch(task, wt, snapshot)) {
          if (typeof options.resumeTask === 'function') {
            options.resumeTask(task, wt);
            completedCount += 1;
          }
          continue;
        }
      }
      if (!snapshot.completion_hint) continue;
      if (task.status !== 'waiting') continue;
      const wt = task.watch_tracking;
      if (!wt) continue;
      const linkedAtMs = Date.parse(wt.linked_at || '') || 0;
      if (linkedAtMs && snapMs && snapMs <= linkedAtMs) continue;
      if (!codexWatchMatchesSnapshot(wt, snapshot)) continue;
      // PermissionRequest = stopped on a permission gate; a request_user_input PreToolUse = stopped on
      // a question gate; Stop = finished. Tag the watcher so it flips to "needs input" (with the gate
      // kind) vs "done". (The event_name guard in isCodexQuestionGateEvent keeps a later Stop — which
      // carries the request_user_input tool_name forward on the row — from being mistaken for a gate.)
      if (snapshot.event_name === 'PermissionRequest') {
        wt.clear_gate = 'permission';
        wt.clear_reason = 'permission_pending';
      } else if (isCodexQuestionGateEvent(snapshot.event_name, snapshot.tool_name)) {
        wt.clear_gate = 'question';
        wt.clear_reason = 'question_pending';
      }
      onEachTask(task);
      completedCount += 1;
    }
  }
  return completedCount;
}

function applyCodexHookResume(getState, onResumeTask, snapshot) {
  if (!snapshot || !snapshot.generating) return 0;
  let resumedCount = 0;
  for (const project of getState().projects || []) {
    for (const task of project.tasks || []) {
      if (task.status === 'waiting') continue;
      const wt = task.completed_watch_tracking;
      if (!wt || wt.kind !== 'ide_agent' || wt.provider !== 'codex') continue;
      if (!codexWatchMatchesSnapshot(wt, snapshot)) continue;
      onResumeTask(task, wt);
      resumedCount += 1;
    }
  }
  return resumedCount;
}

module.exports = {
  applyCodexHookCompletion,
  shouldResumePausedCodexWatch,
  applyCodexHookResume,
  codexWatchMatchesSnapshot,
};
