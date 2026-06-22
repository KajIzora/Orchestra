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
    if (isClaudeUserRequestInterrupted(obj)) continue;
    const raw = extractClaudeUserMessageRawText(obj);
    const preview = truncateCleanHumanPromptPreview(raw, maxWords);
    if (preview) return preview;
  }
  return '';
}

function extractClaudeSessionMetadata(tailText, fallbackSessionId) {
  const out = {
    session_id: fallbackSessionId,
    title: '',
    workspace_path: '',
    updated_at: '',
  };
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
    if (!out.title && obj.type === 'ai-title' && typeof obj.aiTitle === 'string') out.title = obj.aiTitle.trim();
  }
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
  const files = walkProjectJsonl(projectsRoot);
  const runs = [];
  for (const transcriptPath of files) {
    let st;
    try {
      st = fs.statSync(transcriptPath);
    } catch {
      continue;
    }
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
        run.last_user_preview = latestClaudeUserPreviewFromTail(tail, 10) || run.title || run.session_id;
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
        run.last_user_preview = run.title || run.session_id;
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

async function remoteClaudeWatchCompletionSince(remote, transcriptPath, linkedAtIso, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  const quotedPath = shellQuote(transcriptPath);
  const cmd = `if [ -f ${quotedPath} ]; then cat ${quotedPath} 2>/dev/null || true; fi`;
  const raw = await runSsh(cfg.host, cmd, options.timeoutMs);
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

const CLAUDE_TRANSCRIPT_NOISE_TYPES = new Set(['queue-operation', 'file-history-snapshot', 'ai-title']);

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
