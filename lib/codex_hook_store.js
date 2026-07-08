const crypto = require('crypto');
const {
  codexPromptPreviewFromText,
  isCodexAutomationToolName,
  codexHeartbeatScheduleFromRrule,
  codexHeartbeatHoldsDone,
} = require('./codex_tracker');

const VALID_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop',
  // Worker lifecycle (current Codex engines POST these for spawn_agent workers). They are neutral
  // to the parent session row's generating/completion state; their job is opening/closing the
  // worker in the sub-agent hold (SubagentStop = a hook-native worker end signal).
  'SubagentStart',
  'SubagentStop',
]);

const GENERATING_EVENTS = new Set([
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
]);

// Codex's "question" gate is the request_user_input tool: codex emits NO PermissionRequest for it
// (that hook is only for exec/patch approvals), so the gate shows up as a PreToolUse for this tool.
// Its matching PostToolUse is the answer landing. We treat the PreToolUse as a needs-input gate (like
// PermissionRequest) so Orchestra surfaces "question" instead of sailing past it as routine tool work.
const CODEX_QUESTION_TOOL = 'request_user_input';

// Sub-agent hooks carry the sub-agent's id in the body (agent_id) but the PARENT's session_id, and
// sub-agent turns emit NO Stop hook. A parent Stop while a sub-agent is still working must therefore
// hold the done-clear (the subagent-outlives-parent false clear). "Still working", from hooks alone:
//   - a tool call in flight (PreToolUse without its PostToolUse), unless it has been silent so long
//     it reads as a stuck/daemon command (INFLIGHT_STUCK), or
//   - any hook activity within the quiet window (covers think-time gaps between tool calls; observed
//     gaps run up to ~20s on slow models, so 30s with margin).
// The precise release is the parent transcript's <subagent_notification> (checked by the watch
// poller); this hooks-only view is the push-path hold and the quiet backstop when no notification
// ever arrives.
const CODEX_SUBAGENT_QUIET_MS = 30_000;
const CODEX_SUBAGENT_INFLIGHT_STUCK_MS = 120_000;

function codexSubagentIsOpen(agent, nowMs) {
  if (!agent) return false;
  if (agent.stopped_ms) return false; // SubagentStop = hook-native worker end
  const lastMs = Number(agent.last_ms) || 0;
  const age = (Number.isFinite(nowMs) ? nowMs : Date.now()) - lastMs;
  const openCalls = Number(agent.open_call_count ?? (agent.open_calls ? agent.open_calls.size : 0)) || 0;
  if (openCalls > 0 && age < CODEX_SUBAGENT_INFLIGHT_STUCK_MS) return true;
  return age < CODEX_SUBAGENT_QUIET_MS;
}

function isCodexQuestionGateEvent(eventName, toolName) {
  return eventName === 'PreToolUse' && toolName === CODEX_QUESTION_TOOL;
}

const MAX_VALUE_CHARS = 4000;

function normalizeSessionId(id) {
  if (typeof id !== 'string') return '';
  return id.trim();
}

function normalizeTranscriptPath(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizePromptPreview(input, maxWords = 10) {
  if (typeof input !== 'string') return '';
  return codexPromptPreviewFromText(input, maxWords);
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
  if (raw[0] === raw[0].toLowerCase()) return raw.charAt(0).toUpperCase() + raw.slice(1);
  return raw;
}

function truncateString(value, max = MAX_VALUE_CHARS) {
  const text = String(value || '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
}

function truncateDeep(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return truncateString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 4) return truncateString(JSON.stringify(value));
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => truncateDeep(item, depth + 1));
  if (typeof value !== 'object') return truncateString(String(value));
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 80)) {
    out[key] = truncateDeep(item, depth + 1);
  }
  return out;
}

function generatingFromEvent(eventName, row, toolName) {
  if (eventName === 'Stop' || eventName === 'PermissionRequest') return false;
  // The question gate's open edge means the agent stopped to ask you — NOT generating (mirrors
  // PermissionRequest). The matching PostToolUse stays a normal tool-complete (generating=true),
  // which is exactly what resumes the paused watch once you answer.
  if (isCodexQuestionGateEvent(eventName, toolName)) return false;
  if (GENERATING_EVENTS.has(eventName)) return true;
  return !!row?.generating;
}

