const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { truncateCleanHumanPromptPreview } = require('./human_prompt_preview');
const { applyActiveGenerationStaleCutoff, toIso } = require('./active_generation');
const {
  CAPS,
  clamp,
  clampBlock,
  normalizeQuestions,
  normalizeAnswers,
  summarizeToolInput,
} = require('./live_turn_normalizer');

const DEFAULT_MAX_RUNS = 20;
const DEFAULT_TAIL_BYTES = 1024 * 1024;
const DEFAULT_MAIN_LOG_TAIL_BYTES = 512 * 1024;
const COWORK_ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

function getClaudeCoworkRoot(homeDir = os.homedir()) {
  return path.resolve(
    path.join(homeDir, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions')
  );
}

function getClaudeMainLogPath(homeDir = os.homedir()) {
  return path.resolve(path.join(homeDir, 'Library', 'Logs', 'Claude', 'main.log'));
}

function assertAllowedCoworkAuditPath(auditPath, homeDir = os.homedir()) {
  if (typeof auditPath !== 'string' || !auditPath.trim()) {
    throw new Error('audit_path is required');
  }
  const resolved = path.resolve(auditPath.trim());
  const allowedRoot = getClaudeCoworkRoot(homeDir);
  const prefix = allowedRoot.endsWith(path.sep) ? allowedRoot : `${allowedRoot}${path.sep}`;
  if (resolved !== allowedRoot && !resolved.startsWith(prefix)) {
    throw new Error('audit_path must be under Claude local-agent-mode-sessions');
  }
  if (path.basename(resolved) !== 'audit.jsonl') {
    throw new Error('audit_path must be an audit.jsonl file');
  }
  if (!path.basename(path.dirname(resolved)).startsWith('local_')) {
    throw new Error('audit_path must be inside a local_* Cowork session directory');
  }
  return resolved;
}

function getCoworkSessionIdFromAuditPath(auditPath) {
  return path.basename(path.dirname(auditPath));
}

function getLocalJsonPathForAuditPath(auditPath) {
  return `${path.dirname(auditPath)}.json`;
}

function walkCoworkAuditFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkCoworkAuditFiles(p));
    } else if (entry.isFile() && entry.name === 'audit.jsonl' && path.basename(path.dirname(p)).startsWith('local_')) {
      out.push(p);
    }
  }
  return out;
}

async function readTailText(filePath, maxBytes = DEFAULT_TAIL_BYTES) {
  let st;
  try {
    st = await fsp.stat(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
  const start = Math.max(0, st.size - maxBytes);
  const len = st.size - start;
  if (len <= 0) return '';
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0 && text.length) {
      const nl = text.indexOf('\n');
      if (nl !== -1) text = text.slice(nl + 1);
    }
    return text;
  } finally {
    await fh.close();
  }
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.text === 'string') parts.push(item.text);
    if (typeof item.content === 'string') parts.push(item.content);
    if (Array.isArray(item.content)) parts.push(contentToText(item.content));
  }
  return parts.join(' ');
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function hasToolResultContent(content) {
  return Array.isArray(content) && content.some((item) => item && typeof item === 'object' && item.type === 'tool_result');
}

function getMessageContent(obj) {
  return obj && obj.message && typeof obj.message === 'object' ? obj.message.content : null;
}

function getHumanUserText(obj) {
  if (!obj || obj.type !== 'user') return '';
  const content = getMessageContent(obj);
  if (hasToolResultContent(content)) return '';
  if (obj.parent_tool_use_id || obj.tool_use_result != null) return '';
  return compactText(contentToText(content) || obj.prompt || '');
}

function parseJsonlLines(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Ignore partial or malformed lines; Cowork keeps appending JSONL while running.
    }
  }
  return out;
}

function latestCoworkUserPreviewFromTail(tailText, maxWords = 10) {
  const events = parseJsonlLines(tailText);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const raw = getHumanUserText(events[i]);
    const preview = truncateCleanHumanPromptPreview(raw, maxWords);
    if (preview) return preview;
  }
  return '';
}

