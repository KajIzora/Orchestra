const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { assertValidRemoteSource, createSshRunner } = require('./remote_cursor_tracker');
const { applyActiveGenerationStaleCutoff, toIso } = require('./active_generation');

const DEFAULT_MAX_RUNS = 20;
const DEFAULT_TAIL_BYTES = 512 * 1024;
const REMOTE_CODEX_ROOT = '$HOME/.codex/sessions';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function normalizePosixAbsolute(p) {
  if (typeof p !== 'string') throw new Error('Path must be a string');
  const trimmed = p.trim();
  if (!trimmed.startsWith('/')) throw new Error('Path must be absolute');
  const normalized = path.posix.normalize(trimmed);
  if (normalized === '.') throw new Error('Path must be absolute');
  return normalized;
}

function posixPrefix(root) {
  return root.endsWith('/') ? root : `${root}/`;
}

function getCodexRoot(homeDir = os.homedir()) {
  return path.resolve(path.join(homeDir, '.codex'));
}

function getCodexSessionsRoot(homeDir = os.homedir()) {
  return path.resolve(path.join(getCodexRoot(homeDir), 'sessions'));
}

function assertAllowedCodexTranscriptPath(transcriptPath, homeDir = os.homedir()) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.trim()) {
    throw new Error('transcript_path is required');
  }
  const resolved = path.resolve(transcriptPath.trim());
  const allowedRoot = getCodexSessionsRoot(homeDir);
  const prefix = allowedRoot.endsWith(path.sep) ? allowedRoot : `${allowedRoot}${path.sep}`;
  if (resolved !== allowedRoot && !resolved.startsWith(prefix)) {
    throw new Error('transcript_path must be under ~/.codex/sessions');
  }
  if (!resolved.endsWith('.jsonl')) {
    throw new Error('transcript_path must be a .jsonl file');
  }
  return resolved;
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

function parseCodexSessionIndex(indexPath) {
  if (!fs.existsSync(indexPath)) return [];
  const raw = fs.readFileSync(indexPath, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    const sessionId = typeof obj.id === 'string' ? obj.id.trim() : '';
    if (!sessionId) continue;
    out.push({
      session_id: sessionId,
      title: typeof obj.thread_name === 'string' ? obj.thread_name.trim() : '',
      updated_at: typeof obj.updated_at === 'string' ? obj.updated_at : '',
    });
  }
  return out;
}

function walkJsonlFiles(rootDir) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && full.endsWith('.jsonl')) {
        out.push(full);
      }
    }
  }
  return out;
}

function firstWords(text, maxWords = 10) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  if (!one) return '';
  const words = one.split(' ');
  if (words.length <= maxWords) return one;
  return `${words.slice(0, maxWords).join(' ')}…`;
}

/**
 * Drop pasted terminal session lines (conda env, user@host, cwd, % prompt, command)
 * so the watch list shows the actual follow-up question when present on later lines.
 */