function samePromptPreview(existing, nextPreview) {
  const prev =
    (typeof existing?.last_user_preview === 'string' && existing.last_user_preview.trim()) ||
    (typeof existing?.prompt_preview === 'string' && existing.prompt_preview.trim()) ||
    '';
  const next = typeof nextPreview === 'string' ? nextPreview.trim() : '';
  return !!prev && !!next && prev === next;
}

/** Whether this session row should carry a Stop-style completion hint for watch clearing. */
function completionHintFromEvent(eventName, row, promptPreview, toolName) {
  if (eventName === 'Stop' || eventName === 'PermissionRequest') return true;
  // The question gate's open edge is a stopping point (waiting on you), so it must carry a completion
  // hint like PermissionRequest — otherwise applyCodexHookCompletion skips it and the gate is lost.
  if (isCodexQuestionGateEvent(eventName, toolName)) return true;
  if (eventName === 'SessionStart' || eventName === 'UserPromptSubmit') {
    if (row?.completion_hint && samePromptPreview(row, promptPreview)) return true;
    return false;
  }
  if (GENERATING_EVENTS.has(eventName)) return false;
  return !!row?.completion_hint;
}

function createCodexHookStore(options = {}) {
  const token = options.token || crypto.randomBytes(24).toString('hex');
  /** @type {Map<string, object>} */
  const bySessionId = new Map();
  /** @type {Map<string, Map<string, {agent_id: string, first_ms: number, last_ms: number, open_calls: Set<string>}>>} */
  const subagentsByKey = new Map();
  // Per-session pending self-scheduled heartbeat (see the automation handling in ingestEvent).
  const heartbeatByKey = new Map();
  let seq = 0;

  function verifyToken(req) {
    const header = typeof req.get === 'function' ? req.get('x-codex-hook-token') : null;
    const bodyToken = req.body && typeof req.body === 'object' ? req.body.token : undefined;
    const queryToken = req.query && typeof req.query === 'object' ? req.query.token : undefined;
    const t = header || bodyToken || queryToken;
    return typeof t === 'string' && t === token;
  }

  function ingestEvent(body = {}, opts = {}) {
    const eventName = normalizeEventName(body);
    if (!eventName || !VALID_EVENTS.has(eventName)) {
      return {
        ok: false,
        error: `event_name must be one of: ${[...VALID_EVENTS].join(', ')}`,
      };
    }

    let sessionId = normalizeSessionId(body.session_id || body.sessionId);
    let transcriptPath = normalizeTranscriptPath(body.transcript_path || body.transcriptPath);
    const turnId = typeof body.turn_id === 'string' ? body.turn_id.trim() : '';
    const key0 = sessionId || transcriptPath || turnId;
    if (!key0) return { ok: false, error: 'session_id, transcript_path, or turn_id is required' };

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
    if (!transcriptPath && existing?.transcript_path) {
      transcriptPath = normalizeTranscriptPath(existing.transcript_path);
    }
    const key = sessionId || transcriptPath || turnId;
    if (key !== key0) {
      existing = bySessionId.get(key) || existing;
    }
    const row = bySessionId.get(key) || existing;

    const toolInput = body.tool_input && typeof body.tool_input === 'object' ? body.tool_input : null;
    const toolResponse = body.tool_response && typeof body.tool_response === 'object' ? body.tool_response : null;
    const promptPreview = normalizePromptPreview(body.prompt || body.prompt_preview || '');
    // Honor an injected clock (opts.nowMs) so signal_replay can stamp updated_at on its virtual clock;
    // without it every replayed hook is stamped at the rapid real ingest time and clusters at ~now,
    // collapsing the spacing the completion-hint vs linked_at comparison relies on (multi-gate runs
    // then detect only the first gate). Live callers pass no opts → real wall-clock, unchanged.
    const nowMsVal = Number.isFinite(opts.nowMs) ? Number(opts.nowMs) : Date.now();
    const now = new Date(nowMsVal).toISOString();
    seq += 1;

    // Sub-agent activity (body.agent_id): track per-agent last activity and in-flight tool calls
    // under the session key so a parent Stop can be held while a sub-agent is still working.
    const trackSubagent = (id) => {
      let agents = subagentsByKey.get(key);
      if (!agents) {
        agents = new Map();
        subagentsByKey.set(key, agents);
      }
      let agent = agents.get(id);
      if (!agent) {
        agent = { agent_id: id, first_ms: nowMsVal, last_ms: nowMsVal, open_calls: new Set() };
        agents.set(id, agent);
      }
      agent.last_ms = nowMsVal;
      return agent;
    };
    const agentId =
      (typeof body.agent_id === 'string' && body.agent_id.trim()) ||
      (typeof body.agentId === 'string' && body.agentId.trim()) ||
      '';
    if (agentId) {
      const agent = trackSubagent(agentId);
      const toolUseId = typeof body.tool_use_id === 'string' ? body.tool_use_id.trim() : '';
      if (toolUseId) {
        if (eventName === 'PreToolUse') agent.open_calls.add(toolUseId);
        else if (eventName === 'PostToolUse') agent.open_calls.delete(toolUseId);
      }
      if (eventName === 'SubagentStop') {
        agent.stopped_ms = nowMsVal;
        agent.open_calls.clear();
      } else if (eventName === 'SubagentStart') {
        // A re-started worker id (rare) re-opens.
        agent.stopped_ms = 0;
      }
    }
    // Self-scheduled wakeup (heartbeat) automation: a Stop that lands while an ACTIVE near-future
    // heartbeat is pending must hold done — the agent yielded to its own scheduler, it did not
    // finish (codex-desktop background-wakeup false-clear). tool_input carries the same fields
    // the rollout arguments do; the wake (or any new user turn — UserPromptSubmit) consumes it,
    // and a delete/pause/update from the model releases it.
    const automationToolName = typeof body.tool_name === 'string' ? body.tool_name.trim() : '';
    if ((eventName === 'PreToolUse' || eventName === 'PostToolUse') && isCodexAutomationToolName(automationToolName) && toolInput) {
      const mode = String(toolInput.mode || '').toLowerCase();
      const kind = String(toolInput.kind || '').toLowerCase();
      if (mode === 'create' && kind === 'heartbeat') {
        const schedule = codexHeartbeatScheduleFromRrule(String(toolInput.rrule || ''));
        heartbeatByKey.set(key, {
          created_ms: nowMsVal,
          fire_at_ms: schedule.fire_at_ms,
          period_ms: schedule.period_ms,
          id: String(toolInput.id || '').trim(),
          name: String(toolInput.name || '').trim(),
        });
      } else if (mode && mode !== 'create') {
        // delete/pause/update of a PENDING heartbeat = the model changed its plan mid-turn —
        // release the hold. During the WAKE turn (consumed) the same op is just cleanup of the
        // fired automation: the wake-active marker must survive until the wake turn's Stop, or
        // a stale transcript snapshot clears the watch seconds before the real finish.
        const hb = heartbeatByKey.get(key);
        if (hb && !hb.consumed_ms) heartbeatByKey.delete(key);
      }
    }
    if (eventName === 'UserPromptSubmit' && heartbeatByKey.has(key)) {
      // The heartbeat-fired wake (or a fresh human turn) landed — the new turn governs tracking.
      // Keep the entry, marked consumed: while the wake turn runs, a STALE transcript snapshot
      // (frozen at the pre-wake task_complete — the desktop capture-shape residual) must not
      // clear the watch through the transcript fallback (isCodexHeartbeatWakeActive).
      const hb = heartbeatByKey.get(key);
      if (!hb.consumed_ms) heartbeatByKey.set(key, { ...hb, consumed_ms: nowMsVal });
    }
    if (eventName === 'Stop' && heartbeatByKey.has(key)) {
      const hb = heartbeatByKey.get(key);
      if (hb.consumed_ms) {
        // The wake turn ended — its own Stop is the session's real terminal; drop the marker.
        heartbeatByKey.delete(key);
      } else if (!hb.hold_started_ms) {
        // The YIELD: the hold window is anchored here (codex defers the heartbeat's delivery
        // until the turn ends, so the wake lag is measured from this Stop — a heartbeat created
        // early in a long turn must not have its window pre-expired by the working time).
        heartbeatByKey.set(key, { ...hb, hold_started_ms: nowMsVal });
      }
    }

    // A spawn_agent PostToolUse registers the spawned worker itself (tool_response carries its
    // agent_id). A HOOKLESS worker — one that never calls a tool — otherwise emits no hooks at all,
    // so this registration is the only reason the parent's Stop is held while it works. last_ms =
    // spawn time; the worker stays "open" through the quiet window unless its notification (poller
    // path) or its own hooks close it.
    const spawnToolName = typeof body.tool_name === 'string' ? body.tool_name.trim() : '';
    if (eventName === 'PostToolUse' && spawnToolName === 'spawn_agent') {
      let response = body.tool_response;
      if (typeof response === 'string') {
        try { response = JSON.parse(response); } catch { response = null; }
      }
      const spawnedId =
        (response && typeof response === 'object' &&
          ((typeof response.agent_id === 'string' && response.agent_id.trim()) ||
            (typeof response.agentId === 'string' && response.agentId.trim()))) ||
        '';
      if (spawnedId) trackSubagent(spawnedId);
    }

    // THIS event's tool (not the carried-over row's) — drives question-gate detection below.
    const eventToolName = typeof body.tool_name === 'string' ? body.tool_name.trim() : '';
    let generating = generatingFromEvent(eventName, row, eventToolName);
    const completion_hint = completionHintFromEvent(eventName, row, promptPreview, eventToolName);
    if (
      completion_hint &&
      (eventName === 'UserPromptSubmit' || eventName === 'SessionStart') &&
      row?.completion_hint &&
      samePromptPreview(row, promptPreview)
    ) {
      generating = false;
    }

    const snapshot = {
      provider: 'codex',
      event_id: `${Date.now()}-${seq}`,
      event_name: eventName,
      session_id: sessionId || row?.session_id || '',
      turn_id: turnId || row?.turn_id || '',
      transcript_path: transcriptPath || row?.transcript_path || '',
      workspace_path:
        typeof body.workspace_path === 'string'
          ? body.workspace_path
          : typeof body.cwd === 'string'
            ? body.cwd
            : row?.workspace_path || '',
      model: typeof body.model === 'string' ? body.model : row?.model || '',
      permission_mode:
        typeof body.permission_mode === 'string' ? body.permission_mode : row?.permission_mode || '',
      source: typeof body.source === 'string' ? body.source : row?.source || '',
      remote_host:
        typeof body.remote_host === 'string'
          ? body.remote_host.trim()
          : row?.remote_host || '',
      prompt_preview: promptPreview || row?.prompt_preview || '',
      last_user_preview:
        eventName === 'UserPromptSubmit' && promptPreview
          ? promptPreview
          : row?.last_user_preview || promptPreview || '',
      tool_name: typeof body.tool_name === 'string' ? body.tool_name : row?.tool_name || '',
      tool_use_id: typeof body.tool_use_id === 'string' ? body.tool_use_id : row?.tool_use_id || '',
      tool_input: toolInput != null ? truncateDeep(toolInput) : row?.tool_input ?? null,
      tool_response: toolResponse != null ? truncateDeep(toolResponse) : row?.tool_response ?? null,
      stop_hook_active:
        typeof body.stop_hook_active === 'boolean' ? body.stop_hook_active : row?.stop_hook_active ?? null,
      last_assistant_message:
        typeof body.last_assistant_message === 'string'
          ? truncateString(body.last_assistant_message)
          : row?.last_assistant_message || '',
      generating,
      completion_hint,
      updated_at: now,
      raw_payload: truncateDeep(body),
    };

    bySessionId.set(key, snapshot);
    return { ok: true, snapshot };
  }

  function listSnapshots() {
    return [...bySessionId.values()].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  }

  function getCompletionHintForTracking(ideTracking) {
    if (!ideTracking || ideTracking.provider !== 'codex') return null;
    const wantedSession = normalizeSessionId(ideTracking.session_id);
    const wantedTranscript = normalizeTranscriptPath(ideTracking.transcript_path);
    const linkedAtMs = Date.parse(ideTracking.linked_at || '') || 0;
    for (const snap of bySessionId.values()) {
      if (!snap.completion_hint) continue;
      if (linkedAtMs && (Date.parse(snap.updated_at || '') || 0) <= linkedAtMs) continue;
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

  // Sub-agent activity for a watch/snapshot (matched by session_id, transcript_path fallback).
  // Returns { agents: [{ agent_id, first_ms, last_ms, open_call_count }] } — [] when none seen.
  function getSubagentActivity(tracking) {
    const wantedSession = normalizeSessionId(tracking?.session_id);
    const wantedTranscript = normalizeTranscriptPath(tracking?.transcript_path);
    let agents = wantedSession ? subagentsByKey.get(wantedSession) : null;
    if (!agents) {
      for (const [key, snap] of bySessionId.entries()) {
        const sessionMatch = wantedSession && normalizeSessionId(snap.session_id) === wantedSession;
        const transcriptMatch =
          wantedTranscript && normalizeTranscriptPath(snap.transcript_path) === wantedTranscript;
        if ((sessionMatch || transcriptMatch) && subagentsByKey.has(key)) {
          agents = subagentsByKey.get(key);
          break;
        }
      }
    }
    if (!agents || !agents.size) return { agents: [] };
    return {
      agents: [...agents.values()].map((a) => ({
        agent_id: a.agent_id,
        first_ms: a.first_ms,
        last_ms: a.last_ms,
        open_call_count: a.open_calls.size,
        stopped_ms: a.stopped_ms || 0,
      })),
    };
  }

  // Hooks-only view for the push-path hold: is ANY sub-agent of this session still working
  // (in-flight call or activity inside the quiet window)? Notifications (transcript) are not
  // visible here — the watch poller applies them; this only defers the instant Stop-clear.
  function hasOpenSubagentWork(tracking, opts = {}) {
    const nowMs = Number.isFinite(opts.nowMs) ? Number(opts.nowMs) : Date.now();
    return getSubagentActivity(tracking).agents.some((a) => codexSubagentIsOpen(a, nowMs));
  }

  function heartbeatForTracking(tracking) {
    const wantedSession = normalizeSessionId(tracking?.session_id);
    const wantedTranscript = normalizeTranscriptPath(tracking?.transcript_path);
    let hb = wantedSession ? heartbeatByKey.get(wantedSession) : null;
    if (!hb) {
      for (const [key, snap] of bySessionId.entries()) {
        const sessionMatch = wantedSession && normalizeSessionId(snap.session_id) === wantedSession;
        const transcriptMatch =
          wantedTranscript && normalizeTranscriptPath(snap.transcript_path) === wantedTranscript;
        if ((sessionMatch || transcriptMatch) && heartbeatByKey.has(key)) {
          hb = heartbeatByKey.get(key);
          break;
        }
      }
    }
    return hb || null;
  }

  // Hooks-only view of the heartbeat hold (the push-path analog of hasOpenSubagentWork): is a
  // near-future self-scheduled heartbeat still pending for this session? Held until the wake's
  // UserPromptSubmit consumes it or its DTSTART + grace lapses (bounded — an app quit can't
  // hold forever).
  function hasPendingHeartbeat(tracking, opts = {}) {
    const nowMs = Number.isFinite(opts.nowMs) ? Number(opts.nowMs) : Date.now();
    const hb = heartbeatForTracking(tracking);
    if (!hb || hb.consumed_ms) return false;
    // No explicit yield here: the anchor chain inside codexHeartbeatHoldsDone uses the
    // hold_started_ms stamped by the yield Stop's ingest (which runs before this hold is
    // consulted on the push path), falling back to created_ms pre-Stop.
    return codexHeartbeatHoldsDone(hb, 0, nowMs);
  }

  // The heartbeat's WAKE turn is in flight: the wake consumed the pending heartbeat and the
  // session has not Stopped since. While true, a transcript-fallback 'done' is stale evidence
  // (the snapshot predates the wake — the desktop capture-shape residual) and must not clear
  // the watch; the wake turn's own Stop clears via the hint path. Bounded by the hold horizon
  // so a lost wake-Stop can't suppress the fallback forever.
  function isHeartbeatWakeActive(tracking, opts = {}) {
    const nowMs = Number.isFinite(opts.nowMs) ? Number(opts.nowMs) : Date.now();
    const hb = heartbeatForTracking(tracking);
    if (!hb || !hb.consumed_ms) return false;
    return nowMs - hb.consumed_ms < 10 * 60_000;
  }

  return {
    getToken: () => token,
    verifyToken,
    ingestEvent,
    listSnapshots,
    getCompletionHintForTracking,
    getSubagentActivity,
    hasOpenSubagentWork,
    hasPendingHeartbeat,
    isHeartbeatWakeActive,
  };
}

module.exports = {
  VALID_EVENTS,
  GENERATING_EVENTS,
  CODEX_QUESTION_TOOL,
  CODEX_SUBAGENT_QUIET_MS,
  CODEX_SUBAGENT_INFLIGHT_STUCK_MS,
  codexSubagentIsOpen,
  isCodexQuestionGateEvent,
  createCodexHookStore,
  normalizeEventName,
  normalizeSessionId,
  generatingFromEvent,
  completionHintFromEvent,
  samePromptPreview,
};
