const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const {
  discoverRemoteCursorRuns,
  assertValidRemoteSource,
  assertAllowedRemoteTranscriptPath,
} = require('./remote_cursor_tracker');
const { latestUserWordsPreviewFromTailText } = require('./transcript_preview');

function normalizeConversationId(id) {
  if (typeof id !== 'string') return '';
  return id.trim().toLowerCase();
}

const DEFAULT_POLL_MS = 2_000;
const TAIL_READ_BYTES = 512 * 1024;
const PREVIEW_TAIL_BYTES = 512 * 1024;
const PREVIEW_MAX_WORDS = 10;
const DEFAULT_MAX_RUNS = 10;

function workspacePathToProjectSlug(workspacePath, source = 'local') {
  if (typeof workspacePath !== 'string') return '';
  const trimmed = workspacePath.trim();
  if (!trimmed) return '';
  const normalized =
    source === 'ssh' ? path.posix.normalize(trimmed) : path.resolve(trimmed);
  return normalized
    .replace(/^\/+/, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildWorkspaceSlugSet(workspacePaths = [], source = 'local') {
  const set = new Set();
  for (const workspacePath of workspacePaths) {
    const slug = workspacePathToProjectSlug(workspacePath, source);
    if (slug) set.add(slug);
  }
  return set;
}

/**
 * Walk ~/.cursor/projects (each slug) / agent-transcripts / runId / runId.jsonl
 * @returns {Promise<Array<{ run_id: string, transcript_path: string, project_slug: string, mtime_ms: number, user_preview: string }>>}
 */
async function discoverCursorRuns(homeDir = os.homedir(), options = {}) {
  const runs = [];
  const projectsRoot = path.join(homeDir, '.cursor', 'projects');
  const workspaceSlugs =
    options.workspaceSlugs instanceof Set ? options.workspaceSlugs : new Set(options.workspaceSlugs || []);
  const useWorkspaceFilter = workspaceSlugs.size > 0;
  const maxRuns =
    Number.isInteger(options.maxRuns) && options.maxRuns > 0
      ? options.maxRuns
      : Number.POSITIVE_INFINITY;
  if (!fs.existsSync(projectsRoot)) return runs;

  let projectEntries;
  try {
    projectEntries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return runs;
  }

  for (const proj of projectEntries) {
    if (!proj.isDirectory()) continue;
    if (useWorkspaceFilter && !workspaceSlugs.has(proj.name)) continue;
    const transcriptsDir = path.join(projectsRoot, proj.name, 'agent-transcripts');
    if (!fs.existsSync(transcriptsDir)) continue;

    let runDirs;
    try {
      runDirs = fs.readdirSync(transcriptsDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const runDir of runDirs) {
      if (!runDir.isDirectory()) continue;
      const runId = runDir.name;
      const jsonlPath = path.join(transcriptsDir, runId, `${runId}.jsonl`);
      if (!fs.existsSync(jsonlPath)) continue;
      let st;
      try {
        st = fs.statSync(jsonlPath);
      } catch {
        continue;
      }
      runs.push({
        run_id: runId,
        transcript_path: jsonlPath,
        project_slug: proj.name,
        mtime_ms: st.mtimeMs,
        user_preview: '',
      });
    }
  }

  runs.sort((a, b) => b.mtime_ms - a.mtime_ms);
  const topRuns = Number.isFinite(maxRuns) ? runs.slice(0, maxRuns) : runs;
  await Promise.all(
    topRuns.map(async (run) => {
      try {
        const tail = await readTranscriptTailText(run.transcript_path, PREVIEW_TAIL_BYTES);
        if (!tail.missing && tail.tailText) {
          run.user_preview = latestUserWordsPreviewFromTailText(tail.tailText, PREVIEW_MAX_WORDS);
        }
      } catch {
        // Keep empty preview on read/parsing errors.
      }
    })
  );
  return topRuns;
}

function getCursorProjectsRoot(homeDir = os.homedir()) {
  return path.resolve(path.join(homeDir, '.cursor', 'projects'));
}

/**
 * Reject paths outside ~/.cursor/projects (after resolve).
 */
function assertAllowedTranscriptPath(transcriptPath, homeDir = os.homedir()) {
  const allowedRoot = getCursorProjectsRoot(homeDir);
  const resolved = path.resolve(transcriptPath);
  const prefix = allowedRoot.endsWith(path.sep) ? allowedRoot : `${allowedRoot}${path.sep}`;
  if (resolved !== allowedRoot && !resolved.startsWith(prefix)) {
    throw new Error('transcript_path must be under ~/.cursor/projects');
  }
  if (!resolved.endsWith('.jsonl')) {
    throw new Error('transcript_path must be a .jsonl file');
  }
  return resolved;
}

/**
 * Read tail of transcript as text. If read starts mid-file, drops the first
 * fragment line so remaining lines are whole JSONL records.
 */
async function readTranscriptTailText(transcriptPath, maxBytes = TAIL_READ_BYTES) {
  let st;
  try {
    st = await fsp.stat(transcriptPath);
  } catch (err) {
    if (err.code === 'ENOENT') return { missing: true, mtimeMs: null, tailText: null };
    throw err;
  }
  const size = st.size;
  const start = Math.max(0, size - maxBytes);
  const len = size - start;
  if (len === 0) return { missing: false, mtimeMs: st.mtimeMs, tailText: '' };

  const fh = await fsp.open(transcriptPath, 'r');
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    let tailText = buf.toString('utf8');
    if (start > 0 && tailText.length > 0) {
      const nl = tailText.indexOf('\n');
      if (nl !== -1) tailText = tailText.slice(nl + 1);
    }
    return { missing: false, mtimeMs: st.mtimeMs, tailText };
  } finally {
    await fh.close();
  }
}

/**
 * Read tail of file for last JSONL object (best-effort).
 */
async function readTranscriptTail(transcriptPath, maxBytes = TAIL_READ_BYTES) {
  const r = await readTranscriptTailText(transcriptPath, maxBytes);
  if (r.missing) return { missing: true, mtimeMs: null, lastLine: null };
  const lines = r.tailText.split('\n').filter((l) => l.trim().length > 0);
  const lastLine = lines.length ? lines[lines.length - 1] : null;
  return { missing: false, mtimeMs: r.mtimeMs, lastLine };
}

function findLocalTranscriptPathByRunId(runId, homeDir = os.homedir()) {
  const id = typeof runId === 'string' ? runId.trim() : '';
  if (!id) return '';
  const projectsRoot = getCursorProjectsRoot(homeDir);
  if (!fs.existsSync(projectsRoot)) return '';

  let projectEntries;
  try {
    projectEntries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return '';
  }

  let best = null;
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;
    const candidate = path.join(projectsRoot, projectEntry.name, 'agent-transcripts', id, `${id}.jsonl`);
    let st;
    try {
      st = fs.statSync(candidate);
    } catch {
      continue;
    }
    if (!best || st.mtimeMs > best.mtimeMs) {
      best = { transcriptPath: candidate, mtimeMs: st.mtimeMs };
    }
  }
  return best ? best.transcriptPath : '';
}

function defaultCursorTracking(runId, transcriptPath) {
  const iso = new Date().toISOString();
  return {
    source: 'local',
    run_id: runId,
    transcript_path: transcriptPath,
    linked_at: iso,
    last_seen_mtime_ms: null,
    idle_since_ms: null,
    last_error: null,
  };
}

function defaultRemoteCursorTracking(runId, transcriptPath, remote) {
  const cfg = assertValidRemoteSource(remote);
  const resolved = assertAllowedRemoteTranscriptPath(transcriptPath, cfg.projects_root);
  return {
    ...defaultCursorTracking(runId, resolved),
    source: 'ssh',
    host: cfg.host,
    projects_root: cfg.projects_root,
  };
}

function normalizeCursorTracking(cursorTracking) {
  if (!cursorTracking || typeof cursorTracking !== 'object') return null;
  if (cursorTracking.source === 'ssh') {
    try {
      const cfg = assertValidRemoteSource(cursorTracking);
      const resolved = assertAllowedRemoteTranscriptPath(cursorTracking.transcript_path, cfg.projects_root);
      return {
        ...cursorTracking,
        source: 'ssh',
        host: cfg.host,
        projects_root: cfg.projects_root,
        transcript_path: resolved,
      };
    } catch {
      return { ...cursorTracking, source: 'ssh' };
    }
  }
  return { ...cursorTracking, source: 'local' };
}

async function discoverCursorRunsForProject(project = {}) {
  const { groupSshWorkspacePathsByRemote } = require('./cursor_remotes');
  const workspaces = Array.isArray(project.cursor_workspaces) ? project.cursor_workspaces : [];
  const localWorkspacePaths = workspaces
    .filter((w) => w && w.source !== 'ssh' && typeof w.workspace_path === 'string')
    .map((w) => w.workspace_path);
  const localRuns = await discoverCursorRuns(os.homedir(), {
    workspaceSlugs: localWorkspacePaths.length ? buildWorkspaceSlugSet(localWorkspacePaths, 'local') : undefined,
    maxRuns: DEFAULT_MAX_RUNS,
  });
  const remotes =
    Array.isArray(project.cursor_remotes) && project.cursor_remotes.length
      ? project.cursor_remotes.map((r) => assertValidRemoteSource(r))
      : project.cursor_remote && project.cursor_remote.host
        ? [assertValidRemoteSource(project.cursor_remote)]
        : [];
  if (!remotes.length) return localRuns;
  const bucketMap = groupSshWorkspacePathsByRemote(project);
  const remoteRuns = [];
  if (bucketMap.size) {
    for (const { remote, paths } of bucketMap.values()) {
      const uniquePaths = [...new Set(paths)];
      remoteRuns.push(
        ...(await discoverRemoteCursorRuns(remote, {
          workspacePaths: uniquePaths.length ? uniquePaths : undefined,
          maxRuns: DEFAULT_MAX_RUNS,
        }))
      );
    }
  } else {
    for (const remote of remotes) {
      remoteRuns.push(
        ...(await discoverRemoteCursorRuns(remote, {
          workspacePaths: undefined,
          maxRuns: DEFAULT_MAX_RUNS,
        }))
      );
    }
  }
  return [...remoteRuns, ...localRuns].sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0));
}

