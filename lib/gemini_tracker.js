const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const { assertValidRemoteSource, createSshRunner } = require('./remote_cursor_tracker');
const { applyActiveGenerationStaleCutoff, toIso } = require('./active_generation');
const {
  getAntigravityBrainRoots,
  isAntigravityTranscriptPath,
} = require('./antigravity_hook_signals');
const { evaluateAgyTranscriptIdleCompletion } = require('./antigravity_transcript_idle');

const DEFAULT_MAX_RUNS = 20;
const DEFAULT_TAIL_BYTES = Math.max(
  256 * 1024,
  Number.parseInt(process.env.GEMINI_LOG_TAIL_BYTES || String(4 * 1024 * 1024), 10) || 4 * 1024 * 1024
);
const REMOTE_GEMINI_ROOT = '$HOME/.gemini';
const execFileAsync = promisify(execFile);

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

function getGeminiRoot(homeDir = os.homedir()) {
  return path.resolve(path.join(homeDir, '.gemini'));
}

function getGeminiProjectsIndexPath(homeDir = os.homedir()) {
  return path.resolve(path.join(getGeminiRoot(homeDir), 'projects.json'));
}

function getGeminiTmpRoot(homeDir = os.homedir()) {
  return path.resolve(path.join(getGeminiRoot(homeDir), 'tmp'));
}


function isUnderAllowedRoot(resolved, allowedRoot) {
  const prefix = allowedRoot.endsWith(path.sep) ? allowedRoot : `${allowedRoot}${path.sep}`;
  return resolved === allowedRoot || resolved.startsWith(prefix);
}

function assertAllowedGeminiTranscriptPath(transcriptPath, homeDir = os.homedir()) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.trim()) {
    throw new Error('transcript_path is required');
  }
  const resolved = path.resolve(transcriptPath.trim());
  const tmpRoot = getGeminiTmpRoot(homeDir);
  const brainRoots = getAntigravityBrainRoots(homeDir);
  const allowed =
    isUnderAllowedRoot(resolved, tmpRoot) ||
    brainRoots.some((root) => isUnderAllowedRoot(resolved, root));
  if (!allowed) {
    throw new Error('transcript_path must be under ~/.gemini/tmp or antigravity brain');
  }
  if (!resolved.endsWith('.json') && !resolved.endsWith('.jsonl')) {
    throw new Error('transcript_path must be a .json or .jsonl file');
  }
  return resolved;
}

function assertAllowedRemoteGeminiTranscriptPath(transcriptPath, geminiRoot = REMOTE_GEMINI_ROOT) {
  const resolved = normalizePosixAbsolute(transcriptPath);
  const rawRoot = String(geminiRoot || REMOTE_GEMINI_ROOT);
  if (rawRoot.includes('$HOME')) {
    const tmpMarker = '/.gemini/tmp/';
    const tmpExact = '/.gemini/tmp';
    const cliBrainMarker = '/.gemini/antigravity-cli/brain/';
    const appBrainMarker = '/.gemini/antigravity/brain/';
    const allowed =
      resolved.includes(tmpMarker) ||
      resolved.endsWith(tmpExact) ||
      resolved.includes(cliBrainMarker) ||
      resolved.includes(appBrainMarker);
    if (!allowed) {
      throw new Error('Remote Gemini transcript path must stay under ~/.gemini/tmp or antigravity brain');
    }
  } else {
    const root = normalizePosixAbsolute(path.posix.join(rawRoot, 'tmp'));
    const allowedPrefix = posixPrefix(root);
    if (resolved !== root && !resolved.startsWith(allowedPrefix)) {
      throw new Error('Remote Gemini transcript path must stay under ~/.gemini/tmp');
    }
  }
  if (!resolved.endsWith('.json') && !resolved.endsWith('.jsonl')) {
    throw new Error('Remote Gemini transcript path must be a .json or .jsonl file');
  }
  return resolved;
}

/**
 * Gemini CLI may emit AfterAgent between tool rounds while the JSONL transcript still shows an
 * active user turn. Do not let hook "idle" overwrite transcript-based "still generating".
 */
function applyGeminiHookHintMerge(run, hint) {
  if (!hint || !run) return;
  const transcriptGenerating = !!run.generating;
  if (hint.generating === true) {
    run.generating = true;
  } else if (!transcriptGenerating) {
    run.generating = false;
  }
  if (hint.last_user_preview) run.last_user_preview = hint.last_user_preview;
  if (hint.updated_at) {
    run.updated_at = hint.updated_at;
    run.mtime_ms = Math.max(run.mtime_ms || 0, Date.parse(hint.updated_at) || 0);
  }
}

function firstWords(text, maxWords = 10) {
  const one = sanitizeGeminiUserText(String(text || ''));
  if (!one) return '';
  const words = one.split(' ');
  if (words.length <= maxWords) return one;
  return `${words.slice(0, maxWords).join(' ')}…`;
}

function sanitizeGeminiUserText(text) {
  let one = String(text || '');
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
  return one;
}


function extractGeminiRecordContent(message) {
  if (!message || typeof message !== 'object') return '';
  const content = message.content;
  if (typeof content === 'string') return sanitizeGeminiUserText(content);
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (typeof block.text === 'string') parts.push(block.text);
      if (typeof block.content === 'string') parts.push(block.content);
    }
    return sanitizeGeminiUserText(parts.join(' '));
  }
  return '';
}

function extractGeminiUserText(message) {
  if (!message || message.type !== 'user') return '';
  return extractGeminiRecordContent(message);
}

