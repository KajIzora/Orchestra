const crypto = require('crypto');
const { truncateCleanHumanPromptPreview } = require('./human_prompt_preview');
const { isUserRequestInterruptedPreview } = require('./request_interrupted_preview');

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
]);
const SNAPSHOT_TTL_MS = 60 * 60 * 1000;
// A "busy" Stop (running background tasks or pending scheduled crons) is held this long
// before flipping the watch to done. If a resume (any UserPromptSubmit — a
// <task-notification>, a cron-fired prompt, or a human message) arrives within the window
// the pending completion is cancelled and the watch stays tracking (no flicker). If it
// arrives after, "done" was already shown and tracking re-arms = a (tolerated) flicker.
// Idle Stops and needs-input gates ignore the debounce and clear immediately.
const DEFAULT_STOP_DEBOUNCE_MS = 15_000;

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
          'event_name must be UserPromptSubmit, SessionStart, Stop, PermissionRequest, or Notification',
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
    const preview = normalizePromptPreview(
      body.prompt_preview || body.prompt || body.message || (typeof body.title === 'string' ? body.title : '')
    );
    const hinted = shouldSetCompletionHint(eventName, body, completeOnPermission);
    const permissionEvent = isPermissionCompletionEvent(eventName, body);
    const updatedAt = new Date(nowMs).toISOString();
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
    if (eventName === 'UserPromptSubmit') {
      // Any resume (task-notification, cron-fired prompt, or human message) cancels a pending
      // completion and re-arms tracking — the agent is generating again.
      completion_hint = false;
      completion_idle = false;
      completion_hint_at = '';
    } else if (clearsPermissionGate) {
      completion_hint = false;
      completion_idle = false;
      completion_hint_at = '';
    } else if (permissionEvent && !completeOnPermission) {
      completion_hint = !!row?.completion_hint;
      completion_idle = !!row?.completion_idle;
      completion_hint_at = row?.completion_hint_at || '';
    } else if (hinted) {
      completion_hint = true;
      // Needs-input gates and idle Stops clear immediately; a busy Stop (running background
      // tasks or pending crons) is debounced.
      completion_idle = eventName === 'Stop' ? stopIsIdle(body) : true;
      completion_hint_at = updatedAt;
    } else {
      completion_hint = !!row?.completion_hint;
      completion_idle = !!row?.completion_idle;
      completion_hint_at = row?.completion_hint_at || '';
    }
    const attention_reason = attentionReasonFromEvent(eventName, body);
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
      last_user_preview: isUserRequestInterruptedPreview(preview)
        ? row?.last_user_preview || ''
        : preview || row?.last_user_preview || '',
      remote_host: incomingRemoteHost || row?.remote_host || '',
      generating,
      completion_hint,
      completion_idle,
      completion_hint_at,
      background_tasks,
      session_crons,
      // A PostToolUse that resolves a permission gate clears the attention so the pause side stops
      // re-asserting needs-input; otherwise keep the event's reason, else carry the row's.
      attention_reason: clearsPermissionGate ? '' : (attention_reason || row?.attention_reason || ''),
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
      // Busy (non-idle) Stop completions settle for the debounce window before flipping to done.
      if (!snap.completion_idle && debounceMs > 0) {
        const hintAtMs = Date.parse(snap.completion_hint_at || snap.updated_at || '') || 0;
        if (hintAtMs && nowMs - hintAtMs < debounceMs) continue;
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
    if (debounceMs <= 0) return false;
    const linkedAtMs = Date.parse(ideTracking.linked_at || '') || 0;
    for (const snap of bySessionId.values()) {
      if (!snap.completion_hint || snap.completion_idle) continue;
      if (linkedAtMs && (Date.parse(snap.updated_at || '') || 0) <= linkedAtMs) continue;
      if (!snapshotHostMatchesTracking(snap, ideTracking)) continue;
      if (!snapshotMatchesTracking(snap, ideTracking)) continue;
      const hintAtMs = Date.parse(snap.completion_hint_at || snap.updated_at || '') || 0;
      if (hintAtMs && nowMs - hintAtMs < debounceMs) return true;
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

  return {
    getToken: () => token,
    verifyToken,
    ingestEvent,
    listSnapshots,
    getCompletionHintForTracking,
    isStopDebouncePending,
    getBackendStateForTracking,
    getHookActivityHintForTracking,
    prune,
  };
}

module.exports = {
  createClaudeHookStore,
  normalizeSessionId,
  normalizeEventName,
};