const CURSOR_ASK_QUESTION_TOOL = 'AskQuestion';

function isCursorAskQuestionToolName(name) {
  return typeof name === 'string' && name.trim() === CURSOR_ASK_QUESTION_TOOL;
}

function cursorRecordContentBlocks(record) {
  if (!record || typeof record !== 'object') return [];
  const msg = record.message;
  if (!msg || typeof msg !== 'object') return [];
  const content = msg.content;
  return Array.isArray(content) ? content : [];
}

function cursorRecordAfterLinkedAt(record, linkedAtMs) {
  if (!linkedAtMs) return true;
  const ts = Date.parse(record?.timestamp || '') || 0;
  if (!ts) return true;
  return ts >= linkedAtMs;
}

function cursorToolResultIdsFromRecord(record) {
  if (!record || record.role !== 'user') return [];
  const ids = [];
  for (const block of cursorRecordContentBlocks(record)) {
    if (!block || block.type !== 'tool_result') continue;
    const id =
      (typeof block.tool_use_id === 'string' && block.tool_use_id.trim()) ||
      (typeof block.toolUseId === 'string' && block.toolUseId.trim()) ||
      '';
    if (id) ids.push(id);
  }
  return ids;
}

function cursorAskQuestionToolIdsFromRecord(record) {
  if (!record || record.role !== 'assistant') return [];
  const ids = [];
  for (const block of cursorRecordContentBlocks(record)) {
    if (!block || block.type !== 'tool_use' || !isCursorAskQuestionToolName(block.name)) continue;
    const id =
      (typeof block.id === 'string' && block.id.trim()) ||
      (typeof block.tool_use_id === 'string' && block.tool_use_id.trim()) ||
      '';
    if (id) ids.push(id);
  }
  return ids;
}