function latestGeminiUserPreviewFromConversation(conversation, maxWords = 10) {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = extractGeminiUserText(messages[i]);
    if (text) return firstWords(text, maxWords);
  }
  return '';
}


function geminiMessageHasCancelledTool(msg) {
  if (!msg || msg.type !== 'gemini') return false;
  const calls = Array.isArray(msg.toolCalls) ? msg.toolCalls : [];
  return calls.some((t) => String(t?.status || '').toLowerCase() === 'cancelled');
}

/** True when Gemini is mid-tool (including ask_user waiting for an answer). */
function geminiMessageHasPendingToolCalls(msg) {
  if (!msg || msg.type !== 'gemini') return false;
  const calls = Array.isArray(msg.toolCalls) ? msg.toolCalls : [];
  if (!calls.length) return false;
  return calls.some((tool) => {
    const status = String(tool?.status || '').toLowerCase();
    if (status === 'cancelled') return false;
    const result = tool?.result;
    if (result == null) return true;
    if (Array.isArray(result) && !result.length) return true;
    return false;
  });
}

/** Gemini CLI quick-cancel writes type "info" with content "Request cancelled." */
function geminiMessageIsRequestCancelled(msg) {
  if (!msg || msg.type !== 'info') return false;
  const text = extractGeminiRecordContent(msg).toLowerCase();
  return text === 'request cancelled.' || text === 'request cancelled';
}

function geminiMessageSignalsCancel(msg) {
  return geminiMessageHasCancelledTool(msg) || geminiMessageIsRequestCancelled(msg);
}

/** Cancel info may land a few ms before or after the user line in jsonl file order. */
const GEMINI_CANCEL_TURN_WINDOW_MS = 30_000;

function geminiConversationLastUserTurnHasCancel(conversation, linkedAtIso = '', options = {}) {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  if (!messages.length) return false;
  const linkedAtMs = Date.parse(linkedAtIso || '') || 0;
  const windowMs =
    Number.isFinite(options.cancelTurnWindowMs) && options.cancelTurnWindowMs >= 0
      ? options.cancelTurnWindowMs
      : GEMINI_CANCEL_TURN_WINDOW_MS;

  let lastUserIndex = -1;
  let lastUserMs = 0;
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.type === 'user') {
      lastUserIndex = i;
      lastUserMs = Date.parse(messages[i].timestamp || '') || lastUserMs;
    }
  }
  if (lastUserIndex === -1) return false;

  for (let i = lastUserIndex + 1; i < messages.length; i += 1) {
    const msg = messages[i];
    const ts = Date.parse(msg?.timestamp || '') || 0;
    if (linkedAtMs && ts && ts < linkedAtMs) continue;
    if (geminiMessageSignalsCancel(msg)) return true;
  }

  // Very fast cancel: Gemini CLI may append "Request cancelled." before the user line.
  for (let i = 0; i < lastUserIndex; i += 1) {
    const msg = messages[i];
    if (!geminiMessageIsRequestCancelled(msg)) continue;
    const ts = Date.parse(msg?.timestamp || '') || 0;
    if (linkedAtMs && ts && ts < linkedAtMs) continue;
    if (!lastUserMs || !ts || Math.abs(ts - lastUserMs) <= windowMs) return true;
  }
  return false;
}

function geminiConversationCancelledSince(conversation, linkedAtIso) {
  return geminiConversationLastUserTurnHasCancel(conversation, linkedAtIso);
}

function geminiConversationDoneSince(conversation, linkedAtIso, options = {}) {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  if (!messages.length) return false;
  const linkedAtMs = Date.parse(linkedAtIso || '') || 0;
  let lastUserIndex = -1;
  let lastUserTs = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg || msg.type !== 'user') continue;
    const ts = Date.parse(msg.timestamp || '') || 0;
    lastUserIndex = i;
    lastUserTs = ts;
  }
  if (lastUserIndex === -1) return false;
  const updatedMs = Date.parse(conversation?.lastUpdated || conversation?.updated_at || '') || 0;
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.type !== 'gemini') return false;
  const responseMs = Date.parse(lastMessage.timestamp || '') || updatedMs || 0;
  if (linkedAtMs && (!responseMs || responseMs < linkedAtMs)) return false;
  if (lastUserTs && responseMs && responseMs < lastUserTs) return false;
  return true;
}


function classifyGeminiActiveGenerationFromConversation(conversation, options = {}) {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  let lastUserIndex = -1;
  let lastUserMs = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg || msg.type !== 'user') continue;
    lastUserIndex = i;
    lastUserMs = Date.parse(msg.timestamp || '') || lastUserMs;
  }
  const updatedMs =
    Date.parse(conversation?.lastUpdated || conversation?.updated_at || '') ||
    (Number.isFinite(options.mtimeMs) ? options.mtimeMs : 0);
  const lastMessage = messages[messages.length - 1] || null;
  const lastMessageMs = Date.parse(lastMessage?.timestamp || '') || 0;
  const lastActivityMs = Math.max(updatedMs || 0, lastMessageMs || 0, Number.isFinite(options.mtimeMs) ? options.mtimeMs : 0);
  if (lastUserIndex === -1) {
    return applyActiveGenerationStaleCutoff(
      {
        generating: false,
        start_signal_at: '',
        last_activity_at: toIso(lastActivityMs),
        inactive_reason: 'no_start_signal',
      },
      options
    );
  }

  let generating = true;
  let inactiveReason = '';
  if (geminiConversationLastUserTurnHasCancel(conversation)) {
    generating = false;
    inactiveReason = 'cancelled';
  }
  if (generating && lastMessage?.type === 'gemini') {
    if (geminiMessageHasPendingToolCalls(lastMessage)) {
      const pendingActivityMs = Math.max(lastMessageMs || 0, lastUserMs || 0);
      return {
        generating: true,
        start_signal_at: toIso(lastUserMs || pendingActivityMs),
        last_activity_at: toIso(pendingActivityMs),
        inactive_reason: '',
      };
    }
    const responseMs = lastMessageMs || updatedMs || lastActivityMs;
    if (!lastUserMs || !responseMs || responseMs >= lastUserMs) {
      generating = false;
      inactiveReason = 'completion_signal';
    }
  }

  return applyActiveGenerationStaleCutoff(
    {
      generating,
      start_signal_at: toIso(lastUserMs || updatedMs || lastActivityMs),
      last_activity_at: toIso(lastActivityMs),
      inactive_reason: inactiveReason,
    },
    options
  );
}


