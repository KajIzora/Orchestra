const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { assertValidRemoteSource, createSshRunner } = require('./remote_cursor_tracker');
const { truncateCleanHumanPromptPreview } = require('./human_prompt_preview');
const { applyActiveGenerationStaleCutoff, toIso } = require('./active_generation');
const { isUserRequestInterruptedPreview } = require('./request_interrupted_preview');

const DEFAULT_MAX_RUNS = 20;
const DEFAULT_TAIL_BYTES = 512 * 1024;
const REMOTE_CLAUDE_ROOT = '$HOME/.claude/projects';

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

function getClaudeRoot(homeDir = os.homedir()) {
  return path.resolve(path.join(homeDir, '.claude'));
}

function getClaudeProjectsRoot(homeDir = os.homedir()) {
  return path.resolve(path.join(getClaudeRoot(homeDir), 'projects'));
}

function assertAllowedClaudeTranscriptPath(transcriptPath, homeDir = os.homedir()) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.trim()) {
    throw new Error('transcript_path is required');
  }
  const resolved = path.resolve(transcriptPath.trim());
  const allowedRoot = getClaudeProjectsRoot(homeDir);
  const prefix = allowedRoot.endsWith(path.sep) ? allowedRoot : `${allowedRoot}${path.sep}`;
  if (resolved !== allowedRoot && !resolved.startsWith(prefix)) {
    throw new Error('transcript_path must be under ~/.claude/projects');
  }
  if (!resolved.endsWith('.jsonl')) {
    throw new Error('transcript_path must be a .jsonl file');
  }
  return resolved;
}

function walkProjectJsonl(projectsRoot) {
  const out = [];
  if (!fs.existsSync(projectsRoot)) return out;
  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const proj of projectDirs) {
    if (!proj.isDirectory()) continue;
    const projectPath = path.join(projectsRoot, proj.name);
    let entries = [];
    try {
      entries = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      out.push(path.join(projectPath, entry.name));
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

// Byte cap for the remote (ssh) title grep output — see fetchRemoteClaudeTitle.
const TITLE_HEAD_BYTES = 256 * 1024;

// Pull the chat title out of a whole transcript. Claude Code's auto `ai-title` sits near the HEAD,
// but Claude Desktop's user/Desktop-assigned `custom-title` is appended whenever the title is set —
// so in a multi-turn chat it lands mid-file (past the head window, and buried before the tail by
// later turns). A windowed read misses it, so scan the whole file; to stay cheap on multi-MB
// transcripts, only JSON-parse the handful of lines carrying a title marker. A custom title wins
// over the auto ai-title (see extractClaudeSessionMetadata).
function titleFromTranscriptFullScan(text) {
  const str = String(text || '');
  if (str.indexOf('-title"') === -1) return ''; // no ai-title / custom-title record anywhere
  let aiTitle = '';
  let customTitle = '';
  for (const line of str.split('\n')) {
    if (line.indexOf('-title"') === -1) continue;
    let obj;
    try {
      obj = JSON.parse(line.trim());
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') aiTitle = obj.aiTitle.trim();
    else if (obj.type === 'custom-title' && typeof obj.customTitle === 'string') customTitle = obj.customTitle.trim();
  }
  return customTitle || aiTitle;
}

// transcriptPath -> { mtimeMs, title }. A found title is treated as stable and cached (a Desktop
// mid-session rename won't reflect until the cache is evicted — a rare, cosmetic staleness we accept
// to keep the hot poll path off a full-file rescan while a chat is actively generating). An empty
// result is only re-read when the file changes (the title usually appears after the first turn).
// Bounded to avoid unbounded growth across sessions.
const claudeTitleCache = new Map();
const CLAUDE_TITLE_CACHE_MAX = 512;

function claudeTitleForTranscript(transcriptPath, homeDir = os.homedir()) {
  try {
    const resolved = assertAllowedClaudeTranscriptPath(transcriptPath, homeDir);
    const cached = claudeTitleCache.get(resolved);
    if (cached && cached.title) return cached.title; // found → stable, done
    const mtimeMs = fs.statSync(resolved).mtimeMs || 0;
    if (cached && cached.mtimeMs === mtimeMs) return ''; // no title, file unchanged → skip re-read
    const title = titleFromTranscriptFullScan(fs.readFileSync(resolved, 'utf8'));
    if (claudeTitleCache.size >= CLAUDE_TITLE_CACHE_MAX) claudeTitleCache.clear();
    claudeTitleCache.set(resolved, { mtimeMs, title });
    return title;
  } catch {
    return '';
  }
}

// Remote (ssh) Claude title cache: `${host}:${path}` -> { title, checkedMs }. Neither the ssh-fetched
// tail (512KB from END) nor a head read reliably carries the title: the ai-title lives near the HEAD,
// but Claude Desktop's custom-title lands wherever it was set (mid-file on multi-turn chats). So grep
// the whole remote file for the two title markers — cheap, and position-independent. Found titles are
// cached (see claudeTitleForTranscript for the rename-staleness note); a miss is re-checked at most
// every REMOTE_TITLE_RECHECK_MS so a still-generating title appears without an ssh round-trip on every
// poll. Never throws.
const remoteClaudeTitleCache = new Map();
const REMOTE_TITLE_RECHECK_MS = 30000;

async function fetchRemoteClaudeTitle(transcriptPath, remote, runSsh, timeoutMs) {
  try {
    const cfg = assertValidRemoteSource(remote);
    const key = `${cfg.host}:${transcriptPath}`;
    const cached = remoteClaudeTitleCache.get(key);
    if (cached && cached.title) return cached.title;
    if (cached && Date.now() - cached.checkedMs < REMOTE_TITLE_RECHECK_MS) return '';
    const ssh = runSsh || createSshRunner();
    const q = shellQuote(transcriptPath);
    // Only the title lines come back; cap the output in case a transcript is pathological.
    const cmd = `if [ -f ${q} ]; then grep -E '"(ai-title|custom-title)"' ${q} 2>/dev/null | tail -c ${TITLE_HEAD_BYTES} || true; fi`;
    const matched = await ssh(cfg.host, cmd, timeoutMs);
    // A truncated leading line is tolerated: titleFromTranscriptFullScan skips unparseable lines.
    const title = titleFromTranscriptFullScan(String(matched || ''));
    if (remoteClaudeTitleCache.size >= CLAUDE_TITLE_CACHE_MAX) remoteClaudeTitleCache.clear();
    remoteClaudeTitleCache.set(key, { title, checkedMs: Date.now() });
    return title;
  } catch {
    return '';
  }
}

function extractClaudeUserMessageRawText(obj) {
  if (!obj || obj.type !== 'user') return '';
  if (obj.isMeta === true) return '';
  if (obj.parent_tool_use_id || obj.tool_use_result != null) return '';
  const content = obj?.message?.content;
  if (typeof content === 'string') {
    return content.replace(/\s+/g, ' ').trim();
  }
  if (!Array.isArray(content)) return '';
  const pieces = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_result') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      pieces.push(block.text.trim());
    }
  }
  return pieces.join(' ').replace(/\s+/g, ' ').trim();
}

function isClaudeUserRequestInterrupted(obj) {
  if (!obj || obj.type !== 'user') return false;
  const raw = extractClaudeUserMessageRawText(obj);
  if (!raw) return false;
  return isUserRequestInterruptedPreview(raw);
}

function extractClaudeAskUserQuestionAnswerText(obj) {
  if (!obj || obj.type !== 'user') return '';
  const content = obj?.message?.content;
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    if (!block || block.type !== 'tool_result' || typeof block.content !== 'string') continue;
    const text = block.content.replace(/\s+/g, ' ').trim();
    if (/^(?:User has answered your questions|Your questions have been answered):/i.test(text)) return text;
  }
  return '';
}