function eventTimeMs(obj) {
  return (
    Date.parse(obj?._audit_timestamp || '') ||
    Date.parse(obj?.timestamp || '') ||
    Date.parse(obj?.message?.timestamp || '') ||
    0
  );
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseClaudeMainLogLineTimeMs(line) {
  const match = String(line || '').match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\b/);
  if (!match) return 0;
  return Date.parse(match[1].replace(' ', 'T'));
}

function isCompletedCoworkResult(obj) {
  if (!obj || obj.type !== 'result') return false;
  const subtype = typeof obj.subtype === 'string' ? obj.subtype.trim().toLowerCase() : '';
  const terminalReason = typeof obj.terminal_reason === 'string' ? obj.terminal_reason.trim().toLowerCase() : '';
  const stopReason = typeof obj.stop_reason === 'string' ? obj.stop_reason.trim().toLowerCase() : '';
  return (
    subtype === 'success' &&
    terminalReason === 'completed' &&
    stopReason === 'end_turn' &&
    obj.is_error === false
  );
}

function isCoworkRateLimitRejection(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.type === 'rate_limit_event') {
    const info = obj.rate_limit_info && typeof obj.rate_limit_info === 'object' ? obj.rate_limit_info : {};
    return String(info.status || '').trim().toLowerCase() === 'rejected';
  }
  if (obj.type === 'assistant' && String(obj.error || '').trim().toLowerCase() === 'rate_limit') {
    return true;
  }
  if (obj.type !== 'result') return false;
  const resultText = compactText(obj.result || contentToText(obj.message?.content || []));
  return (
    obj.is_error === true &&
    (obj.api_error_status === 429 ||
      /rate[_ -]?limit/i.test(String(obj.error || '')) ||
      /session limit|rate limit/i.test(resultText))
  );
}

const COWORK_CANCEL_TERMINAL_REASONS = new Set(['cancelled', 'canceled', 'aborted', 'interrupted', 'stopped']);

/** A result whose turn was cancelled/aborted/interrupted by the user (not a clean finish). */
function isCoworkCancelledResult(obj) {
  if (!obj || obj.type !== 'result') return false;
  const terminalReason = typeof obj.terminal_reason === 'string' ? obj.terminal_reason.trim().toLowerCase() : '';
  const stopReason = typeof obj.stop_reason === 'string' ? obj.stop_reason.trim().toLowerCase() : '';
  return COWORK_CANCEL_TERMINAL_REASONS.has(terminalReason) || COWORK_CANCEL_TERMINAL_REASONS.has(stopReason);
}

function claudeMainLogHasCoworkStopForSession(text, sessionId, linkedAtIso = '') {
  const id = String(sessionId || '').trim();
  if (!id) return false;
  const linkedAtMs = Date.parse(linkedAtIso || '') || 0;
  const idRe = escapeRegExp(id);
  const explicitStopRe = new RegExp(`\\bLocalAgentModeSessions\\.stop: sessionId=${idRe}\\b`);
  const lifecycleStopRe = new RegExp(`\\[Lifecycle\\] Session ${idRe}: running\\s+(?:→|->)\\s+stopping\\b`);
  for (const line of String(text || '').split('\n')) {
    if (!explicitStopRe.test(line) && !lifecycleStopRe.test(line)) continue;
    const ts = parseClaudeMainLogLineTimeMs(line);
    if (linkedAtMs && ts && ts < linkedAtMs) continue;
    if (linkedAtMs && !ts) continue;
    return true;
  }
  return false;
}

async function claudeCoworkMainLogCancelledSince(auditPath, linkedAtIso, options = {}) {
  const resolved = options.skipPathValidation ? auditPath : assertAllowedCoworkAuditPath(auditPath, options.homeDir);
  const sessionId = getCoworkSessionIdFromAuditPath(resolved);
  const logPath = options.mainLogPath || getClaudeMainLogPath(options.homeDir || os.homedir());
  const text = await readTailText(logPath, options.mainLogMaxBytes || DEFAULT_MAIN_LOG_TAIL_BYTES);
  return claudeMainLogHasCoworkStopForSession(text, sessionId, linkedAtIso);
}

