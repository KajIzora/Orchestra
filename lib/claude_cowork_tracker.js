const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { truncateCleanHumanPromptPreview } = require('./human_prompt_preview');
const { applyActiveGenerationStaleCutoff, toIso } = require('./active_generation');

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
      workspace_path: typeof json.cwd === 'string' ? json.cwd : '',
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
 * @returns {''|'done'|'cancelled'|'permission'} reason the watch should clear (falsy = keep waiting).
 *   'permission' covers both tool-permission prompts and AskUserQuestion, which the
 *   Cowork audit records under the same `permission_request` subtype. Rate-limit stops
 *   are treated as 'done' (not a question/permission you can answer).
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
      reason = 'permission';
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

module.exports = {
  DEFAULT_MAX_RUNS,
  DEFAULT_TAIL_BYTES,
  DEFAULT_MAIN_LOG_TAIL_BYTES,
  COWORK_ASK_USER_QUESTION_TOOL,
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
};