function isClaudeAskUserQuestionAnswer(obj) {
  return !!extractClaudeAskUserQuestionAnswerText(obj);
}

function claudeTranscriptHasUserStartAfter(raw, sinceIso) {
  const sinceMs = Date.parse(sinceIso || '') || 0;
  if (!sinceMs) return false;
  for (const line of String(raw || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (obj.type !== 'user') continue;
    const ts = claudeEventTimeMs(obj);
    if (!ts || ts <= sinceMs) continue;
    if (isClaudeAskUserQuestionAnswer(obj)) return true;
    if (isClaudeUserRequestInterrupted(obj)) continue;
    const rawUserText = extractClaudeUserMessageRawText(obj);
    if (truncateCleanHumanPromptPreview(rawUserText, 10)) return true;
  }
  return false;
}

/** True when the last substantive user row in a transcript tail is a stop/interrupt marker. */
function claudeTranscriptTailEndsWithUserInterrupt(tailText) {
  const lines = String(tailText || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (obj.type !== 'user') continue;
    if (isClaudeUserRequestInterrupted(obj)) return true;
    const raw = extractClaudeUserMessageRawText(obj);
    if (truncateCleanHumanPromptPreview(raw, 10)) return false;
  }
  return false;
}

/**
 * Whether the Claude session JSONL shows a finished turn after `linkedAtIso`:
 * terminal assistant `stop_reason`, or a `[Request interrupted by user]` user row.
 * @param {string} raw
 * @param {string} linkedAtIso
 * @returns {boolean}
 */
function claudeTranscriptTaskCompletedSince(raw, linkedAtIso) {
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
    if (obj.type === 'user' && isClaudeUserRequestInterrupted(obj)) {
      const ts = Date.parse(obj.timestamp || '') || 0;
      if (linkedAtMs && ts < linkedAtMs) continue;
      return true;
    }
    if (obj.type !== 'assistant') continue;
    const maybeStop = obj.message && typeof obj.message === 'object' ? obj.message : null;
    if (!maybeStop) continue;
    const stopReason =
      typeof maybeStop.stop_reason === 'string' ? maybeStop.stop_reason.trim().toLowerCase() : '';
    if (!stopReason) continue;
    if (isClaudeAssistantMidTurnStopReason(stopReason)) continue;
    const ts = Date.parse(obj.timestamp || '') || 0;
    if (linkedAtMs && ts < linkedAtMs) continue;
    return stopReason !== 'error' && stopReason !== 'cancelled';
  }
  return false;
}

function latestClaudeUserPreviewFromTail(tailText, maxWords = 10) {
  if (!tailText) return '';
  const lines = tailText.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    // Claude writes a dedicated `last-prompt` record carrying the latest human prompt verbatim,
    // re-emitted repeatedly toward the tail. Prefer it: in long tool-heavy chats the last real
    // `user` text row can scroll past the tail window while a `last-prompt` still sits inside it,
    // which is what left such chats showing the bare session id instead of a prompt/title.
    if (obj && obj.type === 'last-prompt' && typeof obj.lastPrompt === 'string') {
      const preview = truncateCleanHumanPromptPreview(obj.lastPrompt, maxWords);
      if (preview && !isUserRequestInterruptedPreview(preview)) return preview;
      continue;
    }
    if (isClaudeUserRequestInterrupted(obj)) continue;
    const raw = extractClaudeUserMessageRawText(obj);
    const preview = truncateCleanHumanPromptPreview(raw, maxWords);
    if (preview) return preview;
  }
  return '';
}