async function readGeminiProjectsIndex(homeDir = os.homedir()) {
  const p = getGeminiProjectsIndexPath(homeDir);
  let raw = '';
  try {
    raw = await fsp.readFile(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && parsed.projects && typeof parsed.projects === 'object'
      ? parsed.projects
      : {};
  } catch {
    return {};
  }
}

function normalizeWorkspacePathForLookup(workspacePath) {
  const resolved = path.resolve(String(workspacePath || '').trim());
  if (process.platform === 'win32') return resolved.toLowerCase();
  return resolved;
}

async function resolveGeminiProjectSlug(workspacePath, homeDir = os.homedir()) {
  if (typeof workspacePath !== 'string' || !workspacePath.trim()) return '';
  const projects = await readGeminiProjectsIndex(homeDir);
  const target = normalizeWorkspacePathForLookup(workspacePath);
  for (const [projectPath, slug] of Object.entries(projects)) {
    if (normalizeWorkspacePathForLookup(projectPath) === target && typeof slug === 'string' && slug.trim()) {
      return slug.trim();
    }
  }
  return '';
}

/** Gemini A2A server sessions (e.g. session-*-a2a-serv.jsonl, thread title "a2a-server") are not user chats — hide from watch picker. */
const GEMINI_A2A_TITLE_RE = /\ba2a[-\s]?serv(er)?\b/i;
const GEMINI_A2A_PATH_RE = /[-_]a2a[-_]?serv/i;

function isGeminiA2aServerExcludedFromWatch(fields = {}) {
  const title = typeof fields.title === 'string' ? fields.title : '';
  const sessionId = typeof fields.session_id === 'string' ? fields.session_id : '';
  const threadId = typeof fields.id === 'string' ? fields.id : '';
  const transcriptPath = typeof fields.transcript_path === 'string' ? fields.transcript_path : '';
  const preview = typeof fields.last_user_preview === 'string' ? fields.last_user_preview : '';
  const base = transcriptPath ? path.basename(transcriptPath) : '';
  const hay = `${title}\n${sessionId}\n${threadId}\n${preview}\n${base}`;
  return GEMINI_A2A_TITLE_RE.test(hay) || GEMINI_A2A_PATH_RE.test(hay);
}

function parseGeminiChatFileName(fileName) {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  const chatMatch = base.match(/^chat-(.+)-([a-f0-9]{8})$/i);
  if (chatMatch) return chatMatch[2];
  const sessionMatch = base.match(/^session-(.+)-([a-f0-9]{8})$/i);
  if (sessionMatch) return sessionMatch[2];
  return base;
}

function parseGeminiJsonlConversation(text) {
  const messages = [];
  let sessionId = '';
  let lastUpdated = '';
  let startTime = '';
  const tsOf = (rec) => rec?.timestamp || rec?.createdAt || rec?.created_at || '';
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== 'object') continue;
    if (rec.kind === 'main' && typeof rec.sessionId === 'string') {
      sessionId = rec.sessionId.trim() || sessionId;
      if (typeof rec.lastUpdated === 'string') lastUpdated = rec.lastUpdated;
      if (typeof rec.startTime === 'string') startTime = rec.startTime;
      continue;
    }
    if (rec.$set && typeof rec.$set === 'object' && typeof rec.$set.lastUpdated === 'string') {
      lastUpdated = rec.$set.lastUpdated;
      continue;
    }
    if (rec.type === 'USER_INPUT' && typeof rec.content === 'string') {
      const ts = tsOf(rec);
      messages.push({
        type: 'user',
        timestamp: ts,
        content: rec.content,
      });
      if (typeof ts === 'string' && ts && (!lastUpdated || ts > lastUpdated)) {
        lastUpdated = ts;
      }
      continue;
    }
    if (rec.type === 'ASK_QUESTION' || rec.type === 'RUN_COMMAND') {
      const ts = tsOf(rec);
      messages.push({
        type: 'gemini',
        timestamp: ts,
        toolCalls: [
          {
            name: rec.type === 'ASK_QUESTION' ? 'ask_question' : 'run_command',
            status: String(rec.status || '').toLowerCase() === 'done' ? 'completed' : 'pending',
            result: rec.answerPreview || rec.output || rec.content || null,
          },
        ],
      });
      if (typeof ts === 'string' && ts && (!lastUpdated || ts > lastUpdated)) {
        lastUpdated = ts;
      }
      continue;
    }
    // Antigravity transcripts often end with model planner/code/view messages.
    // Treat them as assistant output so completion detection can close the turn.
    if (
      rec.source === 'MODEL' &&
      (rec.type === 'PLANNER_RESPONSE' || rec.type === 'VIEW_FILE' || rec.type === 'CODE_ACTION')
    ) {
      const ts = tsOf(rec);
      messages.push({
        type: 'gemini',
        timestamp: ts,
        content: typeof rec.content === 'string' ? rec.content : '',
      });
      if (typeof ts === 'string' && ts && (!lastUpdated || ts > lastUpdated)) {
        lastUpdated = ts;
      }
      continue;
    }
    if (
      rec.type === 'user' ||
      rec.type === 'gemini' ||
      (rec.type === 'info' && geminiMessageIsRequestCancelled(rec))
    ) {
      messages.push(rec);
      if (typeof rec.timestamp === 'string' && (!lastUpdated || rec.timestamp > lastUpdated)) {
        lastUpdated = rec.timestamp;
      }
    }
  }
  return { sessionId, lastUpdated, startTime, messages };
}

