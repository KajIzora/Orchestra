const crypto = require('crypto');
const { truncateCleanHumanPromptPreview } = require('./human_prompt_preview');
const { isUserRequestInterruptedPreview } = require('./request_interrupted_preview');
// Shared with the capture-side done_detection state machine (predicate parity): a Stop whose
// session_crons carry a near-future ONE-SHOT wakeup cron (ScheduleWakeup) holds "working" until
// max(fire, stop) + grace instead of the crons-only debounce, and the busy-hold window is TIERED
// by the session's TodoWrite state (todoStateFromTodos/resolveBusyHoldMs). done_detection has no
// requires, so this import cannot cycle.
const {
  cronWakeupHoldDeadlineMs,
  todoStateFromTodos,
  resolveBusyHoldMs,
  isTaskNotification,
  DEFAULT_TODO_DONE_HOLD_MS,
  DEFAULT_NO_TODO_HOLD_MS,
} = require('./done_detection');

const VALID_EVENTS = new Set([
  'UserPromptSubmit',
  'SessionStart',
  'Stop',
  'PermissionRequest',
  'Notification',
  // PostToolUse is tracked purely as an ACTIVITY ping: it's never a completion or a permission event
  // (shouldSetCompletionHint / isPermissionCompletionEvent both return false for it), so ingest only
  // advances updated_at and carries existing completion/generating state forward. That gives the
  // paused-watch resume a gate-precise re-arm — the gated tool's PostToolUse fires when the permission
  // is answered — without it ever clearing a gate or faking a done. See shouldResumeIdeAgentWatch.
  'PostToolUse',
  // PreToolUse / MessageDisplay / PostToolUseFailure are the Phase-2b LIVE-FEED profile adds
  // (lib/signal_registry.js claude hookCatalog.captured). Their real payloads are consumed off the
  // raw hook_event_log tap by lib/live_turn_normalizer.js (tool_start / note / tool_end ok:false);
  // in THIS store they are pure activity pings exactly like PostToolUse — shouldSetCompletionHint,
  // isPermissionCompletionEvent, and attentionReasonFromEvent all return falsy for them, so ingest
  // only advances updated_at and carries completion/generating/gate state forward (never a fake done
  // or gate). Accepting them here keeps the hook POST response ok:true so the store's activity ping
  // (and thus the needs-input resume) keeps flowing; without it the POST 400s (harmless to the feed,
  // which taps pre-store, but it drops the activity ping).
  'PreToolUse',
  'MessageDisplay',
  'PostToolUseFailure',
]);
const SNAPSHOT_TTL_MS = 60 * 60 * 1000;
// A "busy" Stop (running background tasks or pending scheduled crons) is held this long
// before flipping the watch to done. If a resume (any UserPromptSubmit — a
// <task-notification>, a cron-fired prompt, or a human message) arrives within the window
// the pending completion is cancelled and the watch stays tracking (no flicker). If it
// arrives after, "done" was already shown and tracking re-arms = a (tolerated) flicker.
// Idle Stops and needs-input gates ignore the debounce and clear immediately.
const DEFAULT_STOP_DEBOUNCE_MS = 15_000;
// Bounded busy-hold for a Stop that leaves claude-managed background tasks (shells) RUNNING.
// Claude re-invokes the session when such a task finishes, so the agent usually is not really
// done — the task-exit notification is the real completion signal, and the hold exists to keep
// the watch "working" until it arrives. The cap is NOT the clearing mechanism: it is the CRASH /
// ETERNAL-TASK BACKSTOP for the cases where that notification will never come (a dev server that
// never exits, or claude quitting/crashing mid-task — neither surface delivers a bail-out signal
// Orchestra ingests). 30 minutes covers effectively all finite background work (waiter gaps
// observed 50s–96s and 214s/232s; multi-minute builds/tests hold correctly with zero flicker),
// while bounding the stuck-"working" damage of the no-signal cases. Raised from 120s on
// 2026-07-06 (maintainer decision: long finite tools are the common case, eternal servers the
// rare one). Tunable via CLAUDE_BACKGROUND_TASK_HOLD_MS (server.js). Resolution telemetry
// (resumed-vs-cap-expired) is emitted via options.onBusyHoldEvent so the prior can be re-checked
// against production data.
// Running SUB-AGENTS are a different case: they hold indefinitely (completion_subagent_pending) —
// their true final Stop always reports them gone. Crons-only busy Stops keep the short debounce
// (a scheduled future wake-up is not running work) — EXCEPT a near-future ONE-SHOT wakeup cron
// (ScheduleWakeup), which holds until fire + grace via cronWakeupHoldDeadlineMs (2026-07-06
// wakeup-hybrid decision, mirroring codex's heartbeat hold; see done_detection.js).
//
// TIERED since 2026-07-07 by the session's TodoWrite state (the agent's stated remaining work —
// see the rationale + backtest in done_detection.js): unfinished todos keep this full backstop;
// a completed list holds DEFAULT_TODO_DONE_HOLD_MS; no list holds DEFAULT_NO_TODO_HOLD_MS.
// Tunable via CLAUDE_TODO_DONE_HOLD_MS / CLAUDE_NO_TODO_HOLD_MS (server.js).
const DEFAULT_BACKGROUND_TASK_HOLD_MS = 1_800_000;