// Claude Code stamps an `entrypoint` on nearly every transcript record identifying the surface the
// session runs on. Map it to Orchestra's surface kinds: 'cli'/'sdk-cli' → command line, the desktop
// app → 'desktop', and the VS Code + Cursor editor extension → 'plugin'.
function normalizeClaudeSurface(entrypoint) {
  const e = String(entrypoint || '').trim().toLowerCase();
  if (e === 'cli' || e === 'sdk-cli') return 'cli';
  if (e === 'claude-desktop') return 'desktop';
  if (e === 'claude-vscode') return 'plugin';
  return '';
}

// Scan transcript text for the first record carrying an `entrypoint` and return its surface kind.
// Used by the picker-run enricher, which reads the tail for other reasons but not session metadata.
function claudeSurfaceFromTailText(text) {
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (typeof obj.entrypoint === 'string') {
      const s = normalizeClaudeSurface(obj.entrypoint);
      if (s) return s;
    }
  }
  return '';
}

function extractClaudeSessionMetadata(tailText, fallbackSessionId) {
  const out = {
    session_id: fallbackSessionId,
    title: '',
    workspace_path: '',
    updated_at: '',
    surface: '',
  };
  let aiTitle = '';
  let customTitle = '';
  const lines = tailText.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!out.updated_at && typeof obj.timestamp === 'string') out.updated_at = obj.timestamp;
    if (!out.workspace_path && typeof obj.cwd === 'string') out.workspace_path = obj.cwd;
    if (!out.session_id && typeof obj.sessionId === 'string') out.session_id = obj.sessionId;
    // Claude Code writes an auto `ai-title`; Claude Desktop writes a user/Desktop-assigned
    // `custom-title`. When a chat has both, the custom title is the deliberate name → it wins.
    // Take the last of each in-window (a rename re-emits custom-title; the latest is current).
    if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') aiTitle = obj.aiTitle.trim();
    else if (obj.type === 'custom-title' && typeof obj.customTitle === 'string') customTitle = obj.customTitle.trim();
    if (!out.surface && typeof obj.entrypoint === 'string') out.surface = normalizeClaudeSurface(obj.entrypoint);
  }
  out.title = customTitle || aiTitle;
  return out;
}

function claudeEventTimeMs(obj) {
  return Date.parse(obj?.timestamp || obj?.message?.timestamp || '') || 0;
}

function assistantStopReason(obj) {
  if (!obj || obj.type !== 'assistant') return '';
  return typeof obj?.message?.stop_reason === 'string' ? obj.message.stop_reason.trim().toLowerCase() : '';
}

/** Assistant paused to run tools — not a finished reply; transcript will continue. */
function isClaudeAssistantMidTurnStopReason(stopReason) {
  return String(stopReason || '').trim().toLowerCase() === 'tool_use';
}

/**
 * Stop reasons we ignore for **watch completion** via transcript (Stop hook remains primary).
 * `tool_use` is mid-turn; `end_turn` can appear before the user-visible reply is done.
 * @param {string} stopReason
 * @returns {boolean}
 */
function isClaudeAssistantWatchSkippedStopReason(stopReason) {
  const s = String(stopReason || '').trim().toLowerCase();
  return s === 'tool_use' || s === 'end_turn';
}

/**
 * Like {@link claudeTranscriptTaskCompletedSince}, but skips assistant `end_turn` so JSONL
 * alone does not clear a watch before the Stop hook; still treats user interrupt as done.
 * @param {string} raw
 * @param {string} linkedAtIso
 * @returns {boolean}
 */
/**
 * True when the session JSONL shows a user interrupt after `sinceIso` (e.g. permission gate pause).
 * Used for paused permission watches — must not reuse task `linked_at`, which can predate the gate.
 * @param {string} raw
 * @param {string} sinceIso
 * @returns {boolean}
 */
function claudeTranscriptCancelSince(raw, sinceIso) {
  const sinceMs = Date.parse(sinceIso || '') || 0;
  if (!sinceMs) return false;
  for (const line of String(raw || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (obj.type !== 'user' || !isClaudeUserRequestInterrupted(obj)) continue;
    const ts = claudeEventTimeMs(obj);
    if (!ts || ts <= sinceMs) continue;
    return true;
  }
  return false;
}

function claudeTranscriptWatchCompletionSince(raw, linkedAtIso) {
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
    if (obj.type === 'user' && isClaudeUserRequestInterrupted(obj)) {
      const ts = claudeEventTimeMs(obj);
      if (linkedAtMs && ts < linkedAtMs) continue;
      // A `[Request interrupted by user]` row = the user cancelled the turn.
      return 'cancelled';
    }
    if (obj.type !== 'assistant') continue;
    const maybeStop = obj.message && typeof obj.message === 'object' ? obj.message : null;
    if (!maybeStop) continue;
    const stopReason =
      typeof maybeStop.stop_reason === 'string' ? maybeStop.stop_reason.trim().toLowerCase() : '';
    if (!stopReason) continue;
    if (isClaudeAssistantWatchSkippedStopReason(stopReason)) continue;
    const ts = Date.parse(obj.timestamp || '') || 0;
    if (linkedAtMs && ts < linkedAtMs) continue;
    // error / cancelled stop reasons are transient mid-turn states — do not clear.
    if (stopReason === 'error' || stopReason === 'cancelled') return '';
    return 'done';
  }
  return '';
}