/** Cowork blocks when any tool requires user permission (audit permission_request). */
function isCoworkAskUserQuestionPermissionRequest(obj) {
  if (!obj || obj.type !== 'system' || obj.subtype !== 'permission_request') return false;
  return true;
}

// The Cowork audit records BOTH a structured question and a tool-permission prompt under the same
// `permission_request` subtype, but the record carries `tool_name`: `AskUserQuestion` ⇒ a question
// gate, anything else (mcp__*, browser:*, computer:*, …) ⇒ a tool-permission gate. This is the
// distinguisher Lane D verified against 273 on-disk audits (72 AskUserQuestion / 262 permission).
// Equivalently the preceding assistant tool_use.name — but the gate record is authoritative.
function coworkPermissionRequestGateKind(obj) {
  const toolName = obj && typeof obj.tool_name === 'string' ? obj.tool_name.trim() : '';
  return toolName === COWORK_ASK_USER_QUESTION_TOOL ? 'question' : 'permission';
}

function isCoworkPermissionResponse(obj) {
  return obj != null && obj.type === 'system' && obj.subtype === 'permission_response';
}

function classifyCoworkActiveGenerationFromText(raw, options = {}) {
  let generating = false;
  let startMs = 0;
  let lastMs = Number.isFinite(options.mtimeMs) ? options.mtimeMs : 0;
  let inactiveReason = 'no_start_signal';

  for (const obj of parseJsonlLines(raw)) {
    const ts = eventTimeMs(obj);
    if (ts) lastMs = ts;
    const preview = truncateCleanHumanPromptPreview(getHumanUserText(obj), 10);
    if (preview) {
      generating = true;
      startMs = ts || lastMs || startMs;
      lastMs = ts || lastMs;
      inactiveReason = '';
      continue;
    }
    if (isCompletedCoworkResult(obj)) {
      generating = false;
      inactiveReason = 'completion_signal';
      continue;
    }
    if (isCoworkCancelledResult(obj)) {
      generating = false;
      inactiveReason = 'cancelled';
      continue;
    }
    if (isCoworkRateLimitRejection(obj)) {
      generating = false;
      inactiveReason = 'rate_limit';
      continue;
    }
    if (isCoworkAskUserQuestionPermissionRequest(obj)) {
      generating = false;
      inactiveReason = 'awaiting_user_input';
      continue;
    }
    if (isCoworkPermissionResponse(obj)) {
      generating = true;
      startMs = ts || lastMs || startMs;
      lastMs = ts || lastMs;
      inactiveReason = '';
      continue;
    }
  }

  return applyActiveGenerationStaleCutoff(
    {
      generating,
      start_signal_at: toIso(startMs),
      last_activity_at: toIso(lastMs),
      inactive_reason: inactiveReason,
    },
    options
  );
}

async function readLocalJsonMetadata(auditPath) {
  const localJsonPath = getLocalJsonPathForAuditPath(auditPath);
  try {
    const json = JSON.parse(await fsp.readFile(localJsonPath, 'utf8'));
    return {
      local_json_path: localJsonPath,
      title: typeof json.title === 'string' ? json.title.trim() : '',
      // cwd is the sandbox's per-session outputs dir, NOT the folder the user picked.
      workspace_path: typeof json.cwd === 'string' ? json.cwd : '',
      // The "Working folders" shown in the Cowork UI — absolute paths the user attached.
      working_folders: Array.isArray(json.userSelectedFolders)
        ? json.userSelectedFolders.filter((f) => typeof f === 'string' && f.trim())
        : [],
      updated_at:
        Number.isFinite(json.lastActivityAt) && json.lastActivityAt > 0
          ? new Date(json.lastActivityAt).toISOString()
          : '',
      initial_message: typeof json.initialMessage === 'string' ? json.initialMessage : '',
    };
  } catch {
    return {
      local_json_path: '',
      title: '',
      workspace_path: '',
      working_folders: [],
      updated_at: '',
      initial_message: '',
    };
  }
}