const CURSOR_MANUAL_ABORT_ERROR = 'user aborted/interrupted manually';
const CURSOR_IDE_ABORT_ERROR = 'user aborted request';

function parseCursorTranscriptLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Whether a `turn_ended` record is a user-cancel marker from cursor-cli or Cursor IDE.
 * CLI: status=aborted + "User aborted/interrupted manually."
 * IDE: status=error + "User aborted request"
 * @param {object|null} record
 * @returns {boolean}
 */
function isCursorTranscriptManualAbortRecord(record) {
  if (!record || record.type !== 'turn_ended') return false;
  const status = String(record.status || '').toLowerCase();
  const err = String(record.error || '').trim().toLowerCase();
  if (status === 'aborted' && err.includes(CURSOR_MANUAL_ABORT_ERROR)) return true;
  if (status === 'error' && err.includes(CURSOR_IDE_ABORT_ERROR)) return true;
  return false;
}

/**
 * Whether a single transcript JSONL line is a cursor-cli or IDE manual abort marker.
 * @param {string} line
 * @returns {boolean}
 */
function isCursorTranscriptManualAbortLine(line) {
  return isCursorTranscriptManualAbortRecord(parseCursorTranscriptLine(line));
}

/**
 * Whether a Cursor agent transcript indicates the user cancelled the turn after
 * `linked_at` via a manual-abort `turn_ended` marker (CLI or IDE).
 * @param {string} raw full transcript JSONL text
 * @param {string} linkedAtIso watch linked_at ISO time
 * @returns {boolean}
 */