function parseGeminiTranscriptText(text, fileName = '') {
  const isJsonl = String(fileName || '').toLowerCase().endsWith('.jsonl');
  if (isJsonl) return parseGeminiJsonlConversation(text);
  try {
    const parsed = JSON.parse(String(text || ''));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Fall through to JSONL parsing as a best-effort recovery so partial files
    // (e.g. a truncated tail or a future jsonl path passed without a suffix)
    // still surface their messages instead of returning nothing.
    return parseGeminiJsonlConversation(text);
  }
  return null;
}



const DEFAULT_DISCOVERY_DEPTH = 2;

async function collectGeminiTranscriptFiles(rootDir, maxDepth = DEFAULT_DISCOVERY_DEPTH) {
  const out = [];
  async function walk(dir, depth) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return;
      throw err;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth + 1 <= maxDepth) await walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.json') && !entry.name.endsWith('.jsonl')) continue;
      out.push(abs);
    }
  }
  await walk(rootDir, 0);
  return out;
}

async function discoverGeminiRuns(workspacePath = process.cwd(), options = {}) {
  console.warn('[deprecation] Discovering legacy Gemini CLI runs from ~/.gemini/tmp. Support for legacy Gemini CLI is deprecated and will be removed in a future release.');
  const maxRuns =
    Number.isInteger(options.maxRuns) && options.maxRuns > 0 ? options.maxRuns : DEFAULT_MAX_RUNS;
  const homeDir = options.homeDir || os.homedir();
  const slug = await resolveGeminiProjectSlug(workspacePath, homeDir);
  const runs = [];
  if (!slug) {
    return [];
  }
  const chatsDir = path.join(getGeminiTmpRoot(homeDir), slug, 'chats');
  const transcriptPaths = await collectGeminiTranscriptFiles(chatsDir);
  for (const transcriptPath of transcriptPaths) {
    const fileName = path.basename(transcriptPath);
    let st;
    try {
      st = await fsp.stat(transcriptPath);
    } catch {
      continue;
    }
    let raw = '';
    try {
      raw = await fsp.readFile(transcriptPath, 'utf8');
    } catch {
      raw = '';
    }
    const convo = parseGeminiTranscriptText(raw, fileName);
    const sessionId =
      typeof convo?.sessionId === 'string' && convo.sessionId.trim()
        ? convo.sessionId.trim()
        : parseGeminiChatFileName(fileName);
    const preview = latestGeminiUserPreviewFromConversation(convo, 10);
    const lastUserPreview = preview || sessionId;
    if (
      isGeminiA2aServerExcludedFromWatch({
        transcript_path: transcriptPath,
        last_user_preview: lastUserPreview,
        session_id: sessionId,
      })
    )
      continue;
    const activityMs = Date.parse(convo?.lastUpdated || '') || st.mtimeMs || 0;
    const run = {
      kind: 'ide_agent',
      provider: 'gemini',
      source: 'local',
      session_id: sessionId,
      transcript_path: transcriptPath,
      title: '',
      workspace_path: workspacePath,
      updated_at: typeof convo?.lastUpdated === 'string' ? convo.lastUpdated : toIso(activityMs),
      mtime_ms: activityMs,
      last_user_preview: lastUserPreview,
      ...classifyGeminiActiveGenerationFromConversation(convo, {
        mtimeMs: activityMs,
        nowMs: options.nowMs,
        activeStaleMs: options.activeStaleMs,
        completionQuietMs: options.completionQuietMs,
      }),
    };
    if (typeof options.getGeminiCompletionHint === 'function') {
      const hint = options.getGeminiCompletionHint(run);
      applyGeminiHookHintMerge(run, hint);
    }
    runs.push(run);
  }
  runs.sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0));
  return runs.slice(0, maxRuns);
}