// Active-generation classification of a local Claude transcript — used to detect that
// a paused (needs-input) watch has resumed (AskUserQuestion answered / new prompt).
async function claudeWatchActiveGenerationSince(transcriptPath) {
  const resolved = assertAllowedClaudeTranscriptPath(transcriptPath);
  let raw = '';
  try {
    raw = await readTailText(resolved);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  return classifyClaudeActiveGenerationFromText(raw, {});
}

function classifyClaudeActiveGenerationFromText(raw, options = {}) {
  let generating = false;
  let startMs = 0;
  let lastMs = Number.isFinite(options.mtimeMs) ? options.mtimeMs : 0;
  let inactiveReason = 'no_start_signal';

  for (const line of String(raw || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    const ts = claudeEventTimeMs(obj);
    if (ts) lastMs = ts;
    if (obj.type === 'user' && isClaudeUserRequestInterrupted(obj)) {
      generating = false;
      inactiveReason = 'completion_signal';
      continue;
    }
    if (obj.type === 'user' && isClaudeAskUserQuestionAnswer(obj)) {
      generating = true;
      startMs = ts || lastMs || startMs;
      lastMs = ts || lastMs;
      inactiveReason = '';
      continue;
    }
    if (obj.type === 'user' && claudeUserRecordHasToolResult(obj)) {
      generating = true;
      startMs = ts || lastMs || startMs;
      lastMs = ts || lastMs;
      inactiveReason = '';
      continue;
    }
    const rawUserText = extractClaudeUserMessageRawText(obj);
    if (truncateCleanHumanPromptPreview(rawUserText, 10)) {
      generating = true;
      startMs = ts || lastMs || startMs;
      lastMs = ts || lastMs;
      inactiveReason = '';
      continue;
    }
    const stop = assistantStopReason(obj);
    if (stop && !isClaudeAssistantMidTurnStopReason(stop)) {
      generating = false;
      inactiveReason = 'completion_signal';
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

async function discoverClaudeRuns(homeDir = os.homedir(), options = {}) {
  const projectsRoot = getClaudeProjectsRoot(homeDir);
  const maxRuns =
    Number.isInteger(options.maxRuns) && options.maxRuns > 0 ? options.maxRuns : DEFAULT_MAX_RUNS;
  // Optional mtime prefilter (options.recentOnlyMs): stat is cheap, tailing 512KB per transcript
  // is not, and ~/.claude/projects can hold 1000+ transcripts. With a recency window set, only
  // transcripts touched within it are tailed/classified — a generating run necessarily has a
  // recent mtime, and applyActiveGenerationStaleCutoff would flip anything older to stale anyway
  // — and of those only the newest maxRuns are read (the local analogue of the remote
  // find|sort|head bound below). Without the option, behavior is unchanged: tail everything,
  // sort, slice.
  const recentOnlyMs =
    Number.isFinite(options.recentOnlyMs) && options.recentOnlyMs > 0 ? options.recentOnlyMs : 0;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  let candidates = [];
  for (const transcriptPath of walkProjectJsonl(projectsRoot)) {
    let st;
    try {
      st = fs.statSync(transcriptPath);
    } catch {
      continue;
    }
    if (recentOnlyMs && (st.mtimeMs || 0) < nowMs - recentOnlyMs) continue;
    candidates.push({ transcriptPath, st });
  }
  if (recentOnlyMs) {
    candidates.sort((a, b) => (b.st.mtimeMs || 0) - (a.st.mtimeMs || 0));
    candidates = candidates.slice(0, maxRuns);
  }
  const runs = [];
  for (const { transcriptPath, st } of candidates) {
    const fallbackSessionId = path.basename(transcriptPath, '.jsonl');
    let tailText = '';
    try {
      tailText = await readTailText(transcriptPath);
    } catch {
      tailText = '';
    }
    const meta = extractClaudeSessionMetadata(tailText, fallbackSessionId);
    runs.push({
      kind: 'ide_agent',
      provider: 'claude',
      source: 'local',
      session_id: meta.session_id || fallbackSessionId,
      transcript_path: transcriptPath,
      title: meta.title || '',
      workspace_path: meta.workspace_path || '',
      updated_at: meta.updated_at || '',
      surface: meta.surface || '',
      mtime_ms: st.mtimeMs || 0,
      last_user_preview: latestClaudeUserPreviewFromTail(tailText, 10),
      transcript_tail: tailText,
      ...classifyClaudeActiveGenerationFromText(tailText, {
        mtimeMs: st.mtimeMs || 0,
        nowMs: options.nowMs,
        activeStaleMs: options.activeStaleMs,
      }),
    });
  }
  runs.sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0));
  return runs.slice(0, maxRuns);
}

function assertAllowedRemoteClaudeTranscriptPath(transcriptPath, claudeRoot = REMOTE_CLAUDE_ROOT) {
  const resolved = normalizePosixAbsolute(transcriptPath);
  const rawRoot = String(claudeRoot || REMOTE_CLAUDE_ROOT);
  if (rawRoot.includes('$HOME')) {
    const marker = '/.claude/projects/';
    const exact = '/.claude/projects';
    if (!resolved.includes(marker) && !resolved.endsWith(exact)) {
      throw new Error('Remote Claude transcript path must stay under ~/.claude/projects');
    }
  } else {
    const root = normalizePosixAbsolute(rawRoot);
    const allowedPrefix = posixPrefix(root);
    if (resolved !== root && !resolved.startsWith(allowedPrefix)) {
      throw new Error('Remote Claude transcript path must stay under ~/.claude/projects');
    }
  }
  if (!resolved.endsWith('.jsonl')) {
    throw new Error('Remote Claude transcript path must be a .jsonl file');
  }
  return resolved;
}

function parseRemoteClaudeFindOutput(output) {
  const runs = [];
  const lines = String(output || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const [mtimeRaw, transcriptPathRaw] = line.split('\t');
    if (!mtimeRaw || !transcriptPathRaw) continue;
    const transcriptPath = transcriptPathRaw.trim();
    if (!transcriptPath.endsWith('.jsonl')) continue;
    const sessionId = path.posix.basename(transcriptPath, '.jsonl');
    runs.push({
      kind: 'ide_agent',
      provider: 'claude',
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
  runs.sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0));
  return runs;
}

async function discoverRemoteClaudeRuns(remote, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  const maxRuns =
    Number.isInteger(options.maxRuns) && options.maxRuns > 0 ? options.maxRuns : DEFAULT_MAX_RUNS;
  const cmd =
    `find ${REMOTE_CLAUDE_ROOT} -mindepth 2 -maxdepth 2 -type f -name '*.jsonl' ` +
    `-printf '%T@\\t%p\\n' 2>/dev/null | sort -nr | head -n ${String(maxRuns)}`;
  const stdout = await runSsh(cfg.host, cmd, options.timeoutMs);
  const runs = parseRemoteClaudeFindOutput(stdout).slice(0, maxRuns);
  await Promise.all(
    runs.map(async (run) => {
      const q = shellQuote(run.transcript_path);
      const tailCmd = `if [ -f ${q} ]; then tail -c ${DEFAULT_TAIL_BYTES} ${q} 2>/dev/null || true; fi`;
      try {
        const tail = await runSsh(cfg.host, tailCmd, options.timeoutMs);
        const meta = extractClaudeSessionMetadata(tail, run.session_id);
        run.session_id = meta.session_id || run.session_id;
        run.title = meta.title || '';
        run.workspace_path = meta.workspace_path || '';
        run.updated_at = meta.updated_at || '';
        run.surface = meta.surface || '';
        // Real human-prompt preview or empty — never title/session_id. The client label chain
        // (last_user_preview || title || session_id) handles the fallback; seeding the id here
        // would mask the chat title. See snapshotToClaudePickerRun for the same rule.
        run.last_user_preview = latestClaudeUserPreviewFromTail(tail, 10);
        run.transcript_tail = tail;
        Object.assign(
          run,
          classifyClaudeActiveGenerationFromText(tail, {
            mtimeMs: run.mtime_ms,
            nowMs: options.nowMs,
            activeStaleMs: options.activeStaleMs,
          })
        );
      } catch {
        run.last_user_preview = '';
        run.transcript_tail = '';
        Object.assign(
          run,
          classifyClaudeActiveGenerationFromText('', {
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

async function remoteClaudeTaskCompletedSince(remote, transcriptPath, linkedAtIso, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  const quotedPath = shellQuote(transcriptPath);
  const cmd = `if [ -f ${quotedPath} ]; then cat ${quotedPath} 2>/dev/null || true; fi`;
  const raw = await runSsh(cfg.host, cmd, options.timeoutMs);
  return claudeTranscriptTaskCompletedSince(raw, linkedAtIso);
}

/** Any complete (parseable) JSONL record in `text`? Distinguishes "no decider among real records"
 *  from "the window decoded nothing at all" (e.g. it landed inside one line larger than itself). */
function textHasParseableJsonlRecord(text) {
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      JSON.parse(t);
      return true;
    } catch {
      /* partial / non-JSON line — keep looking */
    }
  }
  return false;
}

// Watch done-read over ssh, BOUNDED (perf fix): this runs every 2s per watched task, and the old
// full-file `cat` grew without bound with the transcript. One ssh exec emits the byte size then a
// `tail -c <window+1>`; the extra byte tells us whether the window starts exactly on a line
// boundary (first byte '\n' → everything after it is whole lines) or mid-line (drop through the
// first '\n' — that partial line is provably incomplete, so no whole record is ever discarded).
// The full `cat` is kept, but CONDITIONAL — it runs only when the bounded read cannot decide
// alone, preserving the classifier's semantics byte-for-byte:
//   (a) the tail found a terminal result on a mid-file window: claudeTranscriptWatchCompletionSince
//       is FIRST-match-wins over the whole transcript (an early post-link `error` stop suppresses a
//       later done), so confirm with one full read before clearing — this only fires on the poll
//       that would actually clear the watch;
//   (b) the mid-file window decoded NO complete record at all — a single record larger than the
//       window (e.g. a terminal assistant record carrying a huge content block) straddles it, and a
//       bounded read can never decide; cat until the next small record shrinks the last line back
//       inside the window.
// Steady-state polls of a long-running turn (complete records in the window, no decider) stay
// bounded. Known accepted skew (not observable at the 2s cadence): a decider older than the window
// with only NEWER non-decider records after it keeps returning '' until the transcript's next
// decisive record — it cannot false-clear, only clear later, and it requires >512KB appended
// between the decider and the first poll that could have seen it.
async function remoteClaudeWatchCompletionSince(remote, transcriptPath, linkedAtIso, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  const quotedPath = shellQuote(transcriptPath);
  const tailBytes =
    Number.isInteger(options.tailBytes) && options.tailBytes > 0 ? options.tailBytes : DEFAULT_TAIL_BYTES;
  const probeBytes = tailBytes + 1;
  const cmd =
    `if [ -f ${quotedPath} ]; then wc -c < ${quotedPath} 2>/dev/null | tr -d ' \\t'; ` +
    `tail -c ${String(probeBytes)} ${quotedPath} 2>/dev/null || true; fi`;
  const out = String((await runSsh(cfg.host, cmd, options.timeoutMs)) || '');
  if (!out) return ''; // file missing/unreadable — same '' the old cat path produced
  const sizeEnd = out.indexOf('\n');
  const sizeBytes = Number.parseInt(sizeEnd === -1 ? out : out.slice(0, sizeEnd), 10);
  const tail = sizeEnd === -1 ? '' : out.slice(sizeEnd + 1);
  if (!Number.isFinite(sizeBytes)) return ''; // unexpected shell output — treat as unreadable
  const wholeFile = sizeBytes <= probeBytes;
  let windowText;
  if (wholeFile) {
    windowText = tail;
  } else if (tail.startsWith('\n')) {
    windowText = tail.slice(1); // probe byte was a newline — window starts on a line boundary
  } else {
    const cut = tail.indexOf('\n');
    windowText = cut === -1 ? '' : tail.slice(cut + 1); // drop the provably-partial first line
  }
  const result = claudeTranscriptWatchCompletionSince(windowText, linkedAtIso);
  if (wholeFile) return result;
  if (!result && textHasParseableJsonlRecord(windowText)) return result; // bounded read decided: ongoing turn
  const catCmd = `if [ -f ${quotedPath} ]; then cat ${quotedPath} 2>/dev/null || true; fi`;
  const raw = await runSsh(cfg.host, catCmd, options.timeoutMs);
  return claudeTranscriptWatchCompletionSince(raw, linkedAtIso);
}

async function remoteClaudeTranscriptCancelSince(remote, transcriptPath, sinceIso, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  const q = shellQuote(transcriptPath);
  const cmd = `if [ -f ${q} ]; then tail -c ${DEFAULT_TAIL_BYTES} ${q} 2>/dev/null || true; fi`;
  const raw = await runSsh(cfg.host, cmd, options.timeoutMs);
  return claudeTranscriptCancelSince(raw, sinceIso);
}

async function claudePausedWatchShouldCancel(ideTracking, pausedAtIso, options = {}) {
  if (!ideTracking?.transcript_path || !pausedAtIso) return false;
  if (ideTracking.source === 'ssh') {
    const projectsRoot =
      typeof ideTracking.projects_root === 'string' ? ideTracking.projects_root.trim() : '';
    if (!ideTracking.host || !projectsRoot) return false;
    return remoteClaudeTranscriptCancelSince(
      { host: ideTracking.host, projects_root: projectsRoot },
      ideTracking.transcript_path,
      pausedAtIso,
      options
    );
  }
  try {
    const resolved = assertAllowedClaudeTranscriptPath(ideTracking.transcript_path, options.homeDir);
    const raw = await fsp.readFile(resolved, 'utf8');
    return claudeTranscriptCancelSince(raw, pausedAtIso);
  } catch {
    return false;
  }
}

// Active-generation classification of a remote (ssh) Claude transcript — used to detect
// that a paused (needs-input) watch has resumed (AskUserQuestion answered / new prompt).
async function remoteClaudeWatchActiveGenerationSince(remote, transcriptPath, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  const q = shellQuote(transcriptPath);
  const cmd = `if [ -f ${q} ]; then tail -c ${DEFAULT_TAIL_BYTES} ${q} 2>/dev/null || true; fi`;
  const raw = await runSsh(cfg.host, cmd, options.timeoutMs);
  if (!String(raw || '').trim()) return null;
  return classifyClaudeActiveGenerationFromText(raw, {});
}

function normalizeClaudePickerSessionId(id) {
  if (typeof id !== 'string') return '';
  return id.trim();
}

function normalizeClaudePickerTranscriptPath(p) {
  if (typeof p !== 'string') return '';
  return p.trim();
}

function findClaudeHookSnapshotForRun(run, snapshots) {
  if (!run || !Array.isArray(snapshots) || !snapshots.length) return null;
  const wantedSession = normalizeClaudePickerSessionId(run.session_id);
  const wantedTranscript = normalizeClaudePickerTranscriptPath(run.transcript_path);
  for (const snap of snapshots) {
    if (!snap) continue;
    if (wantedSession && snap.session_id && wantedSession === normalizeClaudePickerSessionId(snap.session_id)) {
      return snap;
    }
    if (
      wantedTranscript &&
      snap.transcript_path &&
      wantedTranscript === normalizeClaudePickerTranscriptPath(snap.transcript_path)
    ) {
      return snap;
    }
  }
  return null;
}

function isClaudePermissionAttentionReason(reason) {
  const r = String(reason || '').trim();
  return r === 'permission_request' || r === 'permission_prompt';
}

function claudeUserRecordHasToolResult(obj) {
  if (!obj || obj.type !== 'user') return false;
  if (obj.tool_use_result != null) return true;
  if (obj.parent_tool_use_id) return true;
  const content = obj?.message?.content;
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    if (block && block.type === 'tool_result') return true;
  }
  return false;
}

const CLAUDE_TRANSCRIPT_NOISE_TYPES = new Set(['queue-operation', 'file-history-snapshot', 'ai-title', 'custom-title']);

/**
 * True when the session JSONL shows the user answered a permission prompt after `sinceIso`.
 * Only a user tool_result counts when the tail was read — assistant lines (including tool_use)
 * can be appended after the PermissionRequest hook while the prompt is still open.
 * When the tail is empty, fall back to transcript mtime growth after the hook.
 */
function claudeTranscriptPermissionResolvedSince(raw, sinceIso, options = {}) {
  const sinceMs = Date.parse(sinceIso || '') || 0;
  if (!sinceMs) return false;
  const mtimeSlackMs =
    Number.isFinite(options.mtimeSlackMs) && options.mtimeSlackMs >= 0 ? options.mtimeSlackMs : 750;
  const mtimeMs = Number.isFinite(options.mtimeMs) ? options.mtimeMs : 0;

  let scannedTranscriptLine = false;
  for (const line of String(raw || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (CLAUDE_TRANSCRIPT_NOISE_TYPES.has(obj.type)) continue;
    scannedTranscriptLine = true;
    const ts = claudeEventTimeMs(obj);
    if (!ts || ts <= sinceMs) continue;
    if (obj.type === 'user' && claudeUserRecordHasToolResult(obj)) return true;
  }
  if (!scannedTranscriptLine && mtimeMs > sinceMs + mtimeSlackMs) return true;
  return false;
}

/** Whether a hook completion_hint should still block picker / auto-clear (permission not answered yet). */
function claudePermissionCompletionHintStillBlocks(hint, options = {}) {
  if (!hint || !hint.completion_hint) return false;
  if (!isClaudePermissionAttentionReason(hint.attention_reason)) return true;
  const tailText = typeof options.tailText === 'string' ? options.tailText : '';
  return !claudeTranscriptPermissionResolvedSince(tailText, hint.updated_at || '', {
    mtimeMs: options.mtimeMs,
    mtimeSlackMs: options.mtimeSlackMs,
  });
}

async function claudePermissionCompletionHintIsStale(ideTracking, hint, options = {}) {
  if (!hint || !hint.completion_hint || !isClaudePermissionAttentionReason(hint.attention_reason)) {
    return false;
  }
  const transcriptPath =
    typeof ideTracking?.transcript_path === 'string' ? ideTracking.transcript_path.trim() : '';
  if (!transcriptPath) return false;
  let tailText = '';
  let mtimeMs = 0;
  try {
    if (ideTracking.source === 'ssh' && options.remote) {
      const cfg = assertValidRemoteSource(options.remote);
      const runSsh = options.runSsh || createSshRunner();
      const q = shellQuote(transcriptPath);
      const tailCmd = `if [ -f ${q} ]; then tail -c ${DEFAULT_TAIL_BYTES} ${q} 2>/dev/null || true; fi`;
      tailText = await runSsh(cfg.host, tailCmd, options.timeoutMs);
    } else {
      const resolved = assertAllowedClaudeTranscriptPath(transcriptPath, options.homeDir);
      const st = fs.statSync(resolved);
      mtimeMs = st.mtimeMs || 0;
      tailText = await readTailText(resolved);
    }
  } catch {
    return false;
  }
  return claudeTranscriptPermissionResolvedSince(tailText, hint.updated_at || '', { mtimeMs });
}

/**
 * Merge Claude Code hook snapshots into transcript-discovered picker rows.
 * Stop hooks hide finished sessions; permission hooks clear the watcher but keep the picker row
 * available so the task can be re-linked after approve (no reliable post-approve signal required).
 */
function enrichClaudePickerRunWithHook(run, snap) {
  if (!run || typeof run !== 'object') return run;
  if (!snap) return run;
  const tailText = typeof run.transcript_tail === 'string' ? run.transcript_tail : '';
  const hint = {
    completion_hint: !!snap.completion_hint,
    attention_reason: snap.attention_reason || '',
    updated_at: snap.updated_at || '',
  };

  if (hint.completion_hint && isClaudePermissionAttentionReason(hint.attention_reason)) {
    const pickerGenerating = !!run.generating || !!snap.generating;
    return {
      ...run,
      generating: pickerGenerating,
      start_signal_at: run.start_signal_at,
      last_activity_at: run.last_activity_at || snap.updated_at,
      inactive_reason: pickerGenerating ? '' : run.inactive_reason || hint.attention_reason,
      completion_hint: false,
      attention_reason: hint.attention_reason,
    };
  }

  const transcriptInterrupted = claudeTranscriptTailEndsWithUserInterrupt(tailText);
  const hasTranscriptSignal = String(tailText || '').trim().length > 0;
  const completionHintSuperseded = claudeTranscriptHasUserStartAfter(tailText, hint.updated_at);
  const effectiveCompletionHint = hint.completion_hint && !completionHintSuperseded;
  const hookGenerating =
    !!snap.generating &&
    !effectiveCompletionHint &&
    !transcriptInterrupted &&
    (!hasTranscriptSignal || !!run.generating);
  const blocks = effectiveCompletionHint && claudePermissionCompletionHintStillBlocks(
    {
      ...hint,
      completion_hint: effectiveCompletionHint,
    },
    {
      tailText,
      mtimeMs: run.mtime_ms,
    }
  );
  const transcriptGenerating = transcriptInterrupted ? false : !!run.generating;
  const pickerGenerating = blocks ? false : hookGenerating || transcriptGenerating;
  const updatedMs = Date.parse(snap.updated_at || '') || run.mtime_ms || 0;
  const runLastMs = Date.parse(run.last_activity_at || '') || 0;
  const lastActivityMs = Math.max(updatedMs, runLastMs);
  if (pickerGenerating && completionHintSuperseded && transcriptGenerating) {
    return {
      ...run,
      generating: true,
      start_signal_at: run.start_signal_at,
      last_activity_at: toIso(lastActivityMs) || run.last_activity_at,
      inactive_reason: '',
      completion_hint: false,
      attention_reason: hint.attention_reason,
    };
  }
  const activeGen = applyActiveGenerationStaleCutoff(
    {
      generating: pickerGenerating,
      start_signal_at: run.start_signal_at,
      last_activity_at: toIso(lastActivityMs) || run.last_activity_at,
      inactive_reason: pickerGenerating ? '' : hint.attention_reason || 'completion_signal',
    },
    { mtimeMs: run.mtime_ms || updatedMs }
  );
  return {
    ...run,
    ...activeGen,
    completion_hint: blocks,
    attention_reason: hint.attention_reason,
  };
}

function enrichClaudePickerRunsWithHooks(runs, snapshots) {
  if (!Array.isArray(runs) || !runs.length) return runs || [];
  const snaps = Array.isArray(snapshots) ? snapshots : [];
  return runs.map((run) => {
    const enriched = enrichClaudePickerRunWithHook(run, findClaudeHookSnapshotForRun(run, snaps));
    if (!enriched || typeof enriched !== 'object') return enriched;
    const { transcript_tail, ...rest } = enriched;
    if (isUserRequestInterruptedPreview(rest.last_user_preview)) {
      rest.last_user_preview = '';
    }
    return rest;
  });
}

/**
 * Reconcile hook-store picker rows with the Claude session transcript so cancelled
 * or completed turns do not stay "active" when hooks never fired Stop.
 */
async function enrichClaudePickerRunWithTranscript(run, snap, options = {}) {
  if (!run || typeof run !== 'object') return run;
  const out = { ...run };
  const transcriptPath = typeof run.transcript_path === 'string' ? run.transcript_path.trim() : '';
  if (transcriptPath) {
    try {
      let tail = '';
      let mtimeMs = Number.isFinite(run.mtime_ms) ? run.mtime_ms : 0;
      if (run.source === 'ssh' && options.remote) {
        const cfg = assertValidRemoteSource(options.remote);
        const runSsh = options.runSsh || createSshRunner();
        const q = shellQuote(transcriptPath);
        const tailCmd = `if [ -f ${q} ]; then tail -c ${DEFAULT_TAIL_BYTES} ${q} 2>/dev/null || true; fi`;
        tail = await runSsh(cfg.host, tailCmd, options.timeoutMs);
      } else {
        const resolved = assertAllowedClaudeTranscriptPath(transcriptPath, options.homeDir);
        const st = fs.statSync(resolved);
        mtimeMs = st.mtimeMs || mtimeMs;
        tail = await readTailText(resolved);
      }
      if (String(tail || '').trim()) {
        out.transcript_tail = tail;
        const preview = latestClaudeUserPreviewFromTail(tail, 10);
        if (preview) out.last_user_preview = preview;
        Object.assign(
          out,
          classifyClaudeActiveGenerationFromText(tail, {
            mtimeMs,
            nowMs: options.nowMs,
            activeStaleMs: options.activeStaleMs,
          })
        );
        if (out.generating) {
          out.completion_hint = false;
        } else if (out.inactive_reason === 'completion_signal') {
          out.completion_hint = true;
        }
      }
    } catch {
      // Keep hook-derived generation when the transcript is missing or unreadable.
    }
  }
  // Backfill the chat title (Claude's aiTitle) so linked Claude chats show a title like codex/gemini
  // do. Hook snapshots carry none, and the transcript read above targets the tail. Local: cached head
  // read, where the ai-title actually lives. Remote: best-effort from the ssh-fetched tail (long remote
  // chats can still miss the head-of-file title — remote titles are a known gap).
  if (!out.title) {
    if (run.source === 'ssh') {
      // First try the tail we already fetched (free, covers short remote chats).
      const meta = extractClaudeSessionMetadata(
        typeof out.transcript_tail === 'string' ? out.transcript_tail : '',
        out.session_id
      );
      if (meta.title) out.title = meta.title;
      // Fall back to a cached remote head read, where the ai-title lives on long remote chats.
      if (!out.title && transcriptPath && options.remote) {
        out.title = await fetchRemoteClaudeTitle(
          transcriptPath,
          options.remote,
          options.runSsh,
          options.timeoutMs
        );
      }
    } else if (transcriptPath) {
      out.title = claudeTitleForTranscript(transcriptPath, options.homeDir) || '';
    }
  }
  // Backfill the surface (cli / desktop / plugin) from the transcript's `entrypoint`. Claude stamps
  // it on nearly every record, so the tail read above reliably carries it for local and remote alike.
  if (!out.surface) {
    const surf = claudeSurfaceFromTailText(typeof out.transcript_tail === 'string' ? out.transcript_tail : '');
    if (surf) out.surface = surf;
  }
  const enriched = enrichClaudePickerRunWithHook(out, snap);
  if (!enriched || typeof enriched !== 'object') return enriched;
  const { transcript_tail, ...rest } = enriched;
  if (isUserRequestInterruptedPreview(rest.last_user_preview)) {
    rest.last_user_preview = '';
  }
  return rest;
}

async function enrichClaudeHookPickerRuns(runs, snapshots, options = {}) {
  if (!Array.isArray(runs) || !runs.length) return runs || [];
  const snaps = Array.isArray(snapshots) ? snapshots : [];
  return Promise.all(
    runs.map((run) => {
      const snap = findClaudeHookSnapshotForRun(run, snaps);
      const runOpts =
        run && run.source === 'ssh' && run.host
          ? {
              ...options,
              remote: { host: run.host, projects_root: run.projects_root },
            }
          : options;
      return enrichClaudePickerRunWithTranscript(run, snap, runOpts);
    })
  );
}

module.exports = {
  DEFAULT_MAX_RUNS,
  assertAllowedClaudeTranscriptPath,
  assertAllowedRemoteClaudeTranscriptPath,
  discoverClaudeRuns,
  discoverRemoteClaudeRuns,
  latestClaudeUserPreviewFromTail,
  remoteClaudeTaskCompletedSince,
  remoteClaudeWatchCompletionSince,
  remoteClaudeWatchActiveGenerationSince,
  claudeTranscriptTaskCompletedSince,
  claudeTranscriptCancelSince,
  claudeTranscriptWatchCompletionSince,
  claudePausedWatchShouldCancel,
  remoteClaudeTranscriptCancelSince,
  claudeWatchActiveGenerationSince,
  classifyClaudeActiveGenerationFromText,
  claudeTranscriptTailEndsWithUserInterrupt,
  isClaudeUserRequestInterrupted,
  isClaudeAssistantMidTurnStopReason,
  isClaudeAssistantWatchSkippedStopReason,
  findClaudeHookSnapshotForRun,
  isClaudePermissionAttentionReason,
  claudeTranscriptPermissionResolvedSince,
  claudePermissionCompletionHintStillBlocks,
  claudePermissionCompletionHintIsStale,
  enrichClaudePickerRunWithHook,
  enrichClaudePickerRunsWithHooks,
  enrichClaudePickerRunWithTranscript,
  enrichClaudeHookPickerRuns,
};