async function discoverClaudeCoworkRuns(homeDir = os.homedir(), options = {}) {
  const root = options.root ? path.resolve(options.root) : getClaudeCoworkRoot(homeDir);
  const maxRuns = Number.isInteger(options.maxRuns) && options.maxRuns > 0 ? options.maxRuns : DEFAULT_MAX_RUNS;
  const auditPaths = walkCoworkAuditFiles(root);
  const runs = [];
  for (const auditPath of auditPaths) {
    let st;
    try {
      st = fs.statSync(auditPath);
    } catch {
      continue;
    }
    let tailText = '';
    try {
      tailText = await readTailText(auditPath, options.maxBytes || DEFAULT_TAIL_BYTES);
    } catch {
      tailText = '';
    }
    const meta = await readLocalJsonMetadata(auditPath);
    const sessionId = getCoworkSessionIdFromAuditPath(auditPath);
    runs.push({
      kind: 'ide_agent',
      provider: 'claude_cowork',
      source: 'local',
      session_id: sessionId,
      audit_path: auditPath,
      transcript_path: '',
      title: meta.title || '',
      workspace_path: meta.workspace_path || '',
      working_folders: meta.working_folders || [],
      updated_at: meta.updated_at || st.mtime.toISOString(),
      mtime_ms: st.mtimeMs || 0,
      last_user_preview:
        latestCoworkUserPreviewFromTail(tailText, 10) ||
        truncateCleanHumanPromptPreview(meta.initial_message, 10) ||
        sessionId,
      ...classifyCoworkActiveGenerationFromText(tailText, {
        mtimeMs: st.mtimeMs || 0,
        nowMs: options.nowMs,
        activeStaleMs: options.activeStaleMs,
      }),
    });
    if (options.useMainLogCancelSignal !== false) {
      try {
        const cancelled = await claudeCoworkMainLogCancelledSince(auditPath, runs[runs.length - 1].start_signal_at, {
          homeDir,
          mainLogPath: options.mainLogPath,
          mainLogMaxBytes: options.mainLogMaxBytes,
        });
        if (cancelled) {
          runs[runs.length - 1].generating = false;
          runs[runs.length - 1].inactive_reason = 'cancelled';
        }
      } catch {
        // Picker discovery should keep working even if Claude has rotated/removed its log.
      }
    }
  }
  runs.sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0));
  return runs.slice(0, maxRuns);
}

/**
 * @returns {''|'done'|'cancelled'|'permission'|'question'} reason the watch should clear (falsy =
 *   keep waiting). The Cowork audit records both a tool-permission prompt AND an AskUserQuestion
 *   under the same `permission_request` subtype; we split them by `tool_name`
 *   (coworkPermissionRequestGateKind) — `AskUserQuestion` ⇒ 'question', anything else ⇒
 *   'permission'. The watch_tracker cowork branch already accepts either (markHumanGateWatchClear),
 *   so `clear_gate` is now the honest gate kind and reportedGateKind reports it (Lane D un-fold).
 *   Rate-limit stops are treated as 'done' (not a question/permission you can answer).
 */
async function coworkTurnCompletedSince(auditPath, linkedAtIso, options = {}) {
  const resolved = options.skipPathValidation ? auditPath : assertAllowedCoworkAuditPath(auditPath, options.homeDir);
  const text = await readTailText(resolved, options.maxBytes || DEFAULT_TAIL_BYTES);
  const linkedAtMs = Date.parse(linkedAtIso || '') || 0;
  let reason = '';
  for (const obj of parseJsonlLines(text)) {
    const ts = eventTimeMs(obj);
    if (linkedAtMs && ts && ts < linkedAtMs) continue;
    if (linkedAtMs && !ts) continue;
    if (getHumanUserText(obj)) {
      reason = '';
      continue;
    }
    if (isCompletedCoworkResult(obj)) {
      reason = 'done';
      continue;
    }
    if (isCoworkRateLimitRejection(obj)) {
      reason = 'done';
      continue;
    }
    if (isCoworkCancelledResult(obj)) {
      reason = 'cancelled';
      continue;
    }
    if (isCoworkAskUserQuestionPermissionRequest(obj)) {
      reason = coworkPermissionRequestGateKind(obj);
      continue;
    }
    if (isCoworkPermissionResponse(obj)) {
      reason = '';
    }
  }
  if (!reason && options.useMainLogCancelSignal !== false) {
    try {
      if (await claudeCoworkMainLogCancelledSince(resolved, linkedAtIso, {
        ...options,
        skipPathValidation: true,
      })) {
        reason = 'cancelled';
      }
    } catch {
      // Keep the audit-based watcher resilient to missing/rotated Claude Desktop logs.
    }
  }
  return reason;
}