function stripLeadingShellSessionLines(text) {
  const raw = String(text || '');
  const lines = raw.split(/\r?\n/);
  const isShellPromptLine = (line) => {
    const t = line.trim();
    if (!t) return false;
    const withConda = /^\([^)]*\)\s+\S+@\S+\s+\S+\s+[%$#>]\s*/.test(t);
    const noConda = /^\S+@\S+\s+\S+\s+[%$#>]\s*/.test(t);
    if (!(withConda || noConda)) return false;
    // Same line as a real question (e.g. after `% python … Can you …`) — do not drop the whole line.
    if (/\b(Can|Could|Why|How|What|Please|Is|Does|Did|Will|Would|Should|Explain|Summarize|Help|Check|Review)\b/i.test(t)) {
      return false;
    }
    return true;
  };
  let i = 0;
  while (i < lines.length && isShellPromptLine(lines[i])) i += 1;
  while (i < lines.length && !lines[i].trim()) i += 1;
  return lines.slice(i).join('\n');
}

function stripInlineShellPromptPrefix(text) {
  const t = String(text || '');
  if (t.includes('\n')) return t;
  return t.replace(/^(?:\([^)]*\)\s+)?\S+@\S+\s+\S+\s+[%$#>]\s+/, '').trim();
}

/** After zsh-style prompt removal, drop a pasted `python path/script.py` when real prose follows. */
function stripLeadingInterpreterLineBeforeProse(text) {
  const t = String(text || '').trim();
  const startsAsRun =
    /^(python3?|conda(?:\s+run)?|pip|npm|npx|node|yarn|pnpm)\s+\S/i.test(t) && (t.includes('/') || /\.(py|sh|mjs|cjs)\b/i.test(t));
  if (!startsAsRun) return t;
  const prose = /\s+(Can|Could|Why|How|What|Please|Is|Does|Did|Will|Would|Should|If|When|Where|Explain|Summarize|Help|Look|Check|Review|Tell|Give|Show|Walk|Debug|Fix)\b/i;
  const idx = t.search(prose);
  if (idx === -1) return '';
  return t.slice(idx).trim();
}

function cleanCodexPromptText(text) {
  let cleaned = String(text || '').trim();
  cleaned = stripLeadingShellSessionLines(cleaned);
  cleaned = stripInlineShellPromptPrefix(cleaned);
  cleaned = stripLeadingInterpreterLineBeforeProse(cleaned);
  const requestMatch = cleaned.match(/(?:^|\n)## My request for Codex:\s*([\s\S]*)$/i);
  if (requestMatch) cleaned = requestMatch[1].trim();
  const userQueryMatch = cleaned.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (userQueryMatch) cleaned = userQueryMatch[1].trim();
  return cleaned.replace(/\s+/g, ' ').trim();
}

function extractCodexUserText(obj) {
  const payload = obj?.payload;
  if (!payload || payload.type !== 'message' || payload.role !== 'user') return '';
  const content = payload.content;
  if (typeof content === 'string') return cleanCodexPromptText(content);
  if (!Array.isArray(content)) return '';
  const pieces = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (typeof block.text === 'string') pieces.push(block.text);
    if (typeof block.content === 'string') pieces.push(block.content);
  }
  return cleanCodexPromptText(pieces.join('\n'));
}

/** Clean IDE scaffolding from a raw hook/transcript prompt, then truncate to maxWords. */
function codexPromptPreviewFromText(text, maxWords = 10) {
  const cleaned = cleanCodexPromptText(text);
  if (!cleaned) return '';
  return firstWords(cleaned, maxWords);
}

function latestCodexUserPreviewFromTailText(tailText, maxWords = 10) {
  if (!tailText) return '';
  const lines = tailText.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const text = extractCodexUserText(obj);
    if (text) return firstWords(text, maxWords);
  }
  return '';
}

function extractCodexSessionMeta(tailText) {
  const out = { workspace_path: '' };
  if (!tailText) return out;
  for (const line of tailText.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (obj?.type !== 'session_meta') continue;
    if (typeof obj.payload?.cwd === 'string') out.workspace_path = obj.payload.cwd;
    break;
  }
  return out;
}

function codexEventTimeMs(obj) {
  return Date.parse(obj?.timestamp || obj?.payload?.timestamp || '') || 0;
}

function parseCodexFunctionArguments(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.arguments && typeof payload.arguments === 'object') return payload.arguments;
  if (typeof payload.arguments !== 'string' || !payload.arguments.trim()) return null;
  try {
    return JSON.parse(payload.arguments);
  } catch {
    return null;
  }
}

function isCodexPermissionRequestFunctionCall(obj) {
  if (!obj || obj.type !== 'response_item') return false;
  const payload = obj.payload;
  if (!payload || payload.type !== 'function_call') return false;
  const args = parseCodexFunctionArguments(payload);
  return args?.sandbox_permissions === 'require_escalated';
}