function cursorTranscriptCancelSince(raw, linkedAtIso) {
  const linkedAtMs = Date.parse(linkedAtIso || '') || 0;
  /** @type {object|null} */
  let lastTurnEnded = null;

  for (const line of String(raw || '').split('\n')) {
    const record = parseCursorTranscriptLine(line);
    if (!record || record.type !== 'turn_ended') continue;
    lastTurnEnded = record;
  }

  if (!lastTurnEnded || !isCursorTranscriptManualAbortRecord(lastTurnEnded)) return false;

  const ts = Date.parse(lastTurnEnded.timestamp || '') || 0;
  if (ts && linkedAtMs && ts < linkedAtMs) return false;
  return true;
}

/**
 * Whether a Cursor agent transcript indicates the watch should clear because the
 * agent is blocked on a pending `AskQuestion` tool call after `linked_at`.
 * Clears when a later assistant turn or matching tool_result shows the question was answered.
 * @param {string} raw full transcript JSONL text
 * @param {string} linkedAtIso watch linked_at ISO time
 * @returns {boolean}
 */
function cursorTranscriptShouldClearWatch(raw, linkedAtIso) {
  const linkedAtMs = Date.parse(linkedAtIso || '') || 0;
  let pendingAskLineIndex = -1;
  const pendingToolIds = new Set();
  let lineIndex = 0;

  const clearPendingAsk = () => {
    pendingAskLineIndex = -1;
    pendingToolIds.clear();
  };

  for (const line of String(raw || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      lineIndex += 1;
      continue;
    }

    if (pendingToolIds.size && record.role === 'user') {
      for (const id of cursorToolResultIdsFromRecord(record)) {
        pendingToolIds.delete(id);
      }
      if (!pendingToolIds.size && pendingAskLineIndex >= 0) {
        clearPendingAsk();
      }
    }

    if (record.role === 'assistant') {
      if (pendingAskLineIndex >= 0 && lineIndex > pendingAskLineIndex) {
        clearPendingAsk();
      }
      if (cursorRecordAfterLinkedAt(record, linkedAtMs)) {
        for (const block of cursorRecordContentBlocks(record)) {
          if (!block || block.type !== 'tool_use' || !isCursorAskQuestionToolName(block.name)) continue;
          pendingAskLineIndex = lineIndex;
          const id =
            (typeof block.id === 'string' && block.id.trim()) ||
            (typeof block.tool_use_id === 'string' && block.tool_use_id.trim()) ||
            '';
          if (id) pendingToolIds.add(id);
        }
      }
    }

    lineIndex += 1;
  }

  return pendingAskLineIndex >= 0;
}

