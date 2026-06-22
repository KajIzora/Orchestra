'use strict';

/**
 * Cursor renderer-permission watch decision.
 *
 * Cursor does not fire a hook for permission/question prompts. Instead its renderer
 * log records a "wakelock" the agent grabs while blocked on the user. The renderer
 * probe ([cursor_renderer_permission_probe.js]) turns those into `permission_requested`
 * / `permission_cleared` events. This module decides what those events do to watched
 * tasks: a `permission_requested` clears a matching waiting cursor watch as a
 * `permission` gate (needs-you); a `permission_cleared` (approved) resumes a matching
 * paused watch.
 *
 * This lived inline in server.js; it is extracted here so the signal-replay verifier
 * can drive the *real* decision (not a copy) against recorded renderer events, exactly
 * like the hook/transcript paths run through `createWatchPoller`.
 *
 * deps: { cursorHookStore, applyTaskStatusChange, nowIso }
 *   cursorHookStore      — for the resume guard (a fresh stop hint blocks resume)
 *   applyTaskStatusChange — (task, status) => void  (server + replay supply their own)
 *   nowIso                — () => ISO string
 */

const path = require('path');
const {
  normalizeWatchTracking,
  markHumanGateWatchClear,
  watchClearInfo,
  resumeWatchTracking,
  recordWatchFinished,
} = require('./watch_tracker');
const { normalizeConversationId } = require('./cursor_hook_store');

function cursorRendererEventMatchesWatch(event, wt) {
  if (!event || !wt || wt.kind !== 'cursor') return false;
  const eventConversation = normalizeConversationId(event.conversation_id || event.composer_id || '');
  if (!eventConversation) return false;
  const watchConversation = normalizeConversationId(wt.conversation_id || wt.run_id || '');
  if (watchConversation && watchConversation === eventConversation) return true;
  const transcriptBase = path.basename(wt.transcript_path || '', '.jsonl');
  return !!transcriptBase && normalizeConversationId(transcriptBase) === eventConversation;
}

function cursorConversationAlreadyPausedOnPermission(state, event) {
  for (const project of state.projects || []) {
    for (const task of project.tasks || []) {
      if (task.status !== 'todo' || !task.watch_finished?.needs_input || !task.paused_watch_tracking) {
        continue;
      }
      const pwt = normalizeWatchTracking(task.paused_watch_tracking, null);
      if (!cursorRendererEventMatchesWatch(event, pwt)) continue;
      if (pwt.clear_gate === 'permission') return true;
    }
  }
  return false;
}

function completeWatchTask(task, applyTaskStatusChange) {
  const wt = task.watch_tracking || task.cursor_tracking || null;
  applyTaskStatusChange(task, 'todo');
  task.watch_tracking = null;
  task.cursor_tracking = null;
  recordWatchFinished(task, wt);
}

/**
 * Apply renderer permission events to the app state. Returns the number of tasks changed.
 * Behaviour is identical to the original server.js closure.
 */
function applyCursorRendererPermissionEvents(state, events, deps = {}) {
  const { cursorHookStore, applyTaskStatusChange, nowIso } = deps;
  let changed = 0;
  for (const event of events || []) {
    if (!event || !event.conversation_id) continue;
    if (event.type === 'permission_requested') {
      if (event.pending_snapshot && cursorConversationAlreadyPausedOnPermission(state, event)) {
        continue;
      }
      for (const project of state.projects || []) {
        for (const task of project.tasks || []) {
          if (task.status !== 'waiting') continue;
          const wt = normalizeWatchTracking(task.watch_tracking, task.cursor_tracking);
          if (!cursorRendererEventMatchesWatch(event, wt)) continue;
          task.watch_tracking = wt;
          task.cursor_tracking = wt;
          markHumanGateWatchClear(
            wt,
            'permission',
            {
              event_name: 'cursor_renderer_permission_requested',
              updated_at: event.t_iso || nowIso(),
            },
            nowIso()
          );
          task.last_watch_clear = watchClearInfo(wt);
          completeWatchTask(task, applyTaskStatusChange);
          changed += 1;
        }
      }
    } else if (event.type === 'permission_cleared' && event.clear_reason === 'approved') {
      const clearedAtMs = Date.parse(event.t_iso || '') || 0;
      for (const project of state.projects || []) {
        for (const task of project.tasks || []) {
          if (task.status !== 'todo' || !task.watch_finished?.needs_input || !task.paused_watch_tracking) {
            continue;
          }
          const pwt = normalizeWatchTracking(task.paused_watch_tracking, null);
          if (!cursorRendererEventMatchesWatch(event, pwt)) continue;
          const pausedAtMs = Date.parse(task.watch_finished.paused_at || pwt.clear_signal_at || '') || 0;
          if (clearedAtMs && pausedAtMs && clearedAtMs < pausedAtMs) continue;
          if (cursorHookStore && cursorHookStore.getCompletionHintForTracking(pwt)) continue;
          task.paused_watch_tracking = pwt;
          resumeWatchTracking(task, pwt, applyTaskStatusChange);
          changed += 1;
        }
      }
    }
  }
  return changed;
}

module.exports = {
  applyCursorRendererPermissionEvents,
  cursorRendererEventMatchesWatch,
  cursorConversationAlreadyPausedOnPermission,
};
