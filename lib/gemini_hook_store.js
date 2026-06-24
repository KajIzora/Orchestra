const crypto = require('crypto');
const {
  AGY_HOOK_EVENTS,
  normalizeAgyHookBody,
  isAgyStopDone,
  isAgyStopCancel,
  isAgyStopPartialIdle,
  isPermissionGatedPreToolUse,
  isAskQuestionPreToolUse,
  isSubagentInvocationToolCall,
  agyScheduleWakeupAtMs,
  isAntigravityTranscriptPath,
} = require('./antigravity_hook_signals');
const {
  evaluateAgyTranscriptIdleCompletion,
  DEFAULT_QUIESCENCE_MS,
  DEFAULT_TREE_INFLIGHT_GRACE_MS,
} = require('./antigravity_transcript_idle');

const VALID_EVENTS = new Set([
  'BeforeAgent',
  'BeforeModel',
  'AfterModel',
  'AfterAgent',
  'BeforeTool',
  'SessionStart',
  'SessionEnd',
  'Notification',
  ...AGY_HOOK_EVENTS,
]);

const SNAPSHOT_TTL_MS = 15 * 60 * 1000;

function normalizeSessionId(id) {
  if (typeof id !== 'string') return '';
  return id.trim();
}

function normalizeTranscriptPath(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizeHost(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function snapshotHostMatchesTracking(snap, ideTracking) {
  const snapHost = normalizeHost(snap?.remote_host || snap?.host);
  const trackingHost = normalizeHost(ideTracking?.host || ideTracking?.remote_host);
  return !(snapHost && trackingHost && snapHost !== trackingHost);
}

function normalizePromptPreview(input) {
  if (typeof input !== 'string') return '';
  let one = input;
  const userRequestMatches = [...one.matchAll(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/gi)];
  if (userRequestMatches.length) {
    one = userRequestMatches
      .map((m) => (typeof m[1] === 'string' ? m[1] : ''))
      .join(' ')
      .trim();
  }
  one = one.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, ' ');
  one = one.replace(/<[^>]+>/g, ' ');
  one = one.replace(/\s+/g, ' ').trim();
  if (!one) return '';
  const words = one.split(' ');
  return words.length <= 10 ? one : `${words.slice(0, 10).join(' ')}…`;
}

function isStubPreview(preview) {
  if (typeof preview !== 'string') return false;
  const trimmed = preview.trim();
  if (!trimmed) return false;
  return /^[a-f0-9-]{8,36}$/i.test(trimmed);
}

function pickCanonicalSessionId(existingSid, incomingSid) {
  const a = typeof existingSid === 'string' ? existingSid.trim() : '';
  const b = typeof incomingSid === 'string' ? incomingSid.trim() : '';
  if (!a) return b;
  if (!b) return a;
  if (a === b) return b;
  if (a.startsWith(b) && a.length > b.length) return a;
  if (b.startsWith(a) && b.length > a.length) return b;
  return b;
}

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

function isLegacyGeneratingEvent(eventName) {
  return (
    eventName === 'BeforeAgent' ||
    eventName === 'BeforeModel' ||
    eventName === 'AfterModel' ||
    eventName === 'BeforeTool'
  );
}

function isLegacyCompletionEvent(eventName) {
  return eventName === 'AfterAgent' || eventName === 'SessionEnd';
}

function isAgyGeneratingEvent(eventName) {
  return (
    eventName === 'PreInvocation' ||
    eventName === 'PostInvocation' ||
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse'
  );
}

function shouldStartGeneratingFromPreInvocation(agy, row) {
  if (agy.invocationNum !== 0) return true;
  if (!row) return true;
  if (row.generating === true && !row.agy_last_fully_idle_at) return true;
  if (row.agy_last_fully_idle_at) return true;
  return false;
}

// Some agy/model variants (seen with Gemini 3.5 Flash medium) deliver the terminal idle marker —
// fullyIdle=true + terminationReason=NO_TOOL_CALL with no actual tool call — on a PreToolUse or
// PostToolUse envelope instead of a Stop. Semantically that is still "the agent stopped, fully
// idle, nothing more to do". Detect it so the caller can treat it as a Stop; otherwise the tool-use
// branch reads it as the agent resuming work (generating=true) and even marks an in-flight tool,
// which both hides the primary done and jams the idle backup. A genuine tool-use envelope carries a
// tool call and is not NO_TOOL_CALL, so this never fires for real tool activity.
function isAgyTerminalIdleMarker(eventName, agy) {
  if (eventName !== 'PreToolUse' && eventName !== 'PostToolUse') return false;
  if (!agy || !isAgyStopDone(agy.payload)) return false;
  const name = agy.toolCall && typeof agy.toolCall === 'object' ? agy.toolCall.name : agy.toolCall;
  return !name;
}

function deriveAgySnapshotFlags(eventName, agy, row, nowMs = Date.now()) {
  const payload = agy.payload || {};
  const nowIso = () => new Date(nowMs).toISOString();
  const flags = {
    generating: row?.generating,
    completion_hint: !!row?.completion_hint,
    cancel_hint: !!row?.cancel_hint,
    permission_pending: !!row?.permission_pending,
    question_pending: !!row?.question_pending,
    agy_last_fully_idle_at: row?.agy_last_fully_idle_at || '',
    agy_last_partial_stop_at: row?.agy_last_partial_stop_at || '',
    agy_last_hook_activity_at: row?.agy_last_hook_activity_at || '',
    agy_scheduled_wakeup_at: row?.agy_scheduled_wakeup_at || '',
    agy_pending_pre_tool_step: row?.agy_pending_pre_tool_step ?? null,
    agy_pending_pre_tool_at: row?.agy_pending_pre_tool_at || '',
    // Latest tool call the agent invoked that has not returned a PostToolUse yet. Used to tell
    // "agent is blocked waiting on a background command" apart from "agent is done". null = the
    // most recent tool call already completed (or there is none).
    agy_inflight_tool_step: row?.agy_inflight_tool_step ?? null,
    agy_inflight_tool_at: row?.agy_inflight_tool_at || '',
    notification_type: row?.notification_type || '',
  };

  if (isAgyGeneratingEvent(eventName)) {
    flags.agy_last_hook_activity_at = nowIso();
  }

  if (eventName === 'PreInvocation') {
    if (shouldStartGeneratingFromPreInvocation(agy, row)) {
      flags.generating = true;
      flags.completion_hint = false;
      flags.cancel_hint = false;
    } else {
      flags.generating = row?.generating === true;
    }
    return flags;
  }

  if (eventName === 'PostInvocation' || eventName === 'PostToolUse') {
    flags.generating = true;
    flags.completion_hint = false;
    if (eventName === 'PostToolUse') {
      if (flags.permission_pending) {
        flags.permission_pending = false;
        flags.agy_pending_pre_tool_step = null;
        flags.agy_pending_pre_tool_at = '';
      }
      flags.agy_pending_pre_tool_step = null;
      flags.agy_pending_pre_tool_at = '';
      // The latest in-flight tool call returned → no longer waiting on it. Only clear on an
      // exact step match so a stale PostToolUse for an earlier (already-superseded) tool does
      // not clear a newer in-flight one.
      if (
        Number.isFinite(agy.toolStepIdx) &&
        agy.toolStepIdx === flags.agy_inflight_tool_step
      ) {
        flags.agy_inflight_tool_step = null;
        flags.agy_inflight_tool_at = '';
      }
      if (flags.question_pending) {
        flags.question_pending = false;
      }
    }
    return flags;
  }

  if (eventName === 'PreToolUse') {
    flags.generating = true;
    flags.completion_hint = false;
    // This is now the agent's most recent tool call; mark it in-flight until its PostToolUse.
    // Overwrites any prior in-flight step — once the agent moves on to a newer tool, an older
    // fire-and-forget background command no longer represents what the agent is waiting on.
    if (isSubagentInvocationToolCall(agy.toolCall)) {
      // `invoke_subagent` is DELEGATION, not a tool the parent blocks on: its spawn PreToolUse
      // frequently has no matching PostToolUse (the sub-agent's own Stop is the completion). So
      // (a) don't mark it in-flight — that marker would never clear and would jam the idle backup
      // for the full inflight cap; and (b) clear any prior in-flight step — like every newer tool,
      // the delegation supersedes it, and the parent is now waiting on the sub-agent (tracked by
      // cascade-wide quiescence), not on a tool of its own.
      flags.agy_inflight_tool_step = null;
      flags.agy_inflight_tool_at = '';
    } else if (Number.isFinite(agy.toolStepIdx)) {
      flags.agy_inflight_tool_step = agy.toolStepIdx;
      flags.agy_inflight_tool_at = nowIso();
    }
    if (isAskQuestionPreToolUse(agy.toolCall)) {
      flags.question_pending = true;
      flags.permission_pending = false;
      flags.agy_pending_pre_tool_step = null;
      flags.agy_pending_pre_tool_at = '';
    } else if (isPermissionGatedPreToolUse(agy.toolCall, payload)) {
      flags.agy_pending_pre_tool_step = agy.toolStepIdx;
      flags.agy_pending_pre_tool_at = nowIso();
    }
    const scheduleWakeMs = agyScheduleWakeupAtMs(agy.toolCall);
    if (scheduleWakeMs) flags.agy_scheduled_wakeup_at = new Date(scheduleWakeMs).toISOString();
    return flags;
  }

  if (eventName === 'Stop') {
    if (isAgyStopCancel(payload)) {
      flags.generating = false;
      flags.completion_hint = false;
      flags.cancel_hint = true;
      flags.permission_pending = false;
      flags.question_pending = false;
      flags.agy_pending_pre_tool_step = null;
      flags.agy_pending_pre_tool_at = '';
      flags.agy_inflight_tool_step = null;
      flags.agy_inflight_tool_at = '';
      flags.agy_last_partial_stop_at = '';
      flags.agy_scheduled_wakeup_at = '';
      return flags;
    }
    if (isAgyStopDone(payload)) {
      flags.generating = false;
      flags.completion_hint = true;
      flags.cancel_hint = false;
      flags.permission_pending = false;
      flags.question_pending = false;
      flags.agy_pending_pre_tool_step = null;
      flags.agy_pending_pre_tool_at = '';
      flags.agy_inflight_tool_step = null;
      flags.agy_inflight_tool_at = '';
      flags.agy_last_fully_idle_at = nowIso();
      flags.agy_last_partial_stop_at = '';
      flags.agy_scheduled_wakeup_at = '';
      return flags;
    }
    const reason = String(payload.terminationReason || payload.termination_reason || '').toUpperCase();
    const fullyIdle = payload.fullyIdle === true || payload.fully_idle === true;
    if (reason === 'ERROR' && fullyIdle) {
      flags.generating = false;
      flags.completion_hint = true;
      flags.cancel_hint = false;
      flags.permission_pending = false;
      flags.question_pending = false;
      flags.agy_pending_pre_tool_step = null;
      flags.agy_pending_pre_tool_at = '';
      flags.agy_inflight_tool_step = null;
      flags.agy_inflight_tool_at = '';
      flags.agy_last_fully_idle_at = nowIso();
      flags.agy_last_partial_stop_at = '';
      flags.agy_scheduled_wakeup_at = '';
      return flags;
    }
    if (isAgyStopPartialIdle(payload)) {
      flags.generating = true;
      flags.completion_hint = false;
      if (reason === 'NO_TOOL_CALL') {
        flags.agy_last_partial_stop_at = nowIso();
      }
      return flags;
    }
    flags.generating = row?.generating === true;
    return flags;
  }

  return flags;
}

function createGeminiHookStore(options = {}) {
  const token = options.token || crypto.randomBytes(24).toString('hex');
  const ttlMs = Number.isInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : SNAPSHOT_TTL_MS;
  const homeDir = options.homeDir;
  const bySessionId = new Map();

  function verifyToken(req) {
    const header = typeof req.get === 'function' ? req.get('x-gemini-hook-token') : null;
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

  function ingestEvent(body = {}, ingestOpts = {}) {
    // nowMs lets the signal replay drive a virtual clock so time-based hints (the agy
    // idle-completion quiescence) can fire during recorded silent gaps. Live ingests omit
    // it and stamp with the real clock, so server behavior is unchanged.
    const nowMs = Number.isFinite(ingestOpts.nowMs) ? ingestOpts.nowMs : Date.now();
    let eventName = normalizeEventName(body);
    if (!eventName || !VALID_EVENTS.has(eventName)) {
      return {
        ok: false,
        error: `Invalid event_name: ${eventName}. Must be one of: ${[...VALID_EVENTS].join(', ')}`,
      };
    }

    const agyMeta = AGY_HOOK_EVENTS.has(eventName) ? normalizeAgyHookBody(body, homeDir) : null;
    const agy = agyMeta
      ? {
          conversationId: agyMeta.conversationId,
          transcriptPath: agyMeta.transcriptPath,
          workspacePath: agyMeta.workspacePath,
          agentKind: agyMeta.agy_agent_kind,
          invocationNum: agyMeta.agy_invocation_num,
          terminationReason: agyMeta.agy_termination_reason,
          fullyIdle: agyMeta.agy_fully_idle,
          toolCall: agyMeta.agy_tool_call,
          toolStepIdx: agyMeta.agy_tool_step_idx,
          payload: agyMeta.agy_payload,
        }
      : null;

    // Normalize a terminal idle marker delivered on a tool-use envelope to a Stop, so the done
    // handling and every event_name==='Stop' gate downstream treat it consistently (see
    // isAgyTerminalIdleMarker). Done after agy is parsed; agy events stay agy events.
    if (isAgyTerminalIdleMarker(eventName, agy)) {
      eventName = 'Stop';
    }

    let sessionId = normalizeSessionId(
      body.session_id || body.sessionId || agy?.conversationId || ''
    );
    let transcriptPath = normalizeTranscriptPath(
      body.transcript_path || body.transcriptPath || agy?.transcriptPath || ''
    );
    const key0 = sessionId || transcriptPath;

    if (!key0) {
      return { ok: false, error: 'session_id or transcript_path is required' };
    }

    let existingKey = null;
    let existing = null;
    if (bySessionId.has(key0)) {
      existing = bySessionId.get(key0);
      existingKey = key0;
    }
    if (!existing && transcriptPath) {
      for (const [k, snap] of bySessionId.entries()) {
        if (normalizeTranscriptPath(snap.transcript_path) === transcriptPath) {
          existing = snap;
          existingKey = k;
          break;
        }
      }
    }
    if (!existing && sessionId) {
      for (const [k, snap] of bySessionId.entries()) {
        if (normalizeSessionId(snap.session_id) === sessionId) {
          existing = snap;
          existingKey = k;
          break;
        }
      }
    }

    if (!sessionId && existing?.session_id) sessionId = normalizeSessionId(existing.session_id);
    if (!transcriptPath && existing?.transcript_path)
      transcriptPath = normalizeTranscriptPath(existing.transcript_path);

    if (existing?.session_id) {
      sessionId = pickCanonicalSessionId(existing.session_id, sessionId);
    }

    const key = sessionId || transcriptPath;
    const row = bySessionId.get(key) || existing;

    const incomingPreview = normalizePromptPreview(body.prompt || body.prompt_preview || '');
    const preview =
      incomingPreview && isStubPreview(incomingPreview) && row?.last_user_preview && !isStubPreview(row.last_user_preview)
        ? row.last_user_preview
        : incomingPreview;

    const incomingRemoteHost =
      typeof body.remote_host === 'string' ? body.remote_host.trim() : '';

    const incomingSourceKind = body.source_kind === 'scan' ? 'scan' : 'hook';
    const sourceKind = row?.source_kind === 'hook' ? 'hook' : incomingSourceKind;

    let generating;
    let completionHint = !!row?.completion_hint;
    let cancelHint = !!row?.cancel_hint;
    let permissionPending = !!row?.permission_pending;
    let questionPending = !!row?.question_pending;
    let permissionResolvedAt = row?.permission_resolved_at || '';
    let questionResolvedAt = row?.question_resolved_at || '';
    let agyLastFullyIdleAt = row?.agy_last_fully_idle_at || '';
    let agyLastPartialStopAt = row?.agy_last_partial_stop_at || '';
    let agyLastHookActivityAt = row?.agy_last_hook_activity_at || '';
    let agyScheduledWakeupAt = row?.agy_scheduled_wakeup_at || '';
    let agyPendingPreToolStep = row?.agy_pending_pre_tool_step ?? null;
    let agyPendingPreToolAt = row?.agy_pending_pre_tool_at || '';
    let agyInflightToolStep = row?.agy_inflight_tool_step ?? null;
    let agyInflightToolAt = row?.agy_inflight_tool_at || '';

    if (agy) {
      const agyFlags = deriveAgySnapshotFlags(eventName, agy, row, nowMs);
      generating = agyFlags.generating;
      completionHint = agyFlags.completion_hint;
      cancelHint = agyFlags.cancel_hint;
      permissionPending = agyFlags.permission_pending;
      questionPending = agyFlags.question_pending;
      agyLastFullyIdleAt = agyFlags.agy_last_fully_idle_at || agyLastFullyIdleAt;
      agyLastPartialStopAt = agyFlags.agy_last_partial_stop_at;
      agyLastHookActivityAt = agyFlags.agy_last_hook_activity_at || agyLastHookActivityAt;
      agyScheduledWakeupAt = agyFlags.agy_scheduled_wakeup_at || '';
      agyPendingPreToolStep = agyFlags.agy_pending_pre_tool_step;
      agyPendingPreToolAt = agyFlags.agy_pending_pre_tool_at || '';
      agyInflightToolStep = agyFlags.agy_inflight_tool_step ?? null;
      agyInflightToolAt = agyFlags.agy_inflight_tool_at || '';
    } else if (isLegacyGeneratingEvent(eventName)) {
      generating = true;
      completionHint = false;
    } else if (isLegacyCompletionEvent(eventName)) {
      generating = false;
      completionHint = eventName === 'AfterAgent';
    } else {
      generating = !!row?.generating;
    }

    if (
      isLegacyCompletionEvent(eventName) &&
      incomingSourceKind === 'scan' &&
      row?.source_kind === 'hook' &&
      row?.generating === true
    ) {
      generating = true;
      completionHint = !!row?.completion_hint;
    }

    const notificationType =
      eventName === 'Notification'
        ? (typeof body.notification_type === 'string'
            ? body.notification_type.trim()
            : typeof body.notificationType === 'string'
              ? body.notificationType.trim()
              : '')
        : eventName === 'BeforeTool' && row?.notification_type
          ? ''
          : row?.notification_type || '';

    if (eventName === 'Notification' && notificationType === 'ToolPermission') {
      permissionPending = true;
      generating = true;
      completionHint = false;
    }

    if (typeof body.agy_permission_pending === 'boolean') {
      permissionPending = body.agy_permission_pending;
      if (permissionPending) {
        generating = true;
        completionHint = false;
      } else {
        agyPendingPreToolStep = null;
        agyPendingPreToolAt = '';
      }
    }
    if (typeof body.agy_question_pending === 'boolean') {
      questionPending = body.agy_question_pending;
    }
    if (typeof body.agy_cancel_hint === 'boolean') {
      cancelHint = body.agy_cancel_hint;
      if (cancelHint) {
        generating = false;
        completionHint = false;
        permissionPending = false;
        questionPending = false;
        agyPendingPreToolStep = null;
        agyPendingPreToolAt = '';
      }
    }
    if (typeof body.agy_completion_hint === 'boolean') {
      completionHint = body.agy_completion_hint;
    }

    const updatedAt = new Date(nowMs).toISOString();
    if (
      (!permissionPending && row?.permission_pending === true) ||
      (eventName === 'PostToolUse' && body.agy_permission_pending === false)
    ) {
      permissionResolvedAt = updatedAt;
    }
    if (
      (!questionPending && row?.question_pending === true) ||
      body.agy_question_pending === false
    ) {
      questionResolvedAt = updatedAt;
    }

    const snapshot = {
      provider: 'gemini',
      event_name: eventName,
      session_id: sessionId || row?.session_id || '',
      transcript_path: transcriptPath || row?.transcript_path || '',
      workspace_path:
        agy?.workspacePath ||
        (typeof body.workspace_path === 'string'
          ? body.workspace_path
          : typeof body.cwd === 'string'
            ? body.cwd
            : row?.workspace_path || ''),
      title: typeof body.title === 'string' ? body.title : row?.title || '',
      last_user_preview: preview || row?.last_user_preview || '',
      remote_host: incomingRemoteHost || row?.remote_host || '',
      source_kind: sourceKind,
      event_source_kind: incomingSourceKind,
      generating,
      completion_hint: completionHint,
      cancel_hint: cancelHint,
      permission_pending: permissionPending,
      question_pending: questionPending,
      permission_resolved_at: permissionResolvedAt,
      question_resolved_at: questionResolvedAt,
      notification_type: notificationType,
      agy_agent_kind: agy?.agentKind || row?.agy_agent_kind || '',
      agy_invocation_num: agy?.invocationNum ?? row?.agy_invocation_num ?? null,
      agy_termination_reason: agy?.terminationReason || row?.agy_termination_reason || '',
      agy_fully_idle: agy ? agy.fullyIdle : row?.agy_fully_idle,
      agy_last_fully_idle_at: agyLastFullyIdleAt,
      agy_last_partial_stop_at: agyLastPartialStopAt,
      agy_last_hook_activity_at: agyLastHookActivityAt,
      agy_scheduled_wakeup_at: agyScheduledWakeupAt,
      agy_pending_pre_tool_step: agyPendingPreToolStep,
      agy_pending_pre_tool_at: agyPendingPreToolAt,
      agy_inflight_tool_step: agyInflightToolStep,
      agy_inflight_tool_at: agyInflightToolAt,
      updated_at: updatedAt,
    };

    if (existingKey && existingKey !== key) {
      bySessionId.delete(existingKey);
    }
    bySessionId.set(key, snapshot);
    prune();
    return { ok: true, snapshot };
  }

  function listSnapshots() {
    prune();
    return [...bySessionId.values()].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  }

  function snapshotsMatchingRun(run) {
    if (!run || typeof run !== 'object') return [];
    prune();
    const wantedSession = normalizeSessionId(run.session_id);
    const wantedTranscript = normalizeTranscriptPath(run.transcript_path);
    const linkedAtMs = Date.parse(run.linked_at || '') || 0;
    const out = [];
    for (const snap of bySessionId.values()) {
      if (linkedAtMs && (Date.parse(snap.updated_at || '') || 0) <= linkedAtMs) continue;
      if (!snapshotHostMatchesTracking(snap, run)) continue;
      if (wantedSession && snap.session_id && wantedSession === normalizeSessionId(snap.session_id)) {
        out.push(snap);
        continue;
      }
      if (
        wantedTranscript &&
        snap.transcript_path &&
        wantedTranscript === normalizeTranscriptPath(snap.transcript_path)
      ) {
        out.push(snap);
      }
    }
    out.sort((a, b) => (Date.parse(b.updated_at || '') || 0) - (Date.parse(a.updated_at || '') || 0));
    return out;
  }

  function getActiveGenerationForTracking(ideTracking) {
    if (!ideTracking || (ideTracking.provider !== 'gemini' && ideTracking.provider !== 'gemini_cli')) return null;
    const matches = snapshotsMatchingRun(ideTracking);
    return matches[0] || null;
  }

  function getPickerGenerationHintForRun(run) {
    const matches = snapshotsMatchingRun(run);
    if (!matches.length) return null;
    return matches.find((snap) => snap.generating === true) || matches[0];
  }

  function snapshotIsCompletionHint(snap) {
    if (!snap || snap.event_source_kind === 'scan' || snap.source_kind === 'scan') return false;
    if (snap.event_name === 'AfterAgent' && snap.generating === false) return true;
    if (snap.event_name === 'Stop' && snap.completion_hint === true && snap.generating === false) return true;
    return false;
  }

  function getCompletionHintForTracking(ideTracking) {
    if (!ideTracking || (ideTracking.provider !== 'gemini' && ideTracking.provider !== 'gemini_cli')) return null;
    prune();
    const wantedSession = normalizeSessionId(ideTracking.session_id);
    const wantedTranscript = normalizeTranscriptPath(ideTracking.transcript_path);
    const linkedAtMs = Date.parse(ideTracking.linked_at || '') || 0;

    for (const snap of bySessionId.values()) {
      if (!snapshotIsCompletionHint(snap)) continue;
      if (linkedAtMs && (Date.parse(snap.updated_at || '') || 0) <= linkedAtMs) continue;
      if (!snapshotHostMatchesTracking(snap, ideTracking)) continue;
      if (wantedSession && snap.session_id && wantedSession === normalizeSessionId(snap.session_id)) return snap;
      if (
        wantedTranscript &&
        snap.transcript_path &&
        wantedTranscript === normalizeTranscriptPath(snap.transcript_path)
      ) {
        return snap;
      }
    }
    return null;
  }

  // Cascade support: the latest signals for one conversation (typically a sub-agent), so the
  // parent's secondary completion can reason about the WHOLE tree's quiescence — last hook
  // activity, a pending question/permission, and a scheduled wakeup. `present` is false when no
  // hooks for that conversation have been seen yet.
  function conversationSignalsFromSnap(snap) {
    if (!snap) return { present: false };
    const lastActivityMs = Math.max(
      Date.parse(snap.updated_at || '') || 0,
      Date.parse(snap.agy_last_hook_activity_at || '') || 0
    );
    const lastStopMs = Math.max(
      Date.parse(snap.agy_last_partial_stop_at || '') || 0,
      Date.parse(snap.agy_last_fully_idle_at || '') || 0
    );
    return {
      present: true,
      lastActivityMs,
      lastStopMs,
      // "Working" = the latest hook is AFTER this conversation's last Stop (it resumed and is mid
      // work — a tool call, a model step), or it has been active but never stopped. While working
      // it produces no hooks between steps, so it must not read as "quiet" the instant it pauses.
      working: lastActivityMs > 0 && lastActivityMs > lastStopMs,
      questionPending: !!snap.question_pending,
      permissionPending: !!snap.permission_pending,
      scheduledWakeupMs: Date.parse(snap.agy_scheduled_wakeup_at || '') || 0,
    };
  }

  function getConversationSignals(conversationId) {
    const wanted = normalizeSessionId(conversationId);
    if (!wanted) return { present: false };
    for (const snap of bySessionId.values()) {
      if (!snap.session_id || normalizeSessionId(snap.session_id) !== wanted) continue;
      return conversationSignalsFromSnap(snap);
    }
    return { present: false };
  }

  // The instant a conversation is considered idle-from: its last Stop fires it immediately (a clean
  // turn end), but a conversation still mid-work is held "busy" for a grace window past its last
  // activity — so its silent between-steps / in-flight-tool gap doesn't read as the run's end,
  // while a conversation that ended mid-work with no final Stop still settles after the grace.
  function conversationBusyUntil(sig, graceMs) {
    if (!sig || !sig.present) return 0;
    return sig.working ? (sig.lastActivityMs || 0) + graceMs : sig.lastActivityMs || 0;
  }

  // Aggregate cascade-wide signals across the watched parent + its sub-agents. Returns the time the
  // WHOLE tree is "busy until" (max of every conversation's busy-until and scheduled wakeup) and
  // whether any conversation is paused on a question/permission.
  function aggregateCascadeSignals(parentSnap, subAgentIds = [], graceMs = DEFAULT_TREE_INFLIGHT_GRACE_MS) {
    const parentSig = conversationSignalsFromSnap(parentSnap);
    let treeBusyUntilMs = conversationBusyUntil(parentSig, graceMs);
    let scheduledWakeupMs = parentSig.scheduledWakeupMs || 0;
    let anyPending = !!parentSig.questionPending || !!parentSig.permissionPending;
    for (const id of subAgentIds) {
      const sig = getConversationSignals(id);
      if (!sig.present) continue; // not yet observed; the parent's own recent activity covers a fresh spawn
      treeBusyUntilMs = Math.max(treeBusyUntilMs, conversationBusyUntil(sig, graceMs));
      scheduledWakeupMs = Math.max(scheduledWakeupMs, sig.scheduledWakeupMs || 0);
      if (sig.questionPending || sig.permissionPending) anyPending = true;
    }
    return { treeBusyUntilMs, scheduledWakeupMs, anyPending };
  }

  // True when the watched cascade is NOT yet quiescent (recent/in-flight activity, or a pending
  // gate). Lets the transcript-done channel hold off until the tree settles.
  function cascadeHasRecentActivity(ideTracking, options = {}) {
    if (!ideTracking || (ideTracking.provider !== 'gemini' && ideTracking.provider !== 'gemini_cli')) return false;
    const subAgentIds = Array.isArray(options.subAgentIds) ? options.subAgentIds : [];
    if (!subAgentIds.length) return false; // no cascade → nothing extra to gate on
    const parentSnap = snapshotsMatchingRun(ideTracking)[0] || null;
    const { treeBusyUntilMs, scheduledWakeupMs, anyPending } = aggregateCascadeSignals(parentSnap, subAgentIds);
    if (anyPending) return true;
    const nowMs = options.nowMs ?? Date.now();
    const quiescenceMs = options.quiescenceMs ?? DEFAULT_QUIESCENCE_MS;
    const lastMs = Math.max(treeBusyUntilMs, scheduledWakeupMs);
    return lastMs > 0 && nowMs - lastMs < quiescenceMs;
  }

  function snapshotIsPermissionPending(snap) {
    if (!snap) return false;
    const isLegacyPermission =
      snap.event_name === 'Notification' && snap.notification_type === 'ToolPermission';
    const isPermission = isLegacyPermission || snap.permission_pending === true;
    if (!isPermission) return false;
    // Permission can arrive after a partial Stop (generating=false). Still needs input.
    if (snap.cancel_hint || snap.completion_hint) return false;
    return true;
  }

  function snapshotMatchesTrackingOrSubAgent(snap, ideTracking, options = {}) {
    const wantedSession = normalizeSessionId(ideTracking.session_id);
    const wantedTranscript = normalizeTranscriptPath(ideTracking.transcript_path);
    const snapSession = normalizeSessionId(snap.session_id);
    if (wantedSession && snapSession && wantedSession === snapSession) return true;
    if (
      wantedTranscript &&
      snap.transcript_path &&
      wantedTranscript === normalizeTranscriptPath(snap.transcript_path)
    ) {
      return true;
    }
    const subAgentIds = new Set(
      (Array.isArray(options.subAgentIds) ? options.subAgentIds : [])
        .map((id) => normalizeSessionId(id))
        .filter(Boolean)
    );
    return !!(snapSession && subAgentIds.has(snapSession));
  }

  function getPermissionPendingHintForTracking(ideTracking, options = {}) {
    if (!ideTracking || (ideTracking.provider !== 'gemini' && ideTracking.provider !== 'gemini_cli')) return null;
    prune();
    const linkedAtMs = Date.parse(ideTracking.linked_at || '') || 0;

    for (const snap of bySessionId.values()) {
      if (!snapshotIsPermissionPending(snap)) continue;
      if (linkedAtMs && (Date.parse(snap.updated_at || '') || 0) <= linkedAtMs) continue;
      if (!snapshotHostMatchesTracking(snap, ideTracking)) continue;
      if (snapshotMatchesTrackingOrSubAgent(snap, ideTracking, options)) return snap;
    }
    return null;
  }

  function getQuestionPendingHintForTracking(ideTracking, options = {}) {
    if (!ideTracking || (ideTracking.provider !== 'gemini' && ideTracking.provider !== 'gemini_cli')) return null;
    prune();
    const linkedAtMs = Date.parse(ideTracking.linked_at || '') || 0;

    for (const snap of bySessionId.values()) {
      if (!snap.question_pending) continue;
      if (linkedAtMs && (Date.parse(snap.updated_at || '') || 0) <= linkedAtMs) continue;
      if (!snapshotHostMatchesTracking(snap, ideTracking)) continue;
      if (snapshotMatchesTrackingOrSubAgent(snap, ideTracking, options)) return snap;
    }
    return null;
  }

  function getGateResolutionHintForTracking(ideTracking, options = {}) {
    if (!ideTracking || (ideTracking.provider !== 'gemini' && ideTracking.provider !== 'gemini_cli')) return null;
    const gate = options.gate === 'question' ? 'question' : options.gate === 'permission' ? 'permission' : '';
    if (!gate) return null;
    prune();
    const linkedAtMs = Date.parse(ideTracking.linked_at || '') || 0;
    const pausedAtMs = Number.isFinite(options.pausedAtMs)
      ? options.pausedAtMs
      : Date.parse(options.pausedAt || '') || 0;
    const field = gate === 'question' ? 'question_resolved_at' : 'permission_resolved_at';
    const pendingField = gate === 'question' ? 'question_pending' : 'permission_pending';

    const matches = [];
    for (const snap of bySessionId.values()) {
      const resolvedMs = Date.parse(snap[field] || '') || 0;
      if (!resolvedMs) continue;
      if (pausedAtMs && resolvedMs <= pausedAtMs) continue;
      if (linkedAtMs && resolvedMs <= linkedAtMs) continue;
      if (snap[pendingField]) continue;
      if (!snapshotHostMatchesTracking(snap, ideTracking)) continue;
      if (!snapshotMatchesTrackingOrSubAgent(snap, ideTracking, options)) continue;
      matches.push({ snap, resolvedMs });
    }
    matches.sort((a, b) => b.resolvedMs - a.resolvedMs);
    return matches[0]?.snap || null;
  }

  function getCancelHintForTracking(ideTracking, options = {}) {
    if (!ideTracking || (ideTracking.provider !== 'gemini' && ideTracking.provider !== 'gemini_cli')) return null;
    prune();
    const wantedSession = normalizeSessionId(ideTracking.session_id);
    const wantedTranscript = normalizeTranscriptPath(ideTracking.transcript_path);
    const linkedAtMs = Date.parse(ideTracking.linked_at || '') || 0;
    // Cancelling a sub-agent tears down the whole run, but the cancel snapshot carries the
    // child's conversationId, not the tracked parent's — so map the parent's spawned children
    // here too (mirrors the permission/question/gate hints, which already thread subAgentIds).
    const subAgentIds = new Set(
      (Array.isArray(options.subAgentIds) ? options.subAgentIds : [])
        .map((id) => normalizeSessionId(id))
        .filter(Boolean)
    );

    for (const snap of bySessionId.values()) {
      if (!snap.cancel_hint) continue;
      if (linkedAtMs && (Date.parse(snap.updated_at || '') || 0) <= linkedAtMs) continue;
      if (!snapshotHostMatchesTracking(snap, ideTracking)) continue;
      if (wantedSession && snap.session_id && wantedSession === normalizeSessionId(snap.session_id)) return snap;
      if (
        wantedTranscript &&
        snap.transcript_path &&
        wantedTranscript === normalizeTranscriptPath(snap.transcript_path)
      ) {
        return snap;
      }
      if (subAgentIds.size && snap.session_id && subAgentIds.has(normalizeSessionId(snap.session_id))) {
        return snap;
      }
    }
    return null;
  }

  function getAgyTranscriptIdleCompletionHintForTracking(ideTracking, options = {}) {
    if (!ideTracking || (ideTracking.provider !== 'gemini' && ideTracking.provider !== 'gemini_cli')) return null;
    const transcriptPath = normalizeTranscriptPath(ideTracking.transcript_path);
    if (!isAntigravityTranscriptPath(transcriptPath)) return null;

    const matches = snapshotsMatchingRun(ideTracking);
    const snap = matches[0];
    if (!snap) return null;

    const partialStopAtMs = Date.parse(snap.agy_last_partial_stop_at || '') || 0;
    if (!partialStopAtMs) return null;

    const linkedAtMs = Date.parse(ideTracking.linked_at || '') || 0;
    if (linkedAtMs && partialStopAtMs <= linkedAtMs) return null;

    const inflightToolCall = snap.agy_inflight_tool_step != null;
    const inflightSinceMs = Date.parse(snap.agy_inflight_tool_at || '') || 0;

    // Cascade-wide quiescence: how long the WHOLE tree (parent + every sub-agent) is busy until —
    // last activity, scheduled wakeups, and a grace for any sub-agent mid-tool — so the clear only
    // fires once everything has gone quiet (not just the parent, which goes quiet while waiting on
    // a sub-agent, and not during a sub-agent's silent in-flight tool gap).
    const subAgentIds = Array.isArray(options.subAgentIds) ? options.subAgentIds : [];
    const { treeBusyUntilMs, scheduledWakeupMs, anyPending } = aggregateCascadeSignals(snap, subAgentIds);

    const hint = evaluateAgyTranscriptIdleCompletion({
      partialStopAtMs,
      treeLastActivityMs: treeBusyUntilMs,
      scheduledWakeupAtMs: scheduledWakeupMs,
      inflightToolCall,
      inflightSinceMs,
      questionPending: anyPending,
      permissionPending: false,
      nowMs: options.nowMs ?? Date.now(),
      quiescenceMs: options.quiescenceMs,
      inflightMaxMs: options.inflightMaxMs,
    });
    if (!hint) return null;

    return {
      ...hint,
      session_id: snap.session_id || ideTracking.session_id || '',
      transcript_path: snap.transcript_path || transcriptPath,
      remote_host: snap.remote_host || ideTracking.host || '',
      generating: false,
      completion_hint: true,
    };
  }

  return {
    getToken: () => token,
    verifyToken,
    ingestEvent,
    listSnapshots,
    getActiveGenerationForTracking,
    getPickerGenerationHintForRun,
    getCompletionHintForTracking,
    getPermissionPendingHintForTracking,
    getQuestionPendingHintForTracking,
    getGateResolutionHintForTracking,
    getCancelHintForTracking,
    getAgyTranscriptIdleCompletionHintForTracking,
    getConversationSignals,
    cascadeHasRecentActivity,
    snapshotsMatchingRun,
    prune,
  };
}

module.exports = {
  createGeminiHookStore,
  normalizeSessionId,
  normalizeEventName,
  GEMINI_TOOL_PERMISSION_NOTIFICATION_TYPE: 'ToolPermission',
  deriveAgySnapshotFlags,
};