// Active-generation classification of a Cowork audit — used to detect that a paused
// (needs-input) watch has resumed (a permission_response after the AskUserQuestion).
async function coworkWatchActiveGenerationSince(auditPath, options = {}) {
  const resolved = options.skipPathValidation ? auditPath : assertAllowedCoworkAuditPath(auditPath, options.homeDir);
  let text = '';
  try {
    text = await readTailText(resolved, options.maxBytes || DEFAULT_TAIL_BYTES);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  return classifyCoworkActiveGenerationFromText(text, options);
}

/* ------------------------------------------------------------------ live feed
 * LiveTurnEvent parser (Lane D §2 seam) — turns the T3-capable Cowork audit into the same
 * normalized LiveTurnEvent stream the hook providers emit (lib/live_turn_normalizer.js schema), so
 * cowork's cell reflects what the audit actually carries instead of the lifecycle-only fold.
 *
 * PURE and incremental: `state` is the carry (pending assistant text, open tool_use ids, the open
 * gate, last prompt for echo-fold) so a bounded tail read can pick up mid-turn. NO disk I/O here —
 * lib/cowork_live_adapter.js owns the poll-guarded read + ring.append. DATA HONESTY: emit only what
 * the audit records carry; an absent field is absent, never a placeholder.
 */

// Multi-select answers arrive from Cowork in TWO shapes: the structured tool_use_result.answers
// (arrays for multi-select) and the tool_result content string of `"question"="answer"` pairs
// (multi-select comma-joined, e.g. `"Which suites…"="billing,auth"` — same convention as Claude's
// PostToolUse). Parse the string into a {question: answer|[answers]} map; a comma answer splits.
function parseCoworkQuestionAnswerPairs(text) {
  const out = {};
  let any = false;
  const re = /"([^"]+?)"\s*=\s*"([^"]*?)"/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const q = m[1];
    const a = m[2];
    if (!q) continue;
    out[q] = a.includes(',') ? a.split(',').map((s) => s.trim()).filter(Boolean) : a;
    any = true;
  }
  return any ? out : null;
}

function coworkAnswersFromToolResult(userRecord, block) {
  // Prefer the structured payload — it carries arrays for multi-select verbatim.
  const structured =
    userRecord && userRecord.tool_use_result && typeof userRecord.tool_use_result === 'object'
      ? userRecord.tool_use_result.answers
      : null;
  if (structured && typeof structured === 'object') {
    const norm = normalizeAnswers(structured);
    if (norm) return norm;
  }
  // Fallback: parse the tool_result content string of question="answer" pairs.
  const raw = block && typeof block.content === 'string' ? block.content : contentToText(block && block.content);
  const parsed = parseCoworkQuestionAnswerPairs(raw);
  return parsed ? normalizeAnswers(parsed) : null;
}

function coworkToolStartDetail(name, input) {
  if (name === COWORK_ASK_USER_QUESTION_TOOL) {
    const qs = input && Array.isArray(input.questions) ? input.questions : [];
    return qs.length ? `${qs.length} question${qs.length === 1 ? '' : 's'}` : '';
  }
  return summarizeToolInput(input);
}

/**
 * Parse a batch of already-JSON-parsed Cowork audit records into LiveTurnEvents. Mutates `state`
 * (the incremental carry) and returns { events }. Each event: { abs_ms, kind, ...payload } — the
 * ring assigns seq/t. Records must be in file order.
 */