function resolveLocalCursorTranscriptPath(cursorTracking, homeDir = os.homedir()) {
  if (!cursorTracking || typeof cursorTracking !== 'object') return '';
  if (typeof cursorTracking.transcript_path === 'string' && cursorTracking.transcript_path.trim()) {
    const trimmed = cursorTracking.transcript_path.trim();
    try {
      return assertAllowedTranscriptPath(trimmed, homeDir);
    } catch {
      const resolved = path.resolve(trimmed);
      const projectsMarker = `${path.sep}.cursor${path.sep}projects${path.sep}`;
      if (
        resolved.includes(projectsMarker) &&
        resolved.endsWith('.jsonl') &&
        fs.existsSync(resolved)
      ) {
        return resolved;
      }
      return '';
    }
  }
  return findLocalTranscriptPathByRunId(
    cursorTracking.conversation_id || cursorTracking.run_id,
    homeDir
  );
}

async function findRemoteTranscriptPathByRunId(remote, runId, options = {}) {
  const { assertValidRemoteSource, createSshRunner, shellQuote } = require('./remote_cursor_tracker');
  const cfg = assertValidRemoteSource(remote);
  const id = typeof runId === 'string' ? runId.trim() : '';
  if (!id) return '';
  const runSsh = options.runSsh || createSshRunner();
  const root = shellQuote(cfg.projects_root);
  const cmd = `find ${root} -type f -path "*/agent-transcripts/${id}/${id}.jsonl" 2>/dev/null | head -1`;
  const stdout = await runSsh(cfg.host, cmd, options.timeoutMs);
  const line = String(stdout || '')
    .split('\n')
    .map((row) => row.trim())
    .find(Boolean);
  return line || '';
}

async function resolveCursorTranscriptPath(cursorTracking, options = {}) {
  if (!cursorTracking || typeof cursorTracking !== 'object') return '';
  if (cursorTracking.source === 'ssh') {
    const existing =
      typeof cursorTracking.transcript_path === 'string' ? cursorTracking.transcript_path.trim() : '';
    if (existing) return existing;
    return findRemoteTranscriptPathByRunId(
      {
        host: cursorTracking.host,
        projects_root: cursorTracking.projects_root,
      },
      cursorTracking.conversation_id || cursorTracking.run_id,
      options
    );
  }
  return resolveLocalCursorTranscriptPath(cursorTracking, options.homeDir);
}

function workspaceSlugSetFromTracking(cursorTracking) {
  const slugs = cursorTracking?.workspace_slugs;
  if (slugs instanceof Set) return slugs;
  if (Array.isArray(slugs)) return new Set(slugs.filter(Boolean));
  return new Set();
}

/**
 * Local runs in project workspace folders with pending AskQuestion after linked_at.
 * @returns {Array<{ conversation_id: string, transcript_path: string, mtime_ms: number }>}
 */