function classifyCodexActiveGenerationFromText(raw, options = {}) {
  let generating = false;
  let startMs = 0;
  let lastMs = Number.isFinite(options.mtimeMs) ? options.mtimeMs : 0;
  let inactiveReason = 'no_start_signal';
  let pendingRequestCallId = null;
  let pendingPermissionCallId = null;

  for (const line of String(raw || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    const ts = codexEventTimeMs(obj);
    if (ts) lastMs = ts;
    const payload = obj?.payload;
    const payloadType = payload?.type;
    const userText = extractCodexUserText(obj);

    if (userText || payloadType === 'user_message' || payloadType === 'task_started') {
      generating = true;
      startMs = ts || lastMs || startMs;
      lastMs = ts || lastMs;
      inactiveReason = '';
      pendingRequestCallId = null;
      pendingPermissionCallId = null;
      continue;
    }

    if (payloadType === 'task_complete') {
      generating = false;
      inactiveReason = 'completion_signal';
      pendingRequestCallId = null;
      pendingPermissionCallId = null;
      continue;
    }

    if (payloadType === 'turn_aborted') {
      generating = false;
      inactiveReason = 'aborted';
      pendingRequestCallId = null;
      pendingPermissionCallId = null;
      continue;
    }

    if (isCodexPermissionRequestFunctionCall(obj)) {
      const callId = typeof payload.call_id === 'string' && payload.call_id.trim()
        ? payload.call_id.trim()
        : '__permission_request__';
      pendingPermissionCallId = callId;
      generating = false;
      inactiveReason = 'blocked_on_permission';
      continue;
    }

    if (obj.type === 'response_item' && payloadType === 'function_call' && payload?.name === 'request_user_input') {
      pendingRequestCallId = typeof payload.call_id === 'string' && payload.call_id.trim()
        ? payload.call_id.trim()
        : '__request_user_input__';
      generating = false;
      inactiveReason = 'blocked_on_user_input';
      continue;
    }

    if (obj.type === 'response_item' && payloadType === 'function_call_output') {
      const outCallId = typeof payload.call_id === 'string' ? payload.call_id.trim() : '';
      if (outCallId && pendingRequestCallId && outCallId === pendingRequestCallId) {
        pendingRequestCallId = null;
        generating = true;
        inactiveReason = '';
        startMs = ts || lastMs || startMs;
      }
      if (outCallId && pendingPermissionCallId && outCallId === pendingPermissionCallId) {
        pendingPermissionCallId = null;
        generating = true;
        inactiveReason = '';
        startMs = ts || lastMs || startMs;
      }
      continue;
    }
  }

  if (pendingPermissionCallId) {
    generating = false;
    inactiveReason = 'blocked_on_permission';
  } else if (pendingRequestCallId) {
    generating = false;
    inactiveReason = 'blocked_on_user_input';
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

async function discoverCodexRuns(homeDir = os.homedir(), options = {}) {
  const sessionsRoot = getCodexSessionsRoot(homeDir);
  const indexPath = path.join(getCodexRoot(homeDir), 'session_index.jsonl');
  const maxRuns =
    Number.isInteger(options.maxRuns) && options.maxRuns > 0 ? options.maxRuns : DEFAULT_MAX_RUNS;
  const fromIndex = parseCodexSessionIndex(indexPath);
  const indexById = new Map(fromIndex.map((row) => [row.session_id, row]));
  const files = walkJsonlFiles(sessionsRoot);
  const runs = [];
  for (const transcriptPath of files) {
    let st;
    try {
      st = fs.statSync(transcriptPath);
    } catch {
      continue;
    }
    const sessionId = path.basename(transcriptPath, '.jsonl');
    const idx = indexById.get(sessionId);
    runs.push({
      kind: 'ide_agent',
      provider: 'codex',
      source: 'local',
      session_id: sessionId,
      transcript_path: transcriptPath,
      title: idx?.title || '',
      workspace_path: '',
      updated_at: idx?.updated_at || '',
      mtime_ms: st.mtimeMs || 0,
      last_user_preview: '',
    });
  }
  runs.sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0));
  const top = runs.slice(0, maxRuns);
  await Promise.all(
    top.map(async (run) => {
      try {
        const tail = await readTailText(run.transcript_path);
        run.last_user_preview = latestCodexUserPreviewFromTailText(tail, 10);
        const meta = extractCodexSessionMeta(tail);
        run.workspace_path = meta.workspace_path || run.workspace_path;
        Object.assign(
          run,
          classifyCodexActiveGenerationFromText(tail, {
            mtimeMs: run.mtime_ms,
            nowMs: options.nowMs,
            activeStaleMs: options.activeStaleMs,
          })
        );
        if (!run.last_user_preview) {
          run.last_user_preview = run.title || run.session_id;
        }
      } catch {
        run.last_user_preview = run.title || run.session_id;
        Object.assign(
          run,
          classifyCodexActiveGenerationFromText('', {
            mtimeMs: run.mtime_ms,
            nowMs: options.nowMs,
            activeStaleMs: options.activeStaleMs,
          })
        );
      }
    })
  );
  return top;
}

async function codexTaskCompletedSince(transcriptPath, linkedAtIso, homeDir = os.homedir()) {
  const resolved = assertAllowedCodexTranscriptPath(transcriptPath, homeDir);
  let raw = '';
  try {
    raw = await fsp.readFile(resolved, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  const linkedAtMs = Date.parse(linkedAtIso || '') || 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (obj?.payload?.type !== 'task_complete') continue;
    const eventTs = Date.parse(obj.timestamp || '') || 0;
    if (!linkedAtMs || eventTs >= linkedAtMs) return true;
  }
  return false;
}

/**
 * Whether a Codex session transcript indicates the watch should clear: task finished after link,
 * user cancelled the turn after link, or Codex is blocked on user action
 * (`request_user_input` or a permission request not yet answered in the log).
 * @param {string} raw full transcript JSONL text
 * @param {string} linkedAtIso watch linked_at ISO time
 * @returns {''|'done'|'permission'|'question'} reason the watch should clear (falsy = keep waiting)
 */
function codexTranscriptShouldClearWatch(raw, linkedAtIso) {
  const linkedAtMs = Date.parse(linkedAtIso || '') || 0;
  // Latest terminal reason after link: 'done' (task_complete) or 'cancelled' (turn_aborted).
  let terminalReason = '';
  /** @type {string|null} */
  let pendingRequestCallId = null;
  /** @type {string|null} */
  let pendingPermissionCallId = null;

  for (const line of String(raw || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    const ts = Date.parse(obj.timestamp || '') || 0;
    const payload = obj?.payload;
    const payloadType = payload?.type;

    if (payloadType === 'task_complete') {
      if (!linkedAtMs || ts >= linkedAtMs) {
        terminalReason = 'done';
      }
      pendingRequestCallId = null;
      pendingPermissionCallId = null;
      continue;
    }

    if (payloadType === 'turn_aborted') {
      if (!linkedAtMs || ts >= linkedAtMs) {
        terminalReason = 'cancelled';
      }
      pendingRequestCallId = null;
      pendingPermissionCallId = null;
      continue;
    }

    if (payloadType === 'user_message' || payloadType === 'task_started') {
      pendingRequestCallId = null;
      pendingPermissionCallId = null;
      continue;
    }

    if (isCodexPermissionRequestFunctionCall(obj)) {
      const callId = typeof payload.call_id === 'string' ? payload.call_id.trim() : '';
      pendingPermissionCallId = callId || '__permission_request__';
      continue;
    }

    if (obj.type === 'response_item' && payloadType === 'function_call' && payload?.name === 'request_user_input') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id.trim() : '';
      pendingRequestCallId = callId || '__request_user_input__';
      continue;
    }

    if (obj.type === 'response_item' && payloadType === 'function_call_output') {
      const outCallId = typeof payload.call_id === 'string' ? payload.call_id.trim() : '';
      if (outCallId && pendingRequestCallId && outCallId === pendingRequestCallId) {
        pendingRequestCallId = null;
      }
      if (outCallId && pendingPermissionCallId && outCallId === pendingPermissionCallId) {
        pendingPermissionCallId = null;
      }
      continue;
    }
  }

  // A pending permission / input request means the agent stopped blocked on you;
  // otherwise the latest terminal event decides done vs cancelled.
  if (pendingPermissionCallId !== null) return 'permission';
  if (pendingRequestCallId !== null) return 'question';
  return terminalReason;
}

async function codexWatchShouldClearSince(transcriptPath, linkedAtIso, homeDir = os.homedir()) {
  const resolved = assertAllowedCodexTranscriptPath(transcriptPath, homeDir);
  let raw = '';
  try {
    raw = await fsp.readFile(resolved, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  return codexTranscriptShouldClearWatch(raw, linkedAtIso);
}

// Active-generation classification of a local Codex transcript — used to detect that
// a paused (needs-input) watch has resumed.
async function codexWatchActiveGenerationSince(transcriptPath, homeDir = os.homedir()) {
  const resolved = assertAllowedCodexTranscriptPath(transcriptPath, homeDir);
  let raw = '';
  try {
    raw = await readTailText(resolved);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  return classifyCodexActiveGenerationFromText(raw, {});
}

function assertAllowedRemoteCodexTranscriptPath(transcriptPath, codexRoot = REMOTE_CODEX_ROOT) {
  const resolved = normalizePosixAbsolute(transcriptPath);
  const rawRoot = String(codexRoot || REMOTE_CODEX_ROOT);
  if (rawRoot.includes('$HOME')) {
    const marker = '/.codex/sessions/';
    const exact = '/.codex/sessions';
    if (!resolved.includes(marker) && !resolved.endsWith(exact)) {
      throw new Error('Remote Codex transcript path must stay under ~/.codex/sessions');
    }
  } else {
    const root = normalizePosixAbsolute(rawRoot);
    const allowedPrefix = posixPrefix(root);
    if (resolved !== root && !resolved.startsWith(allowedPrefix)) {
      throw new Error('Remote Codex transcript path must stay under ~/.codex/sessions');
    }
  }
  if (!resolved.endsWith('.jsonl')) {
    throw new Error('Remote Codex transcript path must be a .jsonl file');
  }
  return resolved;
}

function parseRemoteCodexFindOutput(output) {
  const rows = [];
  const lines = String(output || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const [mtimeRaw, transcriptPathRaw] = line.split('\t');
    if (!mtimeRaw || !transcriptPathRaw) continue;
    const transcriptPath = transcriptPathRaw.trim();
    if (!transcriptPath.endsWith('.jsonl')) continue;
    const sessionId = path.posix.basename(transcriptPath, '.jsonl');
    rows.push({
      kind: 'ide_agent',
      provider: 'codex',
      source: 'ssh',
      session_id: sessionId,
      transcript_path: transcriptPath,
      title: '',
      workspace_path: '',
      updated_at: '',
      mtime_ms: Math.max(0, Number.parseFloat(mtimeRaw) * 1000) || 0,
      last_user_preview: '',
    });
  }
  rows.sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0));
  return rows;
}

async function discoverRemoteCodexRuns(remote, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  const maxRuns =
    Number.isInteger(options.maxRuns) && options.maxRuns > 0 ? options.maxRuns : DEFAULT_MAX_RUNS;
  const cmd =
    `find ${REMOTE_CODEX_ROOT} -type f -name '*.jsonl' -printf '%T@\\t%p\\n' 2>/dev/null | sort -nr | head -n ${String(
      maxRuns
    )}`;
  const stdout = await runSsh(cfg.host, cmd, options.timeoutMs);
  const runs = parseRemoteCodexFindOutput(stdout).slice(0, maxRuns);
  await Promise.all(
    runs.map(async (run) => {
      const q = shellQuote(run.transcript_path);
      const tailCmd = `if [ -f ${q} ]; then tail -c ${DEFAULT_TAIL_BYTES} ${q} 2>/dev/null || true; fi`;
      try {
        const tail = await runSsh(cfg.host, tailCmd, options.timeoutMs);
        run.last_user_preview = latestCodexUserPreviewFromTailText(tail, 10) || run.session_id;
        const meta = extractCodexSessionMeta(tail);
        run.workspace_path = meta.workspace_path || '';
        Object.assign(
          run,
          classifyCodexActiveGenerationFromText(tail, {
            mtimeMs: run.mtime_ms,
            nowMs: options.nowMs,
            activeStaleMs: options.activeStaleMs,
          })
        );
      } catch {
        run.last_user_preview = run.session_id;
        Object.assign(
          run,
          classifyCodexActiveGenerationFromText('', {
            mtimeMs: run.mtime_ms,
            nowMs: options.nowMs,
            activeStaleMs: options.activeStaleMs,
          })
        );
      }
      run.host = cfg.host;
      run.projects_root = cfg.projects_root;
    })
  );
  return runs;
}

async function remoteCodexTaskCompletedSince(remote, transcriptPath, linkedAtIso, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  const quotedPath = shellQuote(transcriptPath);
  const cmd = `if [ -f ${quotedPath} ]; then cat ${quotedPath} 2>/dev/null || true; fi`;
  const raw = await runSsh(cfg.host, cmd, options.timeoutMs);
  const linkedAtMs = Date.parse(linkedAtIso || '') || 0;
  for (const line of String(raw || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (obj?.payload?.type !== 'task_complete') continue;
    const eventTs = Date.parse(obj.timestamp || '') || 0;
    if (!linkedAtMs || eventTs >= linkedAtMs) return true;
  }
  return false;
}

async function remoteCodexWatchShouldClearSince(remote, transcriptPath, linkedAtIso, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  const quotedPath = shellQuote(transcriptPath);
  const cmd = `if [ -f ${quotedPath} ]; then cat ${quotedPath} 2>/dev/null || true; fi`;
  const raw = await runSsh(cfg.host, cmd, options.timeoutMs);
  return codexTranscriptShouldClearWatch(raw, linkedAtIso);
}

// Active-generation classification of a remote (ssh) Codex transcript — used to detect
// that a paused (needs-input) watch has resumed.
async function remoteCodexWatchActiveGenerationSince(remote, transcriptPath, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  const q = shellQuote(transcriptPath);
  const cmd = `if [ -f ${q} ]; then tail -c ${DEFAULT_TAIL_BYTES} ${q} 2>/dev/null || true; fi`;
  const raw = await runSsh(cfg.host, cmd, options.timeoutMs);
  if (!String(raw || '').trim()) return null;
  return classifyCodexActiveGenerationFromText(raw, {});
}

/**
 * Reconcile hook-store picker rows with the Codex session transcript so cancelled or
 * completed turns do not stay "active" when hooks never fired Stop.
 */
async function enrichCodexPickerRunWithTranscript(run, options = {}) {
  if (!run || typeof run !== 'object') return run;
  const out = { ...run };
  const transcriptPath = typeof run.transcript_path === 'string' ? run.transcript_path.trim() : '';
  if (!transcriptPath) return out;

  try {
    let tail = '';
    if (run.source === 'ssh' && options.remote) {
      const cfg = assertValidRemoteSource(options.remote);
      const runSsh = options.runSsh || createSshRunner();
      const q = shellQuote(transcriptPath);
      const tailCmd = `if [ -f ${q} ]; then tail -c ${DEFAULT_TAIL_BYTES} ${q} 2>/dev/null || true; fi`;
      tail = await runSsh(cfg.host, tailCmd, options.timeoutMs);
    } else {
      const resolved = assertAllowedCodexTranscriptPath(transcriptPath, options.homeDir);
      tail = await readTailText(resolved);
    }
    if (!String(tail || '').trim()) return out;
    const preview = latestCodexUserPreviewFromTailText(tail, 10);
    if (preview) out.last_user_preview = preview;
    Object.assign(
      out,
      classifyCodexActiveGenerationFromText(tail, {
        mtimeMs: run.mtime_ms,
        nowMs: options.nowMs,
        activeStaleMs: options.activeStaleMs,
      })
    );
    if (out.generating) {
      out.completion_hint = false;
    } else if (out.inactive_reason === 'completion_signal') {
      out.completion_hint = true;
    }
  } catch {
    // Keep hook-derived generation when the transcript is missing or unreadable.
  }
  return out;
}

module.exports = {
  DEFAULT_MAX_RUNS,
  assertAllowedCodexTranscriptPath,
  assertAllowedRemoteCodexTranscriptPath,
  discoverCodexRuns,
  discoverRemoteCodexRuns,
  codexTaskCompletedSince,
  codexTranscriptShouldClearWatch,
  codexWatchShouldClearSince,
  codexWatchActiveGenerationSince,
  remoteCodexTaskCompletedSince,
  remoteCodexWatchShouldClearSince,
  remoteCodexWatchActiveGenerationSince,
  latestCodexUserPreviewFromTailText,
  codexPromptPreviewFromText,
  classifyCodexActiveGenerationFromText,
  enrichCodexPickerRunWithTranscript,
};