function parseRemoteGeminiFindOutput(output) {
  const rows = [];
  const lines = String(output || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const [mtimeRaw, transcriptPathRaw] = line.split('\t');
    if (!mtimeRaw || !transcriptPathRaw) continue;
    const transcriptPath = transcriptPathRaw.trim();
    if (!transcriptPath.endsWith('.json') && !transcriptPath.endsWith('.jsonl')) continue;
    rows.push({
      kind: 'ide_agent',
      provider: 'gemini',
      source: 'ssh',
      session_id: parseGeminiChatFileName(path.posix.basename(transcriptPath)),
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

async function discoverRemoteGeminiRuns(remote, workspacePath, options = {}) {
  console.warn('[deprecation] Discovering remote legacy Gemini CLI runs from ~/.gemini/tmp. Support for legacy Gemini CLI is deprecated and will be removed in a future release.');
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  const maxRuns =
    Number.isInteger(options.maxRuns) && options.maxRuns > 0 ? options.maxRuns : DEFAULT_MAX_RUNS;
  if (typeof workspacePath !== 'string' || !workspacePath.trim()) return [];
  const workspaceQuoted = shellQuote(workspacePath.trim());
  const slugCmd =
    "python3 - <<'PY'\n" +
    'import json, os, sys\n' +
    "p = os.path.expanduser('~/.gemini/projects.json')\n" +
    `target = ${workspaceQuoted}\n` +
    'try:\n' +
    "    data = json.load(open(p, 'r', encoding='utf-8'))\n" +
    'except Exception:\n' +
    '    data = {}\n' +
    "projects = data.get('projects') if isinstance(data, dict) else {}\n" +
    "if not isinstance(projects, dict):\n" +
    '    projects = {}\n' +
    'for k, v in projects.items():\n' +
    "    if isinstance(k, str) and isinstance(v, str) and os.path.abspath(k) == os.path.abspath(target):\n" +
    '        print(v)\n' +
    '        break\n' +
    'PY';
  const slug = String(await runSsh(cfg.host, slugCmd, options.timeoutMs)).trim();
  const runs = [];
  if (slug) {
    const findCmd =
      `find $HOME/.gemini/tmp/${shellQuote(slug)}/chats -type f \\( -name '*.json' -o -name '*.jsonl' \\) ` +
      `-printf '%T@\\t%p\\n' 2>/dev/null | sort -nr | head -n ${String(maxRuns)}`;
    const stdout = await runSsh(cfg.host, findCmd, options.timeoutMs);
    runs.push(...parseRemoteGeminiFindOutput(stdout).slice(0, maxRuns));
  }
  await Promise.all(
    runs.map(async (run) => {
      const q = shellQuote(run.transcript_path);
      const tailCmd = `if [ -f ${q} ]; then tail -c ${DEFAULT_TAIL_BYTES} ${q} 2>/dev/null || true; fi`;
      try {
        const raw = await runSsh(cfg.host, tailCmd, options.timeoutMs);
        const convo = parseGeminiTranscriptText(String(raw || ''), run.transcript_path) || {};
        run.session_id =
          typeof convo?.sessionId === 'string' && convo.sessionId.trim() ? convo.sessionId.trim() : run.session_id;
        run.updated_at = typeof convo?.lastUpdated === 'string' ? convo.lastUpdated : '';
        run.workspace_path = workspacePath;
        run.last_user_preview = latestGeminiUserPreviewFromConversation(convo, 10) || run.session_id;
        Object.assign(
          run,
          classifyGeminiActiveGenerationFromConversation(convo, {
            mtimeMs: run.mtime_ms,
            nowMs: options.nowMs,
            activeStaleMs: options.activeStaleMs,
            completionQuietMs: options.completionQuietMs,
          })
        );
      } catch {
        run.workspace_path = workspacePath;
        run.last_user_preview = run.session_id;
        Object.assign(
          run,
          classifyGeminiActiveGenerationFromConversation(null, {
            mtimeMs: run.mtime_ms,
            nowMs: options.nowMs,
            activeStaleMs: options.activeStaleMs,
            completionQuietMs: options.completionQuietMs,
          })
        );
      }
      if (typeof options.getGeminiCompletionHint === 'function') {
        const hint = options.getGeminiCompletionHint(run);
        applyGeminiHookHintMerge(run, hint);
      }
      run.host = cfg.host;
      run.projects_root = cfg.projects_root;
    })
  );
  const transcriptOnly = runs.filter((run) => !isGeminiA2aServerExcludedFromWatch(run));
  transcriptOnly.sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0));
  return transcriptOnly.slice(0, maxRuns);
}

async function geminiTaskCancelledSince(transcriptPath, linkedAtIso, homeDir = os.homedir()) {
  const resolved = assertAllowedGeminiTranscriptPath(transcriptPath, homeDir);
  let raw = '';
  try {
    raw = await fsp.readFile(resolved, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  const conversation = parseGeminiTranscriptText(raw, resolved);
  if (!conversation) return false;
  return geminiConversationCancelledSince(conversation, linkedAtIso);
}

async function remoteGeminiTaskCancelledSince(remote, transcriptPath, linkedAtIso, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  const quotedPath = shellQuote(transcriptPath);
  const cmd = `if [ -f ${quotedPath} ]; then cat ${quotedPath} 2>/dev/null || true; fi`;
  const raw = await runSsh(cfg.host, cmd, options.timeoutMs);
  const conversation = parseGeminiTranscriptText(String(raw || ''), transcriptPath);
  if (!conversation) return false;
  return geminiConversationCancelledSince(conversation, linkedAtIso);
}

async function geminiTaskCompletedSince(transcriptPath, linkedAtIso, homeDir = os.homedir(), options = {}) {
  const resolved = assertAllowedGeminiTranscriptPath(transcriptPath, homeDir);
  let raw = '';
  try {
    raw = await fsp.readFile(resolved, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  const conversation = parseGeminiTranscriptText(raw, resolved);
  if (!conversation) return false;
  return geminiConversationDoneSince(conversation, linkedAtIso, options);
}

async function remoteGeminiTaskCompletedSince(remote, transcriptPath, linkedAtIso, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  const quotedPath = shellQuote(transcriptPath);
  const cmd = `if [ -f ${quotedPath} ]; then cat ${quotedPath} 2>/dev/null || true; fi`;
  const raw = await runSsh(cfg.host, cmd, options.timeoutMs);
  const conversation = parseGeminiTranscriptText(String(raw || ''), transcriptPath);
  if (!conversation) return false;
  return geminiConversationDoneSince(conversation, linkedAtIso, options);
}

function geminiLogRunMatchesTracking(run, ideTracking) {
  if (!run || !ideTracking) return false;
  const requestId = typeof ideTracking.log_request_id === 'string' ? ideTracking.log_request_id.trim() : '';
  if (requestId && run.log_request_id === requestId) return true;
  const sessionId = typeof ideTracking.session_id === 'string' ? ideTracking.session_id.trim() : '';
  if (sessionId && run.session_id === sessionId) return true;
  const preview = normalizePreviewKey(ideTracking.last_user_preview);
  if (preview && normalizePreviewKey(run.last_user_preview) === preview) return true;
  return false;
}

function geminiLogRunsCompletedForTracking(runs, ideTracking) {
  for (const run of runs || []) {
    if (!geminiLogRunMatchesTracking(run, ideTracking)) continue;
    if (run.log_done_at || run.inactive_reason === 'cancelled') return true;
  }
  return false;
}


function geminiRunActivityMs(run) {
  if (!run || typeof run !== 'object') return 0;
  return Math.max(
    Date.parse(run.updated_at || '') || 0,
    Date.parse(run.last_activity_at || '') || 0,
    Number.isFinite(run.mtime_ms) ? run.mtime_ms : 0
  );
}

function findGeminiHookSnapshotForRun(run, snapshots) {
  if (!run || !Array.isArray(snapshots) || !snapshots.length) return null;
  const wantedSession = typeof run.session_id === 'string' ? run.session_id.trim() : '';
  const wantedTranscript = typeof run.transcript_path === 'string' ? run.transcript_path.trim() : '';
  const matches = snapshots.filter((snap) => {
    if (!snap) return false;
    const snapSession = typeof snap.session_id === 'string' ? snap.session_id.trim() : '';
    const snapTranscript = typeof snap.transcript_path === 'string' ? snap.transcript_path.trim() : '';
    if (wantedSession && snapSession && wantedSession === snapSession) return true;
    return !!(wantedTranscript && snapTranscript && wantedTranscript === snapTranscript);
  });
  if (!matches.length) return null;
  matches.sort((a, b) => (Date.parse(b.updated_at || '') || 0) - (Date.parse(a.updated_at || '') || 0));
  return matches.find((snap) => snap.generating === true) || matches[0];
}

// agy leaves snap.generating=true after a partial Stop (NO_TOOL_CALL, fullyIdle:false),
// e.g. when the foreground turn is done with a background task still running. Reuse the
// watch's idle check so the picker stops treating a quiet partial stop as live too.
// See lib/antigravity_transcript_idle.js.
function agySnapshotQuietPartialStop(snap, nowMs = Date.now()) {
  if (!snap) return false;
  const partialStopAtMs = Date.parse(snap.agy_last_partial_stop_at || '') || 0;
  if (!partialStopAtMs) return false;
  const hookActivityAtMs = Date.parse(snap.agy_last_hook_activity_at || '') || 0;
  const scheduledWakeupAtMs = Date.parse(snap.agy_scheduled_wakeup_at || '') || 0;
  // Picker enrichment is per-snapshot (no sub-agent tree), so the conversation's own last hook
  // activity is the quiescence anchor: a partial-stopped run that resumed but then went quiet for
  // the window reads as done (matching the watch poller's tree-wide rule for a single conversation).
  const inflightSinceMs = snap.agy_inflight_tool_step != null ? Date.parse(snap.agy_inflight_tool_at || '') || 0 : 0;
  return !!evaluateAgyTranscriptIdleCompletion({
    partialStopAtMs,
    treeLastActivityMs: hookActivityAtMs,
    scheduledWakeupAtMs,
    inflightToolCall: inflightSinceMs > 0,
    inflightSinceMs,
    questionPending: !!snap.question_pending,
    permissionPending: !!snap.permission_pending,
    nowMs,
  });
}

function enrichGeminiPickerRunWithHook(run, snap) {
  if (!run || typeof run !== 'object') return run;
  if (!snap) return run;
  const snapMs = Date.parse(snap.updated_at || '') || 0;
  const runMs = geminiRunActivityMs(run);
  const antigravityTranscript = isAntigravityTranscriptPath(run.transcript_path || '');
  // Once an agy partial stop has gone quiet, the foreground turn is done — show it as
  // completed in the picker rather than live (hooks are the source of truth for agy).
  if (antigravityTranscript && agySnapshotQuietPartialStop(snap)) {
    return {
      ...run,
      generating: false,
      completion_hint: true,
      inactive_reason: run.inactive_reason || 'completion_signal',
      last_activity_at: run.last_activity_at || toIso(Math.max(runMs, snapMs)),
    };
  }
  const permissionPending =
    (snap.event_name === 'Notification' && snap.notification_type === 'ToolPermission') ||
    snap.permission_pending === true;
  const questionPending = snap.question_pending === true;
  if (permissionPending || questionPending) {
    return {
      ...run,
      generating: true,
      start_signal_at: run.start_signal_at || toIso(snapMs || runMs),
      last_activity_at: run.last_activity_at || toIso(Math.max(runMs, snapMs)),
      inactive_reason: '',
      completion_hint: false,
      notification_type: permissionPending ? 'ToolPermission' : run.notification_type || '',
      permission_pending: permissionPending,
      question_pending: questionPending,
    };
  }
  // For agy/app transcripts, hooks are the source of truth for live state.
  // Transcript appends can race and transiently look "idle" while hooks still
  // indicate active generation, so do not require snap timestamp dominance.
  const hookStillLive =
    !!snap.generating &&
    snap.event_source_kind !== 'scan' &&
    (antigravityTranscript || !runMs || !snapMs || snapMs >= runMs);
  const pickerGenerating = hookStillLive || !!run.generating;
  if (hookStillLive) {
    return {
      ...run,
      generating: true,
      start_signal_at: run.start_signal_at || toIso(snapMs || runMs),
      last_activity_at: run.last_activity_at || toIso(Math.max(runMs, snapMs)),
      inactive_reason: '',
      completion_hint: false,
    };
  }
  const activeGen = applyActiveGenerationStaleCutoff(
    {
      generating: pickerGenerating,
      start_signal_at: run.start_signal_at || toIso(snapMs || runMs),
      last_activity_at: run.last_activity_at || toIso(Math.max(runMs, snapMs)),
      inactive_reason: pickerGenerating ? '' : run.inactive_reason || 'completion_signal',
    },
    { mtimeMs: run.mtime_ms, nowMs: Date.now() }
  );
  return {
    ...run,
    ...activeGen,
    completion_hint: pickerGenerating ? false : !!run.completion_hint,
  };
}

// Remote (ssh) agy title cache: `${host}:${convId}` -> { title, checkedMs }. Titles live on the
// remote host — agy-cli in a sqlite conversation_summaries.db, agy-app in a protobuf summary hub —
// neither reachable by the local agy_summaries reader. Found titles are immutable → cached forever;
// a miss is re-checked at most every REMOTE_AGY_TITLE_RECHECK_MS. Never throws.
const remoteAgyTitleCache = new Map();
const REMOTE_AGY_TITLE_CACHE_MAX = 512;
const REMOTE_AGY_TITLE_RECHECK_MS = 30000;

// agy-cli: query the remote conversation_summaries.db with python's stdlib sqlite3 (the repo's
// established remote-sqlite pattern), WAL-safe via ?mode=ro then ?immutable=1.
async function fetchRemoteAgyCliTitle(host, conv, runSsh, timeoutMs) {
  const params = Buffer.from(JSON.stringify({ conv }), 'utf8').toString('base64');
  const py = [
    'import json,base64,os,sqlite3',
    `P=json.loads(base64.b64decode("${params}").decode())`,
    'conv=P["conv"]',
    'p=os.path.expanduser("~/.gemini/antigravity-cli/conversation_summaries.db")',
    'def q(uri):',
    '  conn=sqlite3.connect(uri,uri=True,timeout=0.5)',
    '  try:',
    '    r=conn.execute("SELECT title FROM conversation_summaries WHERE conversation_id=?",(conv,)).fetchone()',
    '    return (r[0] or "") if r else ""',
    '  finally: conn.close()',
    'title=""',
    'if os.path.exists(p):',
    '  for uri in ("file:"+p+"?mode=ro","file:"+p+"?immutable=1"):',
    '    try:',
    '      title=q(uri)',
    '      break',
    '    except Exception:',
    '      title=""',
    'print(json.dumps({"ok":True,"title":title or ""}))',
  ].join('\n');
  const cmd = `python3 - <<'AGY_CLI_TITLE_PYEOF'\n${py}\nAGY_CLI_TITLE_PYEOF`;
  const out = await runSsh(host, cmd, timeoutMs);
  const res = JSON.parse(String(out || '').trim() || '{}');
  return res && res.ok ? String(res.title || '').trim() : '';
}

// agy-app: pull the proto summary-hub bytes (base64) and parse them LOCALLY with the same
// parseHubProto the local reader uses. The hub is a single global file (~1MB); the caller caches the
// resolved title so this whole-file pull runs at most once per conversation until it changes.
async function fetchRemoteAgyAppTitle(host, conv, runSsh, timeoutMs) {
  const cmd = `f="$HOME/.gemini/antigravity/agyhub_summaries_proto.pb"; if [ -f "$f" ]; then base64 < "$f" 2>/dev/null || true; fi`;
  const out = await runSsh(host, cmd, timeoutMs);
  const b64 = String(out || '').replace(/\s+/g, '');
  if (!b64) return '';
  try {
    const map = require('./agy_summaries').parseHubProto(Buffer.from(b64, 'base64'));
    if (map && typeof map.get === 'function') {
      return String(map.get(String(conv).toLowerCase()) || '').trim();
    }
  } catch {
    /* torn/unknown proto framing → no title */
  }
  return '';
}

async function fetchRemoteAgyTitle({ conversationId, surface, remote, runSsh, timeoutMs }) {
  try {
    const conv = String(conversationId || '').trim();
    if (!conv) return '';
    const cfg = assertValidRemoteSource(remote);
    const cacheKey = `${cfg.host}:${conv}`;
    const cached = remoteAgyTitleCache.get(cacheKey);
    if (cached && cached.title) return cached.title;
    if (cached && Date.now() - cached.checkedMs < REMOTE_AGY_TITLE_RECHECK_MS) return '';
    const ssh = runSsh || createSshRunner();
    const s = String(surface || '').toLowerCase();
    let title = '';
    if (s === 'desktop' || s === 'app') {
      title = await fetchRemoteAgyAppTitle(cfg.host, conv, ssh, timeoutMs);
    } else if (s === 'cli') {
      title = await fetchRemoteAgyCliTitle(cfg.host, conv, ssh, timeoutMs);
    } else {
      // Unknown surface — try the cheap cli sqlite first, then the app proto pull.
      title = await fetchRemoteAgyCliTitle(cfg.host, conv, ssh, timeoutMs);
      if (!title) title = await fetchRemoteAgyAppTitle(cfg.host, conv, ssh, timeoutMs);
    }
    if (remoteAgyTitleCache.size >= REMOTE_AGY_TITLE_CACHE_MAX) remoteAgyTitleCache.clear();
    remoteAgyTitleCache.set(cacheKey, { title, checkedMs: Date.now() });
    return title;
  } catch {
    return '';
  }
}

async function enrichGeminiPickerRunWithTranscript(run, snap, options = {}) {
  if (!run || typeof run !== 'object') return run;
  const out = { ...run };
  if (run.source === 'ssh' && options.hookOnlyRemote) {
    return enrichGeminiPickerRunWithHook(out, snap);
  }
  const transcriptPath = typeof run.transcript_path === 'string' ? run.transcript_path.trim() : '';
  if (transcriptPath) {
    try {
      let raw = '';
      let mtimeMs = Number.isFinite(run.mtime_ms) ? run.mtime_ms : 0;
      if (run.source === 'ssh' && options.remote) {
        const cfg = assertValidRemoteSource(options.remote);
        const runSsh = options.runSsh || createSshRunner();
        const q = shellQuote(transcriptPath);
        const tailCmd = `if [ -f ${q} ]; then tail -c ${DEFAULT_TAIL_BYTES} ${q} 2>/dev/null || true; fi`;
        raw = await runSsh(cfg.host, tailCmd, options.timeoutMs);
      } else {
        const resolved = assertAllowedGeminiTranscriptPath(transcriptPath, options.homeDir);
        const st = await fsp.stat(resolved);
        mtimeMs = st.mtimeMs || mtimeMs;
        raw = await fsp.readFile(resolved, 'utf8');
        if (raw.length > DEFAULT_TAIL_BYTES) raw = raw.slice(-DEFAULT_TAIL_BYTES);
      }
      if (String(raw || '').trim()) {
        const convo = parseGeminiTranscriptText(String(raw || ''), transcriptPath) || {};
        const preview = latestGeminiUserPreviewFromConversation(convo, 10);
        if (preview) out.last_user_preview = preview;
        Object.assign(
          out,
          classifyGeminiActiveGenerationFromConversation(convo, {
            mtimeMs,
            nowMs: options.nowMs,
            activeStaleMs: options.activeStaleMs,
            completionQuietMs: options.completionQuietMs,
          })
        );
        if (out.generating) out.completion_hint = false;
      }
    } catch {
      // Keep hook-derived generation when the transcript is missing or unreadable.
    }
  }
  // agy transcripts carry no chat title; resolve it from Antigravity's summary stores (agy-app proto
  // hub + agy-cli sqlite). Local: cached + mtime-gated Map lookup on the hot poll path. Remote: read
  // the same stores on the remote host over ssh (dispatched by surface), cached per host+conversation.
  // Never throws (returns '' when unknown).
  if (!out.title) {
    const convId = out.session_id || out.conversation_id || run.session_id;
    if (run.source === 'ssh') {
      if (run.host) {
        out.title = await fetchRemoteAgyTitle({
          conversationId: convId,
          surface: out.surface || run.surface || (snap && snap.agy_agent_kind) || '',
          remote: options.remote || { host: run.host, projects_root: run.projects_root },
          runSsh: options.runSsh,
          timeoutMs: options.timeoutMs,
        });
      }
    } else {
      out.title = require('./agy_summaries').titleForConversation(convId) || '';
    }
  }
  return enrichGeminiPickerRunWithHook(out, snap);
}

async function enrichGeminiHookPickerRuns(runs, snapshots, options = {}) {
  if (!Array.isArray(runs) || !runs.length) return runs || [];
  const snaps = Array.isArray(snapshots) ? snapshots : [];
  return Promise.all(
    runs.map((run) => {
      const snap = findGeminiHookSnapshotForRun(run, snaps);
      const runOpts =
        run && run.source === 'ssh' && run.host
          ? {
              ...options,
              remote: { host: run.host, projects_root: run.projects_root },
              hookOnlyRemote: options.hookOnlyRemote !== false,
            }
          : options;
      return enrichGeminiPickerRunWithTranscript(run, snap, runOpts);
    })
  );
}

module.exports = {
  DEFAULT_MAX_RUNS,
  applyGeminiHookHintMerge,
  assertAllowedGeminiTranscriptPath,
  assertAllowedRemoteGeminiTranscriptPath,
  discoverGeminiRuns,
  discoverRemoteGeminiRuns,
  geminiConversationCancelledSince,
  geminiMessageHasCancelledTool,
  geminiMessageHasPendingToolCalls,
  geminiMessageIsRequestCancelled,
  findGeminiHookSnapshotForRun,
  enrichGeminiPickerRunWithHook,
  enrichGeminiPickerRunWithTranscript,
  enrichGeminiHookPickerRuns,
  geminiTaskCancelledSince,
  geminiConversationDoneSince,
  geminiTaskCompletedSince,
  remoteGeminiTaskCancelledSince,
  remoteGeminiTaskCompletedSince,
  latestGeminiUserPreviewFromConversation,
  parseGeminiJsonlConversation,
  parseGeminiTranscriptText,
  classifyGeminiActiveGenerationFromConversation,
  isAntigravityTranscriptPath,
  getAntigravityBrainRoots,
};
