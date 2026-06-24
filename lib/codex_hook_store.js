const crypto = require('crypto');
const { codexPromptPreviewFromText } = require('./codex_tracker');

const VALID_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop',
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
    const now = Number.isFinite(opts.nowMs) ? new Date(opts.nowMs).toISOString() : new Date().toISOString();
    seq += 1;

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

  return {
    getToken: () => token,
    verifyToken,
    ingestEvent,
    listSnapshots,
    getCompletionHintForTracking,
  };
}

module.exports = {
  VALID_EVENTS,
  GENERATING_EVENTS,
  CODEX_QUESTION_TOOL,
  isCodexQuestionGateEvent,
  createCodexHookStore,
  normalizeEventName,
  normalizeSessionId,
  generatingFromEvent,
  completionHintFromEvent,
  samePromptPreview,
};