function parseCoworkAuditRecords(records, state) {
  const st = state && typeof state === 'object' ? state : {};
  if (!st.openTools || typeof st.openTools !== 'object') st.openTools = {};
  const events = [];

  const flushPendingTextAsNote = () => {
    if (st.pendingText && st.pendingText.text) {
      events.push({ abs_ms: st.pendingText.abs_ms, kind: 'note', text: clamp(st.pendingText.text, CAPS.noteText) });
    }
    st.pendingText = null;
  };
  const emitMetaModel = (absMs, model) => {
    const m = typeof model === 'string' ? model.trim() : '';
    if (m && st.metaModel !== m) {
      st.metaModel = m;
      events.push({ abs_ms: absMs, kind: 'meta', model: m });
    }
  };

  for (const obj of Array.isArray(records) ? records : []) {
    if (!obj || typeof obj !== 'object') continue;
    if (obj.isReplay === true) continue; // a replayed record duplicates one we already saw
    const ts = eventTimeMs(obj) || st.lastTs || 0;
    if (ts) st.lastTs = ts;
    const type = obj.type;

    // The terminal result: the LAST assistant text before it is the stop (Cowork has no dedicated
    // last_assistant_message field). result.result echoes it — used only as a fallback.
    if (type === 'result') {
      const stopText = (st.pendingText && st.pendingText.text) || String(obj.result || '').trim();
      const stopAbs = (st.pendingText && st.pendingText.abs_ms) || ts;
      if (stopText) events.push({ abs_ms: stopAbs, kind: 'stop', text: clampBlock(stopText, CAPS.stopText) });
      st.pendingText = null;
      continue;
    }

    if (type === 'assistant') {
      const content = getMessageContent(obj);
      emitMetaModel(ts, obj.message && obj.message.model);
      const blocks = Array.isArray(content)
        ? content
        : typeof content === 'string' && content
          ? [{ type: 'text', text: content }]
          : [];
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') {
          const txt = typeof b.text === 'string' ? b.text.trim() : '';
          if (!txt) continue;
          flushPendingTextAsNote(); // a superseded text was mid-turn narration → a note
          st.pendingText = { text: txt, abs_ms: ts };
        } else if (b.type === 'tool_use') {
          flushPendingTextAsNote(); // narration precedes the tool call → a note
          const name = typeof b.name === 'string' ? b.name.trim() : '';
          if (!name) continue;
          events.push({ abs_ms: ts, kind: 'tool_start', name, detail: coworkToolStartDetail(name, b.input) });
          st.openTools[b.id || `#${name}`] = { name, start_ms: ts };
        }
      }
      continue;
    }

    // Any non-assistant, non-result record: a pending assistant text is now known to be mid-turn.
    flushPendingTextAsNote();

    if (type === 'user') {
      const content = getMessageContent(obj);
      if (hasToolResultContent(content)) {
        for (const b of content) {
          if (!b || typeof b !== 'object' || b.type !== 'tool_result') continue;
          const id = b.tool_use_id;
          const open = id != null && st.openTools[id] ? st.openTools[id] : null;
          const isErr = b.is_error === true;
          const g = st.pendingGate;
          const closesGate = g && (g.kind === 'question' || (open && open.name === g.tool_name) || !g.tool_name);
          if (closesGate) {
            const answered = { abs_ms: ts, kind: 'gate_answered', waited_ms: Math.max(0, ts - g.start_ms) };
            if (g.kind === 'question') {
              const answers = coworkAnswersFromToolResult(obj, b);
              if (answers) answered.answers = answers;
            }
            events.push(answered);
            events.push({
              abs_ms: ts, kind: 'tool_end',
              name: (open && open.name) || g.tool_name || COWORK_ASK_USER_QUESTION_TOOL,
              detail: '', ok: !isErr,
            });
            st.pendingGate = null;
            if (id != null) delete st.openTools[id];
          } else if (open) {
            events.push({ abs_ms: ts, kind: 'tool_end', name: open.name, detail: '', ok: !isErr });
            delete st.openTools[id];
          }
        }
        continue;
      }
      // A human prompt starts a new turn: wipe the carry (gates/steps never span prompts) and fold
      // an identical consecutive prompt (echo). Non-prompt user text (empty) is skipped.
      const promptRaw = getHumanUserText(obj);
      if (promptRaw) {
        const promptText = clamp(promptRaw, CAPS.promptText);
        if (promptText && promptText !== st.lastPromptText) {
          st.lastPromptText = promptText;
          st.pendingText = null;
          st.pendingGate = null;
          st.openTools = {};
          st.metaModel = null; // re-emit the meta row for the new turn
          events.push({ abs_ms: ts, kind: 'prompt', text: promptText });
        }
      }
      continue;
    }

    if (type === 'system' && obj.subtype === 'init') {
      emitMetaModel(ts, obj.model);
      continue;
    }

    if (type === 'system' && obj.subtype === 'permission_request') {
      const gateKind = coworkPermissionRequestGateKind(obj);
      const input = obj.tool_input && typeof obj.tool_input === 'object' ? obj.tool_input : null;
      const gate = { abs_ms: ts, kind: 'gate_open', gate_kind: gateKind };
      if (gateKind === 'question') {
        const questions = normalizeQuestions(input ? input.questions : null);
        if (questions) gate.questions = questions;
      } else {
        const toolName = typeof obj.tool_name === 'string' ? obj.tool_name.trim() : '';
        const summary = summarizeToolInput(input);
        if (toolName && summary) gate.command = `${toolName}: ${summary}`.slice(0, CAPS.command);
        else if (summary) gate.command = summary;
        else if (toolName) gate.command = toolName;
      }
      events.push(gate);
      st.pendingGate = {
        uuid: typeof obj.uuid === 'string' ? obj.uuid : '',
        kind: gateKind,
        start_ms: ts,
        tool_name: typeof obj.tool_name === 'string' ? obj.tool_name.trim() : '',
      };
      continue;
    }

    if (type === 'system' && obj.subtype === 'permission_response') {
      const g = st.pendingGate;
      if (g && (!g.uuid || !obj.uuid || g.uuid === obj.uuid)) {
        // A DENIED permission never yields a tool_result — close the gate here; a GRANT waits for
        // the tool_result (which carries the answers for a question).
        if (obj.granted === false) {
          events.push({ abs_ms: ts, kind: 'gate_answered', waited_ms: Math.max(0, ts - g.start_ms) });
          for (const [id, o] of Object.entries(st.openTools)) {
            if (o.name === g.tool_name) {
              events.push({ abs_ms: ts, kind: 'tool_end', name: o.name, detail: '', ok: false });
              delete st.openTools[id];
            }
          }
          st.pendingGate = null;
        } else {
          g.granted = true;
        }
      }
      continue;
    }
    // status / rate_limit / other lifecycle records carry no LiveTurnEvent content.
  }
  return { events };
}

module.exports = {
  DEFAULT_MAX_RUNS,
  DEFAULT_TAIL_BYTES,
  DEFAULT_MAIN_LOG_TAIL_BYTES,
  COWORK_ASK_USER_QUESTION_TOOL,
  coworkPermissionRequestGateKind,
  parseCoworkAuditRecords,
  parseCoworkQuestionAnswerPairs,
  parseJsonlLines,
  eventTimeMs,
  getClaudeCoworkRoot,
  getClaudeMainLogPath,
  assertAllowedCoworkAuditPath,
  discoverClaudeCoworkRuns,
  coworkTurnCompletedSince,
  claudeCoworkMainLogCancelledSince,
  claudeMainLogHasCoworkStopForSession,
  coworkWatchActiveGenerationSince,
  latestCoworkUserPreviewFromTail,
  classifyCoworkActiveGenerationFromText,
  isCoworkRateLimitRejection,
  isCoworkCancelledResult,
  isCoworkAskUserQuestionPermissionRequest,
  isCoworkPermissionResponse,
  isCompletedCoworkResult,
  getHumanUserText,
};