function normalizeSessionId(id) {
  if (typeof id !== 'string') return '';
  return id.trim();
}

function normalizeTranscriptPath(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizePromptPreview(input) {
  return truncateCleanHumanPromptPreview(input, 10);
}

/** Canonical hook event name from Claude Code JSON (mixed key/casing styles). */
function normalizeEventName(body) {
  const raw =
    (typeof body.event_name === 'string' && body.event_name.trim()) ||
    (typeof body.hook_event_name === 'string' && body.hook_event_name.trim()) ||
    (typeof body.hookEventName === 'string' && body.hookEventName.trim()) ||
    '';
  if (!raw) return '';
  if (raw.includes('_')) {
    return raw
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join('');
  }
  if (raw[0] === raw[0].toLowerCase()) {
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }
  return raw;
}

function notificationType(body) {
  const t =
    (typeof body.notification_type === 'string' && body.notification_type.trim()) ||
    (typeof body.notificationType === 'string' && body.notificationType.trim()) ||
    '';
  return t.toLowerCase();
}

function isPermissionPromptNotification(body) {
  return notificationType(body) === 'permission_prompt';
}

function isPermissionCompletionEvent(eventName, body) {
  if (eventName === 'PermissionRequest') return true;
  if (eventName === 'Notification') return isPermissionPromptNotification(body);
  return false;
}

// The attention_reason values a permission/question gate hint carries (set by attentionReasonFromEvent).
function isPermissionAttentionReason(reason) {
  return reason === 'permission_request' || reason === 'permission_prompt';
}

function pendingSessionCrons(body) {
  return Array.isArray(body?.session_crons) ? body.session_crons.filter(Boolean) : [];
}

function hasPendingSessionCrons(body) {
  return pendingSessionCrons(body).length > 0;
}

function runningBackgroundTasks(body) {
  if (!Array.isArray(body?.background_tasks)) return [];
  return body.background_tasks.filter((t) => t && String(t.status || '').toLowerCase() === 'running');
}

// A backgrounded Task/Agent shows up in the Stop body's background_tasks as {type:'subagent',
// status:'running'}. This is the RELIABLE cascade signal — unlike the SubagentStart/SubagentStop
// hooks, which fire asymmetrically (orphan Stops with no matching Start, Stop counts often 2x
// Start counts), so counting them can't tell when the cascade is truly quiet. The Stop body is
// authoritative: the true final Stop always reports no running sub-agent.
function isSubagentTask(task) {
  return !!task && String(task.type || '').toLowerCase() === 'subagent';
}

function runningSubagentTasks(body) {
  return runningBackgroundTasks(body).filter(isSubagentTask);
}

function stopHasRunningSubagent(body) {
  return runningSubagentTasks(body).length > 0;
}

// Running claude-managed tasks that are NOT sub-agents (background shells): these get the BOUNDED
// busy-hold (DEFAULT_BACKGROUND_TASK_HOLD_MS), unlike sub-agents (indefinite hold) and unlike
// crons-only busy Stops (short debounce).
function stopHasRunningShellTask(body) {
  return runningBackgroundTasks(body).some((t) => !isSubagentTask(t));
}

function normalizeBackgroundTask(task) {
  return {
    id: typeof task.id === 'string' ? task.id : '',
    type: typeof task.type === 'string' ? task.type : '',
    status: typeof task.status === 'string' ? task.status : '',
    description: typeof task.description === 'string' ? task.description : '',
    command: typeof task.command === 'string' ? task.command : '',
  };
}

function normalizeSessionCron(cron) {
  return {
    id: typeof cron.id === 'string' ? cron.id : '',
    schedule: typeof cron.schedule === 'string' ? cron.schedule : '',
    recurring: typeof cron.recurring === 'boolean' ? cron.recurring : null,
    prompt: typeof cron.prompt === 'string' ? cron.prompt : '',
  };
}

/**
 * A Stop is "idle" (clears to done immediately) only when nothing could resume the agent:
 * no running background tasks and no pending scheduled crons. Otherwise it is "busy" and the
 * completion is held for the debounce window before flipping to done.
 */
function stopIsIdle(body) {
  return runningBackgroundTasks(body).length === 0 && !hasPendingSessionCrons(body);
}

function completionHintFromStop(body) {
  const stopReason = typeof body.stop_reason === 'string' ? body.stop_reason.trim().toLowerCase() : '';
  const finalStatus = typeof body.final_status === 'string' ? body.final_status.trim().toLowerCase() : '';
  if (!stopReason && !finalStatus) return true;
  if (finalStatus && finalStatus !== 'completed') return false;
  return stopReason !== 'error' && stopReason !== 'cancelled';
}

function shouldSetCompletionHint(eventName, body, completeOnPermission) {
  if (eventName === 'Stop') return completionHintFromStop(body);
  if (eventName === 'PermissionRequest') return !!completeOnPermission;
  if (eventName === 'Notification') return !!completeOnPermission && isPermissionPromptNotification(body);
  return false;
}

function attentionReasonFromEvent(eventName, body) {
  if (eventName === 'Stop') return 'stop';
  if (eventName === 'PermissionRequest') return 'permission_request';
  if (eventName === 'Notification' && isPermissionPromptNotification(body)) return 'permission_prompt';
  return '';
}

function readCompleteOnPermissionFromEnv() {
  const v = String(process.env.CLAUDE_HOOK_COMPLETE_ON_PERMISSION || '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no') return false;
  return true;
}

function createClaudeHookStore(options = {}) {
  const token = options.token || crypto.randomBytes(24).toString('hex');
  const ttlMs = Number.isInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : SNAPSHOT_TTL_MS;
  const completeOnPermission =
    typeof options.completeOnPermission === 'boolean'
      ? options.completeOnPermission
      : readCompleteOnPermissionFromEnv();
  // Retained for caller compatibility, but crons no longer block completion — a Stop with
  // pending crons is "busy" and clears to done after the debounce (crons are surfaced as
  // backend state for a future "scheduled" view).
  const requireEmptySessionCronsForStop = !!options.requireEmptySessionCronsForStop;
  void requireEmptySessionCronsForStop;
  const stopDebounceMs =
    Number.isInteger(options.stopDebounceMs) && options.stopDebounceMs >= 0
      ? options.stopDebounceMs
      : DEFAULT_STOP_DEBOUNCE_MS;
  const backgroundTaskHoldMs =
    Number.isInteger(options.backgroundTaskHoldMs) && options.backgroundTaskHoldMs >= 0
      ? options.backgroundTaskHoldMs
      : DEFAULT_BACKGROUND_TASK_HOLD_MS;
  const todoDoneHoldMs =
    Number.isInteger(options.todoDoneHoldMs) && options.todoDoneHoldMs >= 0
      ? options.todoDoneHoldMs
      : DEFAULT_TODO_DONE_HOLD_MS;
  const noTodoHoldMs =
    Number.isInteger(options.noTodoHoldMs) && options.noTodoHoldMs >= 0
      ? options.noTodoHoldMs
      : DEFAULT_NO_TODO_HOLD_MS;
  // One-shot wakeup-cron hold overrides (tests); defaults live in done_detection so the
  // production store and the capture-side machine share one implementation. cronFireResolver
  // lets signal_replay supply recording-stamped fire times (claude_cron_fires) instead of
  // wall-clock cron parsing, which is meaningless on the replay's virtual clock.
  const cronWakeupOpts = {
    horizonMs:
      Number.isInteger(options.cronWakeupHorizonMs) && options.cronWakeupHorizonMs >= 0
        ? options.cronWakeupHorizonMs
        : undefined,
    graceMs:
      Number.isInteger(options.cronWakeupGraceMs) && options.cronWakeupGraceMs >= 0
        ? options.cronWakeupGraceMs
        : undefined,
    fireResolver: typeof options.cronFireResolver === 'function' ? options.cronFireResolver : undefined,
  };
  // Telemetry hook: called with {resolution:'resumed'|'cap_expired', session_id, elapsed_ms,
  // hold_ms} each time a pending busy-hold resolves. Lets production log how holds actually
  // resolve so the 30-min cap can be tuned against real usage instead of priors.
  const onBusyHoldEvent = typeof options.onBusyHoldEvent === 'function' ? options.onBusyHoldEvent : null;
  const emitBusyHoldEvent = (resolution, snap, nowMs) => {
    if (!onBusyHoldEvent) return;
    const heldSinceMs = Date.parse(snap?.completion_hint_at || snap?.updated_at || '') || 0;
    try {
      onBusyHoldEvent({
        resolution,
        session_id: snap?.session_id || '',
        elapsed_ms: heldSinceMs ? Math.max(0, nowMs - heldSinceMs) : null,
        hold_ms: snap?.completion_busy_hold_ms || backgroundTaskHoldMs,
        todo_state: snap?.todo_state || 'none',
      });
    } catch { /* telemetry must never break tracking */ }
  };
  const bySessionId = new Map();

  function verifyToken(req) {
    const header = typeof req.get === 'function' ? req.get('x-claude-hook-token') : null;
    const bodyToken = req.body && typeof req.body === 'object' ? req.body.token : undefined;
    const queryToken = req.query && typeof req.query === 'object' ? req.query.token : undefined;
    const t = header || bodyToken || queryToken;
    return typeof t === 'string' && t === token;
  }

  function prune(nowMs = Date.now()) {
    for (const [key, value] of bySessionId.entries()) {
      const ts = Date.parse(value.updated_at || '') || 0;
      if (!ts || nowMs - ts > ttlMs) bySessionId.delete(key);
    }
  }

  function ingestEvent(body = {}, opts = {}) {
    const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    const eventName = normalizeEventName(body);
    if (!eventName || !VALID_EVENTS.has(eventName)) {
      return {
        ok: false,
        error:
          'event_name must be one of UserPromptSubmit, SessionStart, Stop, PermissionRequest, Notification, PostToolUse, PreToolUse, MessageDisplay, or PostToolUseFailure',
      };
    }
    let sessionId = normalizeSessionId(body.session_id || body.sessionId);
    let transcriptPath = normalizeTranscriptPath(body.transcript_path || body.transcriptPath);
    const key0 = sessionId || transcriptPath;
    if (!key0) {
      return { ok: false, error: 'session_id or transcript_path is required' };
    }
    let existing = bySessionId.get(key0) || null;
    if (!existing && transcriptPath) {
      for (const snap of bySessionId.values()) {
        if (normalizeTranscriptPath(snap.transcript_path) === transcriptPath) {
          existing = snap;
          break;
        }
      }
    }
    if (!existing && sessionId) {
      for (const snap of bySessionId.values()) {
        if (normalizeSessionId(snap.session_id) === sessionId) {
          existing = snap;
          break;
        }
      }
    }
    if (!sessionId && existing?.session_id) sessionId = normalizeSessionId(existing.session_id);
    if (!transcriptPath && existing?.transcript_path) transcriptPath = normalizeTranscriptPath(existing.transcript_path);
    if (!sessionId && !transcriptPath) {
      return { ok: false, error: 'session_id or transcript_path is required' };
    }
    const key = sessionId || transcriptPath;
    if (key !== key0) {
      existing = bySessionId.get(key) || existing;
    }
    const row = bySessionId.get(key) || existing;
    const rawPromptText =
      body.prompt_preview || body.prompt || body.message || (typeof body.title === 'string' ? body.title : '');
    const preview = normalizePromptPreview(rawPromptText);
    // A `<task-notification>` UserPromptSubmit is the harness resuming the agent after a background
    // task/sub-agent finished — not a human prompt. Like the interrupt case, it must NOT overwrite
    // the picker label (else the row title becomes the raw `<task-notification> <task-id>…` envelope).
    const isTaskNotificationResume = isTaskNotification(rawPromptText);
    const hinted = shouldSetCompletionHint(eventName, body, completeOnPermission);
    const permissionEvent = isPermissionCompletionEvent(eventName, body);
    const updatedAt = new Date(nowMs).toISOString();
    // The session's latest TodoWrite state ('none' | 'unfinished' | 'all_done') — the agent's
    // stated remaining work, which tiers the busy-hold window at the next Stop (predicate parity
    // with done_detection's todo tracker). Sub-agents run their own lists: their PostToolUse
    // keeps the parent session_id but points at the CHILD transcript_path, so an event whose raw
    // transcript path disagrees with the row's never updates the parent's state.
    let todo_state = row?.todo_state || 'none';
    if (eventName === 'PostToolUse' && String(body.tool_name || '') === 'TodoWrite') {
      const incomingTranscript = normalizeTranscriptPath(body.transcript_path || body.transcriptPath);
      const rowTranscript = normalizeTranscriptPath(row?.transcript_path || '');
      const todos = body.tool_input && typeof body.tool_input === 'object' ? body.tool_input.todos : undefined;
      if (Array.isArray(todos) && (!incomingTranscript || !rowTranscript || incomingTranscript === rowTranscript)) {
        todo_state = todoStateFromTodos(todos);
      }
    }
    // Backend state (stored for a future "scheduled / running" view; does not change the
    // tracking flip). Refreshed on Stop; carried otherwise.
    const background_tasks =
      eventName === 'Stop' ? runningBackgroundTasks(body).map(normalizeBackgroundTask) : (row?.background_tasks || []);
    const session_crons =
      eventName === 'Stop' ? pendingSessionCrons(body).map(normalizeSessionCron) : (row?.session_crons || []);
    // A tool COMPLETING (PostToolUse) after a permission/question gate means the gate was ANSWERED —
    // the gated tool only runs once you approve. That's the gate-resolution signal (claude emits no
    // permission-resolved hook). Clear the pending hint so the pause side stops re-asserting needs-input
    // every poll, and let the resume side re-arm on this activity (updated_at advances below). Hook-
    // driven, so it works identically live + replay — no transcript-timestamp dependence.
    const clearsPermissionGate =
      eventName === 'PostToolUse' && !!row?.completion_hint && isPermissionAttentionReason(row?.attention_reason);
    let completion_hint;
    let completion_idle;
    let completion_hint_at;
    // True when the latest Stop reports a still-running sub-agent: the parent turn Stopped but a
    // backgrounded Task/Agent is still working. Held (never cleared) until a later Stop reports no
    // running sub-agent, eliminating the sub-agent-early-clear flicker without any latency penalty.
    let completion_subagent_pending;
    // True when the latest Stop left a running claude-managed background SHELL task: the
    // completion is held for the BOUNDED busy-hold window instead of the short debounce, so
    // sleep-and-check-back patterns never false-flip to done. The window itself is stamped at the
    // Stop (completion_busy_hold_ms) — TIERED by the session's TodoWrite state at that moment
    // (resolveBusyHoldMs): unfinished todos keep the full backstop, a completed list / no list
    // settle at the short tiers. Capped so a long-lived task (dev server) settles to done.
    let completion_busy_hold;
    let completion_busy_hold_ms;
    if (eventName === 'UserPromptSubmit') {
      // Any resume (task-notification, cron-fired prompt, or human message) cancels a pending
      // completion and re-arms tracking — the agent is generating again.
      if (row?.completion_hint && row?.completion_busy_hold) emitBusyHoldEvent('resumed', row, nowMs);
      completion_hint = false;
      completion_idle = false;
      completion_hint_at = '';
      completion_subagent_pending = false;
      completion_busy_hold = false;
      completion_busy_hold_ms = 0;
    } else if (clearsPermissionGate) {
      completion_hint = false;
      completion_idle = false;
      completion_hint_at = '';
      completion_subagent_pending = false;
      completion_busy_hold = false;
      completion_busy_hold_ms = 0;
    } else if (permissionEvent && !completeOnPermission) {
      completion_hint = !!row?.completion_hint;
      completion_idle = !!row?.completion_idle;
      completion_hint_at = row?.completion_hint_at || '';
      completion_subagent_pending = !!row?.completion_subagent_pending;
      completion_busy_hold = !!row?.completion_busy_hold;
      completion_busy_hold_ms = row?.completion_busy_hold_ms || 0;
    } else if (hinted) {
      completion_hint = true;
      // Needs-input gates and idle Stops clear immediately; a busy Stop (running background
      // tasks or pending crons) is debounced.
      completion_idle = eventName === 'Stop' ? stopIsIdle(body) : true;
      completion_hint_at = updatedAt;
      // A Stop recomputes the cascade state from its own body; other hinted events (permission)
      // don't touch it.
      completion_subagent_pending = eventName === 'Stop' ? stopHasRunningSubagent(body) : false;
      completion_busy_hold = eventName === 'Stop' ? stopHasRunningShellTask(body) : false;
      completion_busy_hold_ms = completion_busy_hold
        ? resolveBusyHoldMs(todo_state, { busyHoldMs: backgroundTaskHoldMs, todoDoneHoldMs, noTodoHoldMs })
        : 0;
    } else {
      completion_hint = !!row?.completion_hint;
      completion_idle = !!row?.completion_idle;
      completion_hint_at = row?.completion_hint_at || '';
      completion_subagent_pending = !!row?.completion_subagent_pending;
      completion_busy_hold = !!row?.completion_busy_hold;
      completion_busy_hold_ms = row?.completion_busy_hold_ms || 0;
    }
    const attention_reason = attentionReasonFromEvent(eventName, body);
    // The gated tool's name on a PermissionRequest ('AskUserQuestion' ⇒ a question gate, anything
    // else ⇒ a permission gate). Retained so the completion hint can carry the gate KIND to the watch
    // poller; cleared alongside attention_reason when a PostToolUse resolves the gate. Does NOT change
    // attention_reason (stays 'permission_request'), so gate-detection/re-arm are untouched.
    const gate_tool_name =
      eventName === 'PermissionRequest' && typeof body.tool_name === 'string' ? body.tool_name.trim() : '';
    const incomingRemoteHost =
      typeof body.remote_host === 'string' ? body.remote_host.trim() : '';
    let generating;
    if (eventName === 'UserPromptSubmit') {
      generating = isUserRequestInterruptedPreview(preview) ? false : true;
    } else if (eventName === 'Stop') generating = false;
    else generating = !!row?.generating;
    const snapshot = {
      provider: 'claude',
      event_name: eventName,
      session_id: sessionId || row?.session_id || '',
      transcript_path: transcriptPath || row?.transcript_path || '',
      workspace_path:
        typeof body.workspace_path === 'string'
          ? body.workspace_path
          : typeof body.cwd === 'string'
            ? body.cwd
            : row?.workspace_path || '',
      title: typeof body.title === 'string' ? body.title : row?.title || '',
      last_user_preview: isUserRequestInterruptedPreview(preview) || isTaskNotificationResume
        ? row?.last_user_preview || ''
        : preview || row?.last_user_preview || '',
      remote_host: incomingRemoteHost || row?.remote_host || '',
      generating,
      completion_hint,
      completion_idle,
      completion_hint_at,
      completion_subagent_pending,
      completion_busy_hold,
      completion_busy_hold_ms,
      todo_state,
      background_tasks,
      session_crons,
      // A PostToolUse that resolves a permission gate clears the attention so the pause side stops
      // re-asserting needs-input; otherwise keep the event's reason, else carry the row's.
      attention_reason: clearsPermissionGate ? '' : (attention_reason || row?.attention_reason || ''),
      // Carried on the same lifecycle as attention_reason so the gate hint knows the gate KIND.
      gate_tool_name: clearsPermissionGate ? '' : (gate_tool_name || row?.gate_tool_name || ''),
      updated_at: updatedAt,
    };
    bySessionId.set(key, snapshot);
    prune();
    return { ok: true, snapshot };
  }

  function listSnapshots() {
    prune();
    return [...bySessionId.values()].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  }

  function snapshotMatchesTracking(snap, ideTracking) {
    const wantedSession = normalizeSessionId(ideTracking.session_id);
    const wantedTranscript = normalizeTranscriptPath(ideTracking.transcript_path);
    if (wantedSession && snap.session_id && wantedSession === normalizeSessionId(snap.session_id)) return true;
    if (
      wantedTranscript &&
      snap.transcript_path &&
      wantedTranscript === normalizeTranscriptPath(snap.transcript_path)
    ) {
      return true;
    }
    return false;
  }

  function snapshotHostMatchesTracking(snap, ideTracking) {
    const watchHost = typeof ideTracking.host === 'string' ? ideTracking.host.trim() : '';
    const snapHost = typeof snap.remote_host === 'string' ? snap.remote_host.trim() : '';
    if (ideTracking.source === 'ssh') {
      if (watchHost && snapHost && watchHost !== snapHost) return false;
      return true;
    }
    return !snapHost;
  }

  function getCompletionHintForTracking(ideTracking, options = {}) {
    if (!ideTracking || ideTracking.provider !== 'claude') return null;
    prune();
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const debounceMs =
      Number.isInteger(options.debounceMs) && options.debounceMs >= 0 ? options.debounceMs : stopDebounceMs;
    const linkedAtMs = Date.parse(ideTracking.linked_at || '') || 0;
    for (const snap of bySessionId.values()) {
      if (!snap.completion_hint) continue;
      if (linkedAtMs && (Date.parse(snap.updated_at || '') || 0) <= linkedAtMs) continue;
      if (!snapshotHostMatchesTracking(snap, ideTracking)) continue;
      if (!snapshotMatchesTracking(snap, ideTracking)) continue;
      // A Stop that still reports a running sub-agent HOLDS indefinitely (no flicker): the parent
      // turn Stopped but a backgrounded sub-agent is still working. It clears only once a later
      // Stop reports no running sub-agent (or a resume re-arms and the true final idle Stop lands).
      if (snap.completion_subagent_pending) continue;
      // Busy (non-idle) Stop completions settle before flipping to done: running background SHELL
      // tasks get the BOUNDED busy-hold (they normally re-invoke the agent on completion; capped
      // so a long-lived task like a dev server still settles), crons-only busy Stops keep the
      // short debounce (a scheduled future wake-up is not running work) — unless a near-future
      // ONE-SHOT wakeup cron (ScheduleWakeup) holds until its fire + grace: the agent yielded to
      // its own scheduler, and the cron prompt's UserPromptSubmit resumes with no flicker.
      if (!snap.completion_idle) {
        const hintAtMs = Date.parse(snap.completion_hint_at || snap.updated_at || '') || 0;
        const windowMs = snap.completion_busy_hold
          ? snap.completion_busy_hold_ms || backgroundTaskHoldMs
          : debounceMs;
        if (windowMs > 0 && hintAtMs && nowMs - hintAtMs < windowMs) continue;
        if (hintAtMs && nowMs < cronWakeupHoldDeadlineMs(snap.session_crons, hintAtMs, cronWakeupOpts)) {
          continue;
        }
        // A busy-hold that reaches here cleared by CAP EXPIRY (the no-signal backstop fired) —
        // mark the snapshot so the watch can stamp it, and emit telemetry once per hold.
        if (snap.completion_busy_hold && !snap.busy_hold_expired) {
          snap.busy_hold_expired = true;
          emitBusyHoldEvent('cap_expired', snap, nowMs);
        }
      }
      return snap;
    }
    return null;
  }

  /**
   * True when the watched session is sitting in a "busy" Stop whose debounce window has not
   * yet elapsed — used by the poller to keep tracking (and skip the transcript-completion
   * fallback) while the agent might still resume from a background task or cron.
   */
  function isStopDebouncePending(ideTracking, options = {}) {
    if (!ideTracking || ideTracking.provider !== 'claude') return false;
    prune();
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const debounceMs =
      Number.isInteger(options.debounceMs) && options.debounceMs >= 0 ? options.debounceMs : stopDebounceMs;
    const linkedAtMs = Date.parse(ideTracking.linked_at || '') || 0;
    for (const snap of bySessionId.values()) {
      if (!snap.completion_hint || snap.completion_idle) continue;
      if (linkedAtMs && (Date.parse(snap.updated_at || '') || 0) <= linkedAtMs) continue;
      if (!snapshotHostMatchesTracking(snap, ideTracking)) continue;
      if (!snapshotMatchesTracking(snap, ideTracking)) continue;
      // A running sub-agent holds the watch open indefinitely, independent of the time debounce.
      if (snap.completion_subagent_pending) return true;
      // Running shell tasks: bounded busy-hold window (todo-tiered, stamped at the Stop);
      // crons-only: short debounce — extended to fire + grace for a near-future ONE-SHOT wakeup
      // cron (ScheduleWakeup hold).
      const hintAtMs = Date.parse(snap.completion_hint_at || snap.updated_at || '') || 0;
      const windowMs = snap.completion_busy_hold
        ? snap.completion_busy_hold_ms || backgroundTaskHoldMs
        : debounceMs;
      if (windowMs > 0 && hintAtMs && nowMs - hintAtMs < windowMs) return true;
      if (hintAtMs && nowMs < cronWakeupHoldDeadlineMs(snap.session_crons, hintAtMs, cronWakeupOpts)) {
        return true;
      }
    }
    return false;
  }

  /** Backend state (running background tasks + scheduled crons) for the watched session. */
  function getBackendStateForTracking(ideTracking) {
    if (!ideTracking || ideTracking.provider !== 'claude') return null;
    prune();
    for (const snap of bySessionId.values()) {
      if (!snapshotHostMatchesTracking(snap, ideTracking)) continue;
      if (!snapshotMatchesTracking(snap, ideTracking)) continue;
      return {
        background_tasks: snap.background_tasks || [],
        session_crons: snap.session_crons || [],
        updated_at: snap.updated_at || '',
      };
    }
    return null;
  }

  /** Any Claude hook on the watched session after a needs-input pause → agent active again. */
  function getHookActivityHintForTracking(ideTracking, options = {}) {
    if (!ideTracking || ideTracking.provider !== 'claude') return null;
    prune();
    const pausedAtMs = Number.isFinite(options.pausedAtMs)
      ? options.pausedAtMs
      : Date.parse(options.pausedAt || options.pausedAtIso || '') || 0;
    if (!pausedAtMs) return null;
    for (const snap of bySessionId.values()) {
      if (!snapshotHostMatchesTracking(snap, ideTracking)) continue;
      if (!snapshotMatchesTracking(snap, ideTracking)) continue;
      const activityMs = Date.parse(snap.updated_at || '') || 0;
      if (!activityMs || activityMs <= pausedAtMs) continue;
      return {
        generating: true,
        start_signal_at: snap.updated_at,
        last_activity_at: snap.updated_at,
        updated_at: snap.updated_at,
        event_name: snap.event_name || '',
      };
    }
    return null;
  }

  /**
   * True when THIS snapshot is in a state where the watch would still be HELD (not done):
   * a running sub-agent, or a busy (non-idle) Stop still inside its bounded busy-hold / debounce /
   * one-shot-wakeup window. Mirrors the exact done-gate in getCompletionHintForTracking so the
   * picker keeps a held run visible for precisely as long as the watch holds it — no over- or
   * under-visibility. Standalone (no tracking match): used to stamp `held` on picker rows.
   */
  function snapshotHeld(snap, options = {}) {
    if (!snap || !snap.completion_hint) return false;
    // A running sub-agent holds indefinitely, independent of the time windows.
    if (snap.completion_subagent_pending) return true;
    // An idle Stop has genuinely finished — not held.
    if (snap.completion_idle) return false;
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const debounceMs =
      Number.isInteger(options.debounceMs) && options.debounceMs >= 0 ? options.debounceMs : stopDebounceMs;
    const hintAtMs = Date.parse(snap.completion_hint_at || snap.updated_at || '') || 0;
    const windowMs = snap.completion_busy_hold
      ? snap.completion_busy_hold_ms || backgroundTaskHoldMs
      : debounceMs;
    if (windowMs > 0 && hintAtMs && nowMs - hintAtMs < windowMs) return true;
    if (hintAtMs && nowMs < cronWakeupHoldDeadlineMs(snap.session_crons, hintAtMs, cronWakeupOpts)) {
      return true;
    }
    return false;
  }

  return {
    getToken: () => token,
    verifyToken,
    ingestEvent,
    listSnapshots,
    getCompletionHintForTracking,
    isStopDebouncePending,
    snapshotHeld,
    getBackendStateForTracking,
    getHookActivityHintForTracking,
    prune,
  };
}

module.exports = {
  createClaudeHookStore,
  normalizeSessionId,
  normalizeEventName,
  DEFAULT_BACKGROUND_TASK_HOLD_MS,
};