function discoverLocalPendingAskQuestionRuns(workspaceSlugs, linkedAtMs, homeDir = os.homedir()) {
  const slugs = workspaceSlugs instanceof Set ? workspaceSlugs : new Set(workspaceSlugs || []);
  if (!slugs.size) return [];
  const linkedIso = linkedAtMs ? new Date(linkedAtMs).toISOString() : '';
  const projectsRoot = getCursorProjectsRoot(homeDir);
  const out = [];
  for (const slug of slugs) {
    const transcriptsDir = path.join(projectsRoot, slug, 'agent-transcripts');
    if (!fs.existsSync(transcriptsDir)) continue;
    let runDirs;
    try {
      runDirs = fs.readdirSync(transcriptsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const runDir of runDirs) {
      if (!runDir.isDirectory()) continue;
      const runId = runDir.name;
      const jsonlPath = path.join(transcriptsDir, runId, `${runId}.jsonl`);
      let st;
      try {
        st = fs.statSync(jsonlPath);
      } catch {
        continue;
      }
      if (linkedAtMs && st.mtimeMs < linkedAtMs) continue;
      let raw;
      try {
        raw = fs.readFileSync(jsonlPath, 'utf8');
      } catch {
        continue;
      }
      if (!cursorTranscriptShouldClearWatch(raw, linkedIso)) continue;
      out.push({
        conversation_id: runId,
        transcript_path: jsonlPath,
        mtime_ms: st.mtimeMs,
      });
    }
  }
  return out;
}

async function readCursorTranscriptText(cursorTracking, options = {}) {
  if (!cursorTracking || typeof cursorTracking !== 'object') return '';
  const transcriptPath = await resolveCursorTranscriptPath(cursorTracking, options);
  if (!transcriptPath) return '';
  if (cursorTracking.source === 'ssh') {
    const { assertValidRemoteSource, createSshRunner, shellQuote } = require('./remote_cursor_tracker');
    const remote = assertValidRemoteSource({
      host: cursorTracking.host,
      projects_root: cursorTracking.projects_root,
    });
    const runSsh = options.runSsh || createSshRunner();
    const quotedPath = shellQuote(transcriptPath);
    const cmd = `if [ -f ${quotedPath} ]; then cat ${quotedPath} 2>/dev/null || true; fi`;
    return runSsh(remote.host, cmd, options.timeoutMs);
  }
  try {
    return await fsp.readFile(transcriptPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

async function cursorWatchShouldClearSince(cursorTracking, options = {}) {
  const linkedAtIso = typeof cursorTracking?.linked_at === 'string' ? cursorTracking.linked_at : '';
  const linkedAtMs = Date.parse(linkedAtIso || '') || 0;
  const raw = await readCursorTranscriptText(cursorTracking, options);
  if (raw && cursorTranscriptShouldClearWatch(raw, linkedAtIso)) return true;

  const workspaceSlugs = options.workspaceSlugs || workspaceSlugSetFromTracking(cursorTracking);
  if (!workspaceSlugs.size || cursorTracking?.source === 'ssh') return false;

  const matches = discoverLocalPendingAskQuestionRuns(
    workspaceSlugs,
    linkedAtMs,
    options.homeDir
  );
  if (!matches.length) return false;
  const conversationId = normalizeConversationId(
    cursorTracking.conversation_id || cursorTracking.run_id || ''
  );
  if (conversationId && matches.some((m) => normalizeConversationId(m.conversation_id) === conversationId)) {
    return true;
  }
  return matches.length === 1;
}

module.exports = {
  discoverCursorRuns,
  discoverCursorRunsForProject,
  assertAllowedTranscriptPath,
  getCursorProjectsRoot,
  readTranscriptTailText,
  readTranscriptTail,
  readCursorTranscriptText,
  findLocalTranscriptPathByRunId,
  resolveLocalCursorTranscriptPath,
  resolveCursorTranscriptPath,
  findRemoteTranscriptPathByRunId,
  discoverLocalPendingAskQuestionRuns,
  latestUserWordsPreviewFromTailText,
  defaultCursorTracking,
  defaultRemoteCursorTracking,
  normalizeCursorTracking,
  workspacePathToProjectSlug,
  buildWorkspaceSlugSet,
  CURSOR_ASK_QUESTION_TOOL,
  isCursorTranscriptManualAbortLine,
  cursorTranscriptCancelSince,
  cursorTranscriptShouldClearWatch,
  cursorWatchShouldClearSince,
  DEFAULT_MAX_RUNS,
  DEFAULT_POLL_MS,
};
