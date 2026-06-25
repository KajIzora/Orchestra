const express = require('express');
const fs = require('fs');
const path = require('path');
const net = require('net');

require('./lib/env').loadDotEnv();

const storage = require('./lib/storage');
const { projectId, taskId } = require('./lib/ids');
const {
  runFocusCommands,
  normalizeLaunchCommands,
  normalizeTaskFocusCommandsForRun,
} = require('./lib/focus');
const {
  normalizeWorkspaceItems,
  normalizeWorkspaceState,
  buildWorkspaceCommands,
  mergeWorkspaceCommands,
} = require('./lib/workspace_items');
const {
  anyLocalPathUnderConfiguredRoots,
  anyPosixPathUnderConfiguredRoots,
} = require('./lib/workspace_scope');
const {
  discoverCursorRuns,
  assertAllowedTranscriptPath,
  findLocalTranscriptPathByRunId,
  findRemoteTranscriptPathByRunId,
  buildWorkspaceSlugSet,
  workspacePathToProjectSlug,
  cursorWatchShouldClearSince,
  cursorTranscriptCancelSince,
  cursorTranscriptAskQuestionRecordedSince,
  readCursorTranscriptText,
} = require('./lib/cursor_tracker');
const {
  assertValidRemoteSource,
  createSshRunner,
  assertAllowedRemoteTranscriptPath,
  ensureRemoteCursorHooks,
  readRemoteHookEvents,
  REMOTE_HOOK_SCRIPT_PATH,
  REMOTE_HOOKS_JSON_PATH,
  REMOTE_HOOK_LOG_PATH,
} = require('./lib/remote_cursor_tracker');
const {
  normalizeStoredCursorRemotes,
  assignProjectCursorRemotes,
  normalizeRemoteRow,
  resolveCursorRemoteEntry,
  resolveCursorRemoteEntryStrict,
  workspaceRootsForRemoteConfig,
} = require('./lib/cursor_remotes');
const {
  shouldApplyCursorHookCompletionNow,
  touchCursorSubagentWatchOnSpawn,
  initializeMultitaskSubagentWatchOnLink,
} = require('./lib/cursor_multitask_subagent');
const {
  createWatchPoller,
  normalizeWatchTracking,
  cursorToWatchTracking,
  remoteCursorToWatchTracking,
  defaultProcessTracking,
  defaultRemoteProcessTracking,
  defaultNotificationTracking,
  finishedMarker,
  recordWatchFinished,
  markHumanGateWatchClear,
  markCancelledWatchClear,
  resumeWatchTracking,
  isPermissionAttentionReason,
} = require('./lib/watch_tracker');
const { createBrowserChatStore, applyBrowserChatCompletion, applyBrowserChatResume } = require('./lib/browser_chat');
const { createCursorHookStore, normalizeConversationId } = require('./lib/cursor_hook_store');
const {
  createCursorCliPermissionTracker,
  loadCursorCliConfig,
  loadCursorCliConfigRemote,
  isCursorCliHook,
} = require('./lib/cursor_cli_permission');
const { createCursorChatDbReader, remotePendingAskQuestion } = require('./lib/cursor_chat_db');
const { createRendererPermissionProbe } = require('./lib/cursor_renderer_permission_probe');
const { createAgentExecPermissionProbe } = require('./lib/cursor_agent_exec_probe');
const { applyCursorRendererPermissionEvents } = require('./lib/cursor_renderer_watch');
const { createHookEventLog } = require('./lib/hook_event_log');
const { createCodexHookStore } = require('./lib/codex_hook_store');
const { applyCodexHookCompletion, applyCodexHookResume } = require('./lib/codex_hook_completion');
const { getCodexTaskAppHookScript } = require('./lib/codex_hook_script');
const { ensureRemoteCodexHooks } = require('./lib/remote_codex_hooks');
const { createClaudeHookStore, normalizeSessionId } = require('./lib/claude_hook_store');
const { getClaudeTaskAppHookScript } = require('./lib/claude_hook_script');
const { buildHookForwarderBlock } = require('./lib/hook_forwarder');
const { createGeminiHookStore } = require('./lib/gemini_hook_store');
const { buildGeminiPollerDeps } = require('./lib/gemini_poller_deps');
const { parseSubAgentChildren } = require('./lib/antigravity_subagents');
const { getAntigravityBrainRoots, transcriptPathFromArtifactDirectory } = require('./lib/antigravity_hook_signals');
const { getGeminiTaskAppHookScript } = require('./lib/gemini_hook_script');
const {
  ensureRemoteClaudeHooks,
  REMOTE_CLAUDE_HOOK_SCRIPT_PATH,
  REMOTE_CLAUDE_SETTINGS_PATH,
} = require('./lib/remote_claude_hooks');
const {
  ensureRemoteGeminiHooks,
  REMOTE_GEMINI_HOOK_SCRIPT_PATH,
  REMOTE_GEMINI_AGY_HOOKS_JSON_PATH,
  REMOTE_GEMINI_SETTINGS_PATH,
  AGY_HOOK_EVENTS,
} = require('./lib/remote_gemini_hooks');
const { getHookEventsForProfile, normalizeHookProfile } = require('./lib/signal_registry');
const {
  assertAllowedCodexTranscriptPath,
  codexWatchShouldClearSince,
  assertAllowedRemoteCodexTranscriptPath,
  remoteCodexWatchShouldClearSince,
  enrichCodexPickerRunWithTranscript,
  codexWatchActiveGenerationSince,
  remoteCodexWatchActiveGenerationSince,
} = require('./lib/codex_tracker');
const {
  claudePermissionCompletionHintIsStale,
  claudePausedWatchShouldCancel,
  assertAllowedClaudeTranscriptPath,
  assertAllowedRemoteClaudeTranscriptPath,
  remoteClaudeWatchCompletionSince,
  claudeTranscriptWatchCompletionSince,
  enrichClaudeHookPickerRuns,
  claudeWatchActiveGenerationSince,
  remoteClaudeWatchActiveGenerationSince,
} = require('./lib/claude_tracker');
const { pickerRunsFromClaudeSnapshots } = require('./lib/claude_picker_from_hooks');
const { pickerRunsFromGeminiSnapshots } = require('./lib/gemini_picker_from_hooks');
const {
  readLocalAgyCliCancelSignals,
  readRemoteAgyCliCancelSignals,
  readRemoteAgyCliDbPermissionSignals,
  readRemoteAgyCliPermissionSignals,
  readLocalAgyCliDbPermissionSignals,
  readLocalAgyCliPermissionSignals,
  readLocalAgyAppCancelSignals,
  readLocalAgyAppLanguageServerCancelSignals,
  readLocalAgyAppPermissionSignals,
  agyAppSessionHasPendingPermission,
  agyCliSessionHasPendingPermission,
} = require('./lib/antigravity_cli_tracker');
const {
  agyAppSignalToGeminiHookBody,
  agyAppCancelHookBody,
} = require('./lib/agy_app_signal_channel');
const {
  discoverClaudeCoworkRuns,
  assertAllowedCoworkAuditPath,
  coworkTurnCompletedSince,
  coworkWatchActiveGenerationSince,
} = require('./lib/claude_cowork_tracker');
const {
  discoverGeminiRuns,
  assertAllowedGeminiTranscriptPath,
  discoverRemoteGeminiRuns,
  enrichGeminiHookPickerRuns,
  assertAllowedRemoteGeminiTranscriptPath,
  geminiTaskCancelledSince,
  geminiTaskCompletedSince,
  remoteGeminiTaskCancelledSince,
  remoteGeminiTaskCompletedSince,
} = require('./lib/gemini_tracker');
const { readRemoteGeminiHookDebugEvents } = require('./lib/remote_gemini_hook_tracker');
const { applyActiveGenerationStaleCutoff, toIso } = require('./lib/active_generation');
const {
  getOrCreateHookToken,
  getOrCreateAppToken,
  isLocalBindHost,
  isLoopbackClient,
  verifyAppToken,
} = require('./lib/hook_tokens');
const { backupLocalHookConfigFile } = require('./lib/remote_hook_config');
const { listLocalProcesses, listRemoteProcesses } = require('./lib/process_tracker');
const { getLatestNotificationRecId } = require('./lib/notification_center');
const {
  createRemoteHookTunnelManager,
  preferredRemoteTunnelPort,
} = require('./lib/remote_hook_tunnel');

const DEFAULT_PORT = parseInt(process.env.PORT, 10) || 47823;
const HOST = process.env.HOST || '127.0.0.1';

const APP_TOKEN = getOrCreateAppToken();
const CONFIG_PATHS = new Set([
  '/api/browser-chats/config',
  '/api/cursor-hooks/config',
  '/api/codex-hooks/config',
  '/api/claude-hooks/config',
  '/api/gemini-hooks/config',
]);
const HOOK_AUTHED_WRITE_PREFIXES = [
  '/api/cursor-hooks/event',
  '/api/codex-hooks/event',
  '/api/claude-hooks/event',
  '/api/gemini-hooks/event',
  '/api/browser-chats/snapshot',
  '/api/browser-chats/stream-signal',
  '/api/browser-chats/tab-closed',
  '/api/browser-chats/complete',
  '/api/browser-chats/drive',
];

function serverExposesNonLocalBind() {
  return !isLocalBindHost(HOST);
}

function routeHasDedicatedTokenAuth(pathname) {
  return HOOK_AUTHED_WRITE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function requireAppTokenWhenExposed(req, res, next) {
  if (!serverExposesNonLocalBind() || isLoopbackClient(req)) return next();
  if (verifyAppToken(req, APP_TOKEN)) return next();
  return res.status(401).json({ error: 'Invalid or missing Orchestra app token' });
}
const VALID_STATUSES = new Set(['todo', 'waiting', 'done']);
const VALID_COLORS = new Set([
  'teal',
  'purple',
  'coral',
  'blue',
  'amber',
  'gray',
  'rose',
  'emerald',
  'indigo',
  'magenta',
  'lime',
  'orange',
  'cyan',
  'slate',
]);
const VALID_WORKSPACE_SOURCES = new Set(['local', 'ssh']);
function resolveHookToken(envName, provider) {
  const fromEnv = process.env[envName];
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  return getOrCreateHookToken(provider);
}
const cursorHookStore = createCursorHookStore({ token: resolveHookToken('CURSOR_HOOK_TOKEN', 'cursor') });
// cursor-CLI permission inference (config-eval + arm/resume). Fed ONLY by CLI tool hooks
// (gated by cursor_version); the cursor IDE keeps its renderer/agent-exec permission probes.
// forceMode is left unset — the live server watches runs it didn't launch, so --force is
// unknown; the tracker's debounce + per-session force-latch handle that (see the module doc).
// Config is re-read per workspace with a short TTL so "Always allow" mid-session is picked up.
// Remote (source:'ssh') runs keep their config on the REMOTE host, so it is SSH-read and cached
// with a longer TTL; the tracker's resolveConfig must stay synchronous, so a cold-miss returns
// a placeholder and refreshes in the background (see below).
const cursorCliConfigCache = new Map(); // key -> { config, at }
const CURSOR_CLI_CONFIG_TTL_MS = 5000;
const CURSOR_CLI_REMOTE_CONFIG_TTL_MS = 30000;
const cursorCliRemoteFetches = new Set(); // in-flight ssh reads, deduped by key

function scheduleRemoteCursorCliConfigRefresh(key, host, roots, cwd) {
  if (cursorCliRemoteFetches.has(key)) return;
  cursorCliRemoteFetches.add(key);
  loadCursorCliConfigRemote({ host, workspaceRoots: roots, cwd, runSsh: createSshRunner(), timeoutMs: 4000 })
    .then((config) => {
      cursorCliConfigCache.set(key, { config, at: Date.now() });
    })
    .catch(() => {})
    .finally(() => {
      cursorCliRemoteFetches.delete(key);
    });
}

function resolveCursorCliConfig(body) {
  const roots = Array.isArray(body?.workspace_roots) ? body.workspace_roots.filter(Boolean) : [];
  const cwd = (typeof body?.cwd === 'string' && body.cwd) || roots[0] || '';
  const isRemote = !!(body && (body.source === 'ssh' || body.remote_host));
  const host = isRemote ? body.host || body.remote_host || '' : '';
  const leaf = cwd || '(none)';
  const key = isRemote ? `ssh\0${host}\0${leaf}` : `local\0${leaf}`;
  const cached = cursorCliConfigCache.get(key);
  const now = Date.now();
  const ttlMs = isRemote ? CURSOR_CLI_REMOTE_CONFIG_TTL_MS : CURSOR_CLI_CONFIG_TTL_MS;
  if (cached && now - cached.at < ttlMs) return cached.config;

  if (isRemote) {
    if (host) scheduleRemoteCursorCliConfigRefresh(key, host, roots, cwd);
    // Use last-known config while the SSH read is in flight. On a COLD miss, treat the run as
    // Run-Everything so we do NOT arm on an unknown remote config — that avoids a spurious
    // force-latch from a tool that auto-runs fast before the real config has loaded.
    return cached ? cached.config : { allow: [], deny: [], approvalMode: 'auto' };
  }

  let config;
  try {
    config = loadCursorCliConfig({ workspaceRoots: roots, cwd });
  } catch {
    config = { allow: [], deny: [], approvalMode: '' };
  }
  cursorCliConfigCache.set(key, { config, at: now });
  return config;
}
const cursorCliPermissionTracker = createCursorCliPermissionTracker({
  resolveConfig: resolveCursorCliConfig,
});
// cursor-CLI question gate: cursor emits NO hook and only a DELAYED transcript AskQuestion (written
// after the answer), but the chat store.db carries the pending question the instant the gate renders.
// This reader returns "is the head a pending AskQuestion" for a tracked conversation (local-only,
// mtime-gated, linked_at-gated). It AUGMENTS the transcript path (see getCursorChatDbQuestionHint).
const cursorChatDbReader = createCursorChatDbReader();
// `--source ssh` cursor-cli runs the agent headless on the REMOTE, so its chat store.db is on the
// remote. The watch poll's chat-db hint is synchronous, so (like the remote CLI-config above) we keep
// a small cache and refresh it in the background over ssh; a cold miss returns false (no early signal
// yet) and the next poll picks up the cached pending state. TTL ~ the 2s poll cadence.
const cursorChatDbRemoteCache = new Map(); // key (host\0conv) -> { pending, at }
const CURSOR_CHATDB_REMOTE_TTL_MS = 3000;
const cursorChatDbRemoteFetches = new Set(); // in-flight ssh reads, deduped by key
function scheduleRemoteCursorChatDbRefresh(key, host, conv, sinceMs) {
  if (cursorChatDbRemoteFetches.has(key)) return;
  cursorChatDbRemoteFetches.add(key);
  remotePendingAskQuestion({ host, conversationId: conv, sinceMs, runSsh: createSshRunner(), timeoutMs: 4000 })
    .then((pending) => { cursorChatDbRemoteCache.set(key, { pending: !!pending, at: Date.now() }); })
    .catch(() => {})
    .finally(() => { cursorChatDbRemoteFetches.delete(key); });
}
const codexHookStore = createCodexHookStore({ token: resolveHookToken('CODEX_HOOK_TOKEN', 'codex') });
const claudeHookStore = createClaudeHookStore({
  token: resolveHookToken('CLAUDE_HOOK_TOKEN', 'claude'),
  requireEmptySessionCronsForStop: true,
  // A "busy" Stop (running background tasks / pending crons) is held this long before the
  // watch flips to done; an idle Stop clears immediately. Resume within the window stays
  // tracking; after it, "done" was shown and tracking re-arms (flicker). Tunable via env.
  stopDebounceMs: Number.parseInt(process.env.CLAUDE_STOP_DEBOUNCE_MS || '', 10) || 15000,
});
// Lossless raw-hook tap: keeps exact /event bodies briefly so a signal-recording
// session can capture them verbatim. In-memory only; never persisted by the server.
const hookEventLog = createHookEventLog();
const geminiHookStore = createGeminiHookStore({ token: resolveHookToken('GEMINI_HOOK_TOKEN', 'gemini') });
// Test/diagnostic toggle: when set, the only agy-cli "done" completion is the primary
// Stop+fullyIdle+NO_TOOL_CALL hook — the secondary idle-quiescence and transcript-done paths
// are disabled. Lets the harness confirm which runs the primary done signal does (not) fire on.
// Read once at startup (poller wiring), so the dev server must be (re)started with the env set.
const AGY_PRIMARY_DONE_ONLY = /^(1|true|yes)$/i.test(String(process.env.ORCHESTRA_AGY_PRIMARY_DONE_ONLY || ''));
if (AGY_PRIMARY_DONE_ONLY) {
  console.warn('[orchestra] ORCHESTRA_AGY_PRIMARY_DONE_ONLY is set — agy-cli secondary done paths (idle-quiescence + transcript-done) are DISABLED.');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function createGeminiSubAgentIdCollector() {
  const cache = new Map();
  const cacheKey = (source, host, transcriptPath) =>
    `${source === 'ssh' ? 'ssh' : 'local'}:${host || ''}:${transcriptPath || ''}`;
  const readDirectChildren = (ideTracking, transcriptPath) => {
    const source = ideTracking?.source === 'ssh' ? 'ssh' : 'local';
    const host = source === 'ssh' ? String(ideTracking?.host || '').trim() : '';
    const key = cacheKey(source, host, transcriptPath);
    if (source === 'ssh') return cache.get(key)?.children || [];
    try {
      const st = fs.statSync(transcriptPath);
      const cached = cache.get(key);
      if (cached && cached.mtimeMs === st.mtimeMs) return cached.children;
      const children = parseSubAgentChildren(fs.readFileSync(transcriptPath, 'utf8'));
      cache.set(key, { mtimeMs: st.mtimeMs, children });
      return children;
    } catch {
      return [];
    }
  };
  const collect = (ideTracking) => {
    if (!ideTracking || !ideTracking.transcript_path) return [];
    const ids = [];
    const seen = new Set();
    const visited = new Set();
    const queue = [ideTracking.transcript_path];
    while (queue.length) {
      const p = queue.shift();
      if (!p || visited.has(p)) continue;
      visited.add(p);
      for (const child of readDirectChildren(ideTracking, p)) {
        if (child.conversationId && !seen.has(child.conversationId)) {
          seen.add(child.conversationId);
          ids.push(child.conversationId);
        }
        if (child.transcriptPath) queue.push(child.transcriptPath);
      }
    }
    return ids;
  };
  const refresh = async (ideTracking, runSsh, options = {}) => {
    if (!ideTracking || ideTracking.source !== 'ssh' || !ideTracking.host || !ideTracking.transcript_path) {
      return collect(ideTracking);
    }
    if (typeof runSsh !== 'function') return collect(ideTracking);
    const source = 'ssh';
    const host = String(ideTracking.host || '').trim();
    const queue = [ideTracking.transcript_path];
    const visited = new Set();
    while (queue.length) {
      const transcriptPath = queue.shift();
      if (!transcriptPath || visited.has(transcriptPath)) continue;
      visited.add(transcriptPath);
      try {
        const q = shellQuote(transcriptPath);
        const raw = await runSsh(host, `if [ -f ${q} ]; then cat ${q} 2>/dev/null || true; fi`, options.timeoutMs);
        const children = parseSubAgentChildren(String(raw || ''));
        cache.set(cacheKey(source, host, transcriptPath), { mtimeMs: Date.now(), children });
        for (const child of children) {
          if (child.transcriptPath && !visited.has(child.transcriptPath)) queue.push(child.transcriptPath);
        }
      } catch {
        // Leave the last good cache entry in place.
      }
    }
    return collect(ideTracking);
  };
  return { collect, refresh };
}

const geminiSubAgentIds = createGeminiSubAgentIdCollector();
const geminiCollectSubAgentIds = (ideTracking) => geminiSubAgentIds.collect(ideTracking);

// Resolve the on-disk transcript for a hook snapshot so we can read its INVOKE_SUBAGENT children.
// agy-cli snapshots carry transcript_path directly. agy-app snapshots are reconstructed from DB
// signals and carry only session_id, so we rebuild the brain transcript path from the conversation
// id (both agy-cli and agy-app write the same brain/<id>/.system_generated/logs/transcript.jsonl).
function localAgySnapshotTranscriptPath(snap) {
  if (snap && typeof snap.transcript_path === 'string' && snap.transcript_path.trim()) {
    return snap.transcript_path.trim();
  }
  const sid = String(snap?.session_id || '').trim();
  if (!sid) return '';
  for (const brainRoot of getAntigravityBrainRoots(process.env.HOME || undefined)) {
    const candidate = transcriptPathFromArtifactDirectory(path.join(brainRoot, sid), process.env.HOME || undefined);
    try {
      if (candidate && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next brain root
    }
  }
  return '';
}

// Union of every agy sub-agent conversation id reachable from the given snapshots' transcripts.
// Sub-agents get their own hook snapshot, so the picker uses this to drop them and only show
// top-level runs. SSH snapshots resolve via the collector's cache (populated during polling);
// local snapshots (agy-cli and agy-app) read the brain transcript directly.
function geminiSubAgentSessionIdSet(snapshots) {
  const ids = new Set();
  for (const snap of Array.isArray(snapshots) ? snapshots : []) {
    if (!snap) continue;
    const isRemote = !!snap.remote_host;
    // Remote app snapshots have no local transcript and no resolvable brain path; rely on cache.
    const transcriptPath = isRemote ? snap.transcript_path : localAgySnapshotTranscriptPath(snap);
    if (!transcriptPath) continue;
    const ideTracking = {
      transcript_path: transcriptPath,
      source: isRemote ? 'ssh' : 'local',
      host: snap.remote_host || null,
    };
    for (const id of geminiCollectSubAgentIds(ideTracking)) {
      if (id) ids.add(String(id).trim().toLowerCase());
    }
  }
  return ids;
}
const geminiHookApplyOptions = () => ({
  subAgentIds: geminiCollectSubAgentIds,
  resumeTask: (task, pausedWt) => resumeWatchTracking(task, pausedWt, applyTaskStatusChange),
});

function nowIso() {
  return new Date().toISOString();
}

function attachCursorWatchWorkspaceSlugs(project, tracking, source) {
  if (!tracking || tracking.kind !== 'cursor') return tracking;
  const workspaces = Array.isArray(project?.cursor_workspaces) ? project.cursor_workspaces : [];
  if (source === 'ssh') {
    const paths = workspaces
      .filter((w) => w && w.source === 'ssh' && typeof w.workspace_path === 'string')
      .map((w) => w.workspace_path);
    tracking.workspace_slugs = [
      ...new Set(paths.map((p) => workspacePathToProjectSlug(p, 'ssh')).filter(Boolean)),
    ];
  } else {
    const paths = workspaces
      .filter((w) => w && w.source !== 'ssh' && typeof w.workspace_path === 'string')
      .map((w) => w.workspace_path);
    tracking.workspace_slugs = [...buildWorkspaceSlugSet(paths, 'local')];
  }
  return tracking;
}

async function resolveCursorWatchTranscriptOnLink(tracking, source) {
  if (!tracking || tracking.kind !== 'cursor') return tracking;
  if (typeof tracking.transcript_path === 'string' && tracking.transcript_path.trim()) return tracking;
  const runId = tracking.conversation_id || tracking.run_id || '';
  if (!runId) return tracking;
  if (source === 'ssh') {
    const resolved = await findRemoteTranscriptPathByRunId(
      { host: tracking.host, projects_root: tracking.projects_root },
      runId
    );
    if (resolved) tracking.transcript_path = resolved;
  } else {
    const resolved = findLocalTranscriptPathByRunId(runId);
    if (resolved) tracking.transcript_path = resolved;
  }
  return tracking;
}


function rollUpSnapshotsForPicker(provider, snapshots) {
  if (provider !== 'codex') return Array.isArray(snapshots) ? snapshots : [];
  return Array.isArray(snapshots) ? snapshots : [];
}

function snapshotToLocalPickerRun(snap) {
  const updatedMs = Date.parse(snap.updated_at || '') || 0;
  const hookGenerating = !!snap.generating && !snap.completion_hint;
  const activeGen = applyActiveGenerationStaleCutoff(
    {
      generating: hookGenerating,
      start_signal_at: toIso(updatedMs),
      last_activity_at: toIso(updatedMs),
      inactive_reason: hookGenerating ? '' : 'completion_signal',
    },
    { mtimeMs: updatedMs }
  );
  return {
    kind: 'ide_agent',
    provider: 'codex',
    source: 'local',
    session_id: snap.session_id || '',
    transcript_path: snap.transcript_path || '',
    title: snap.title || '',
    workspace_path: snap.workspace_path || '',
    updated_at: snap.updated_at || '',
    mtime_ms: updatedMs,
    last_user_preview: snap.last_user_preview || snap.session_id || '',
    host: null,
    projects_root: null,
    state_location: '',
    completion_hint: !!snap.completion_hint,
    ...activeGen,
  };
}

function snapshotToPickerRun(snap, provider, remote, workspace) {
  const updatedMs = Date.parse(snap.updated_at || '') || 0;
  const hookGenerating = !!snap.generating && !snap.completion_hint;
  const activeGen = applyActiveGenerationStaleCutoff(
    {
      generating: hookGenerating,
      start_signal_at: toIso(updatedMs),
      last_activity_at: toIso(updatedMs),
      inactive_reason: hookGenerating ? '' : 'completion_signal',
    },
    { mtimeMs: updatedMs }
  );
  return {
    kind: 'ide_agent',
    provider,
    source: 'ssh',
    session_id: snap.session_id || '',
    transcript_path: snap.transcript_path || '',
    title: snap.title || '',
    workspace_path: snap.workspace_path || workspace || '',
    updated_at: snap.updated_at || '',
    mtime_ms: updatedMs,
    last_user_preview: snap.last_user_preview || snap.session_id || '',
    host: remote.host,
    projects_root: remote.projects_root,
    state_location: 'remote',
    completion_hint: !!snap.completion_hint,
    notification_type: snap.notification_type || '',
    ...activeGen,
  };
}

function geminiRunActivityMs(run) {
  if (!run || typeof run !== 'object') return 0;
  return Math.max(
    Date.parse(run.updated_at || '') || 0,
    Date.parse(run.last_activity_at || '') || 0,
    Number.isFinite(run.mtime_ms) ? run.mtime_ms : 0
  );
}

function geminiRunMatchesSnapshot(run, snap) {
  if (!run || !snap) return false;
  const runSession = typeof run.session_id === 'string' ? run.session_id.trim() : '';
  const snapSession = typeof snap.session_id === 'string' ? snap.session_id.trim() : '';
  if (runSession && snapSession && runSession === snapSession) return true;
  const runTranscript = typeof run.transcript_path === 'string' ? run.transcript_path.trim() : '';
  const snapTranscript = typeof snap.transcript_path === 'string' ? snap.transcript_path.trim() : '';
  return !!(runTranscript && snapTranscript && runTranscript === snapTranscript);
}

function annotateGeminiPermissionState(runs, snapshots) {
  const permissionSnaps = (Array.isArray(snapshots) ? snapshots : []).filter(
    (snap) =>
      (snap?.event_name === 'Notification' && snap.notification_type === 'ToolPermission') ||
      snap?.permission_pending === true
  );
  if (!permissionSnaps.length) return Array.isArray(runs) ? runs : [];
  return (Array.isArray(runs) ? runs : []).map((run) => {
    const snap = permissionSnaps.find((candidate) => geminiRunMatchesSnapshot(run, candidate));
    if (!snap) return run;
    const snapMs = Date.parse(snap.updated_at || '') || 0;
    const runMs = geminiRunActivityMs(run);
    const permissionStillPending = !snapMs || !runMs || runMs < snapMs;
    return {
      ...run,
      notification_type: permissionStillPending ? 'ToolPermission' : '',
    };
  });
}

async function listCodexRunsFromHookStore(project, source) {
  const rolledUp = rollUpSnapshotsForPicker('codex', codexHookStore.listSnapshots());
  const localWorkspaces = (project.cursor_workspaces || [])
    .filter((item) => item && item.source === 'local' && typeof item.workspace_path === 'string')
    .map((item) => item.workspace_path.trim())
    .filter(Boolean);

  if (source !== 'ssh') {
    const runs = [];
    const seenKeys = new Set();
    for (const snap of rolledUp) {
      if (!snap) continue;
      if (snap.remote_host) continue;
      if (localWorkspaces.length) {
        const ws = String(snap.workspace_path || '').trim();
        if (!anyLocalPathUnderConfiguredRoots(localWorkspaces, ws)) continue;
      }
      const run = snapshotToLocalPickerRun(snap);
      const key = run.transcript_path || run.session_id;
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      runs.push(run);
    }
    runs.sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0));
    const enriched = await Promise.all(runs.map((run) => enrichCodexPickerRunWithTranscript(run)));
    return { runs: enriched, error: null };
  }

  const remotes =
    Array.isArray(project.cursor_remotes) && project.cursor_remotes.length
      ? project.cursor_remotes.map((r) => assertValidRemoteSource(r))
      : project.cursor_remote?.host
        ? [assertValidRemoteSource(project.cursor_remote)]
        : [];
  if (!remotes.length) {
    return { runs: [], error: 'Project has no remote watch host configured' };
  }

  const runs = [];
  for (const remote of remotes) {
    const pathsForRemote = (project.cursor_workspaces || [])
      .filter((item) => item && item.source === 'ssh' && typeof item.workspace_path === 'string')
      .filter((item) => {
        try {
          const cfg = resolveCursorRemoteEntry(project, item.remote_id);
          return cfg.host === remote.host && cfg.projects_root === remote.projects_root;
        } catch {
          return false;
        }
      })
      .map((item) => item.workspace_path.trim())
      .filter(Boolean);
    if (!pathsForRemote.length) continue;
    const seenKeys = new Set();
    for (const snap of rolledUp) {
      if (!snap) continue;
      if (snap.remote_host !== remote.host) continue;
      const ws = String(snap.workspace_path || '').trim();
      if (!anyPosixPathUnderConfiguredRoots(pathsForRemote, ws)) continue;
      const snapRun = snapshotToPickerRun(snap, 'codex', remote, ws);
      const key = snapRun.transcript_path || `${snapRun.session_id}::${ws}`;
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      runs.push(snapRun);
    }
  }
  runs.sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0));
  const enriched = await Promise.all(
    runs.map((run) =>
      enrichCodexPickerRunWithTranscript(run, {
        remote: { host: run.host, projects_root: run.projects_root },
      })
    )
  );
  return { runs: enriched, error: null };
}

async function listGeminiRunsFromHookStore(project, source, options = {}) {
  const rolledUpSnapshots = rollUpSnapshotsForPicker('gemini', geminiHookStore.listSnapshots());
  const excludeSessionIds = geminiSubAgentSessionIdSet(rolledUpSnapshots);

  if (source !== 'ssh') {
    const localWorkspaces = (project.cursor_workspaces || [])
      .filter((item) => item && item.source === 'local' && typeof item.workspace_path === 'string')
      .map((item) => item.workspace_path.trim())
      .filter(Boolean);
    const snapshotRuns = pickerRunsFromGeminiSnapshots(rolledUpSnapshots, {
      source: 'local',
      localWorkspaces,
      excludeSessionIds,
    });
    const annotated = annotateGeminiPermissionState(snapshotRuns, rolledUpSnapshots);
    const runs = await enrichGeminiHookPickerRuns(annotated, rolledUpSnapshots);
    return { runs, error: null };
  }

  const remotes =
    Array.isArray(project.cursor_remotes) && project.cursor_remotes.length
      ? project.cursor_remotes.map((r) => assertValidRemoteSource(r))
      : project.cursor_remote?.host
        ? [assertValidRemoteSource(project.cursor_remote)]
        : [];
  if (!remotes.length) {
    return { runs: [], error: 'Project has no remote watch host configured' };
  }

  const remoteConfigs = remotes.map((remote) => {
    const workspaces = (project.cursor_workspaces || [])
      .filter((item) => item && item.source === 'ssh' && typeof item.workspace_path === 'string')
      .filter((item) => {
        try {
          const cfg = resolveCursorRemoteEntry(project, item.remote_id);
          return cfg.host === remote.host && cfg.projects_root === remote.projects_root;
        } catch {
          return false;
        }
      })
      .map((item) => item.workspace_path.trim())
      .filter(Boolean);
    return { host: remote.host, projects_root: remote.projects_root, workspaces };
  });

  const snapshotRuns = pickerRunsFromGeminiSnapshots(rolledUpSnapshots, {
    source: 'ssh',
    remotes: remoteConfigs,
    excludeSessionIds,
  });
  const annotated = annotateGeminiPermissionState(snapshotRuns, rolledUpSnapshots);
  const runs = await enrichGeminiHookPickerRuns(annotated, rolledUpSnapshots, {
    // Keep hook-driven discovery for speed, but allow transcript enrichment
    // so remote agy rows inherit completion/cancel state and real user preview.
    hookOnlyRemote: false,
  });

  runs.sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0));
  return { runs, error: null };
}

async function listClaudeRunsFromHookStore(project, source) {
  const snapshots = claudeHookStore.listSnapshots();
  if (source !== 'ssh') {
    const localWorkspaces = (project.cursor_workspaces || [])
      .filter((item) => item && item.source === 'local' && typeof item.workspace_path === 'string')
      .map((item) => item.workspace_path.trim())
      .filter(Boolean);
    const runs = pickerRunsFromClaudeSnapshots(snapshots, { source: 'local', localWorkspaces });
    return {
      runs: await enrichClaudeHookPickerRuns(runs, snapshots),
      error: null,
    };
  }
  const remotes =
    Array.isArray(project.cursor_remotes) && project.cursor_remotes.length
      ? project.cursor_remotes.map((r) => assertValidRemoteSource(r))
      : project.cursor_remote?.host
        ? [assertValidRemoteSource(project.cursor_remote)]
        : [];
  if (!remotes.length) {
    return { runs: [], error: 'Project has no remote watch host configured' };
  }
  const remoteConfigs = remotes.map((remote) => {
    const workspaces = (project.cursor_workspaces || [])
      .filter((item) => item && item.source === 'ssh' && typeof item.workspace_path === 'string')
      .filter((item) => {
        try {
          const cfg = resolveCursorRemoteEntry(project, item.remote_id);
          return cfg.host === remote.host && cfg.projects_root === remote.projects_root;
        } catch {
          return false;
        }
      })
      .map((item) => item.workspace_path.trim())
      .filter(Boolean);
    return { host: remote.host, projects_root: remote.projects_root, workspaces };
  });
  const runs = pickerRunsFromClaudeSnapshots(snapshots, { source: 'ssh', remotes: remoteConfigs });
  return {
    runs: await enrichClaudeHookPickerRuns(runs, snapshots),
    error: null,
  };
}

function findPort(startPort) {
  const strictPort = process.env.PORT != null && String(process.env.PORT).trim() !== '';
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      const server = net.createServer();
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          if (strictPort && p === startPort) {
            reject(
              new Error(
                `Port ${p} is already in use (PORT=${process.env.PORT}). Quit the other Orchestra process: lsof -nP -iTCP:${p} -sTCP:LISTEN`
              )
            );
            return;
          }
          if (p > startPort + 50) {
            reject(new Error(`No free port found starting at ${startPort}`));
          } else {
            tryPort(p + 1);
          }
        } else {
          reject(err);
        }
      });
      server.once('listening', () => {
        server.close(() => resolve(p));
      });
      server.listen(p, HOST);
    };
    tryPort(startPort);
  });
}

function findProject(id) {
  return storage.getState().projects.find((p) => p.id === id);
}

function findTask(project, id) {
  return project.tasks.find((t) => t.id === id);
}

function renumber(arr) {
  arr.forEach((item, i) => {
    item.order = i;
  });
}

function applyTaskStatusChange(task, nextStatus) {
  const prev = task.status;
  if (prev === nextStatus) return;
  task.status = nextStatus;
  if (nextStatus === 'waiting') {
    task.waiting_since = nowIso();
    task.last_watch_clear = null;
    // Re-tracking (or starting a manual wait) clears any "agent finished" badge
    // and any paused watcher held for resume.
    task.watch_finished = null;
    task.paused_watch_tracking = null;
    task.completed_watch_tracking = null;
  } else if (prev === 'waiting') {
    task.waiting_since = null;
    task.watch_tracking = null;
    task.cursor_tracking = null;
  }
  if (nextStatus === 'done') {
    task.completed_at = nowIso();
    task.watch_tracking = null;
    task.cursor_tracking = null;
    // Marking the task truly done clears the "agent finished" badge and paused watcher.
    task.watch_finished = null;
    task.paused_watch_tracking = null;
    task.completed_watch_tracking = null;
  } else if (prev === 'done') {
    task.completed_at = null;
  }
}

// An auto-watch completed: send the task back to the list but leave a "finished"
// marker so the UI shows the green "done" state until the user acknowledges it.
function completeWatchTask(task) {
  const wt = task.watch_tracking || task.cursor_tracking || null;
  applyTaskStatusChange(task, 'todo');
  task.watch_tracking = null;
  task.cursor_tracking = null;
  // Retains the watcher in paused_watch_tracking when this was a needs-input stop.
  recordWatchFinished(task, wt);
}

// User chose "Set to done" in the tracking modal — show the green "done" pill without
// crossing out the task (status stays todo).
function manualCompleteWatchTask(task) {
  const wt = task.watch_tracking || task.cursor_tracking || task.paused_watch_tracking || null;
  if (task.status === 'waiting') {
    applyTaskStatusChange(task, 'todo');
  }
  task.watch_tracking = null;
  task.cursor_tracking = null;
  task.paused_watch_tracking = null;
  // Manual acknowledgment always maps to the green done pill, not needs-input.
  const markerWt = wt ? { ...wt, clear_gate: null, clear_reason: null } : null;
  recordWatchFinished(task, markerWt);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function parseCommandList(body, fieldName, legacyFieldName = null) {
  if (hasOwn(body, fieldName)) {
    if (!Array.isArray(body[fieldName])) {
      throw new Error(`${fieldName} must be an array of strings`);
    }
    if (body[fieldName].some((command) => typeof command !== 'string')) {
      throw new Error(`${fieldName} must be an array of strings`);
    }
    return normalizeLaunchCommands(body[fieldName]);
  }

  if (legacyFieldName && hasOwn(body, legacyFieldName)) {
    if (typeof body[legacyFieldName] !== 'string') {
      throw new Error(`${legacyFieldName} must be a string`);
    }
    return normalizeLaunchCommands(body[legacyFieldName]);
  }

  return undefined;
}

function parseLaunchCommands(body) {
  return parseCommandList(body, 'launch_commands', 'launch_command');
}

function parseWorkspaceCommands(body) {
  return parseCommandList(body, 'workspace_commands');
}

function parseWorkspacePayload(body, legacyCommands = []) {
  if (hasOwn(body, 'workspace_items')) {
    const mergedItems = mergeWorkspaceCommands(body.workspace_items, legacyCommands);
    const workspace_items = normalizeWorkspaceItems(mergedItems);
    return { workspace_items, workspace_commands: buildWorkspaceCommands(workspace_items) };
  }
  const workspace_commands = mergeCommandLists(parseWorkspaceCommands(body) || [], legacyCommands);
  return normalizeWorkspaceState(undefined, workspace_commands);
}

function parseFocusPayload(body) {
  if (hasOwn(body, 'focus_items')) {
    const mergedItems = mergeWorkspaceCommands(body.focus_items, parseCommandList(body, 'focus_commands') || []);
    return normalizeWorkspaceState(mergedItems, []);
  }
  const focus_commands = parseCommandList(body, 'focus_commands') || [];
  return normalizeWorkspaceState(undefined, focus_commands);
}

function setTaskFocusState(task, focus) {
  task.focus_items = focus.workspace_items;
  task.focus_commands = focus.workspace_commands;
}

function mergeCommandLists(primary, legacy) {
  const commands = [];
  const seen = new Set();
  for (const command of [...normalizeLaunchCommands(primary), ...normalizeLaunchCommands(legacy)]) {
    if (seen.has(command)) continue;
    seen.add(command);
    commands.push(command);
  }
  return commands;
}

function setProjectLaunchCommands(project, commands) {
  project.launch_commands = commands;
  project.launch_command = commands[0] || '';
}

function normalizeLocalWorkspacePath(rawPath) {
  if (typeof rawPath !== 'string') throw new Error('workspace_path must be a string');
  const trimmed = rawPath.trim();
  if (!trimmed) throw new Error('workspace_path is required');
  const resolved = path.resolve(trimmed);
  if (!path.isAbsolute(resolved)) throw new Error('Local workspace_path must be absolute');
  return resolved;
}

function normalizeRemoteWorkspacePath(rawPath) {
  if (typeof rawPath !== 'string') throw new Error('workspace_path must be a string');
  const trimmed = rawPath.trim();
  if (!trimmed) throw new Error('workspace_path is required');
  if (!trimmed.startsWith('/')) throw new Error('Remote workspace_path must be absolute');
  return path.posix.normalize(trimmed);
}

function normalizeCursorWorkspace(item) {
  if (!item || typeof item !== 'object') {
    throw new Error('Each cursor_workspaces entry must be an object');
  }
  const source = item.source === 'ssh' ? 'ssh' : 'local';
  if (!VALID_WORKSPACE_SOURCES.has(source)) {
    throw new Error('cursor_workspaces source must be "local" or "ssh"');
  }
  const workspace_path =
    source === 'ssh'
      ? normalizeRemoteWorkspacePath(item.workspace_path)
      : normalizeLocalWorkspacePath(item.workspace_path);
  const out = { source, workspace_path };
  if (source === 'ssh' && item.remote_id != null && String(item.remote_id).trim()) {
    out.remote_id = String(item.remote_id).trim();
  }
  return out;
}

function normalizeProjectShape(project) {
  if (!Array.isArray(project.launch_commands)) {
    setProjectLaunchCommands(project, normalizeLaunchCommands(project.launch_command));
  } else {
    setProjectLaunchCommands(project, normalizeLaunchCommands(project.launch_commands));
  }
  if (!Array.isArray(project.workspace_commands)) {
    project.workspace_commands = [];
  } else {
    project.workspace_commands = normalizeLaunchCommands(project.workspace_commands);
  }
  try {
    const rawWorkspaceItems = Array.isArray(project.workspace_items)
      ? mergeWorkspaceCommands(project.workspace_items, project.launch_commands)
      : undefined;
    const rawWorkspaceCommands = Array.isArray(rawWorkspaceItems)
      ? []
      : mergeCommandLists(project.workspace_commands, project.launch_commands);
    const workspace = normalizeWorkspaceState(rawWorkspaceItems, rawWorkspaceCommands);
    project.workspace_items = workspace.workspace_items;
    project.workspace_commands = workspace.workspace_commands;
  } catch {
    const workspace = normalizeWorkspaceState(undefined, mergeCommandLists(project.workspace_commands, project.launch_commands));
    project.workspace_items = workspace.workspace_items;
    project.workspace_commands = workspace.workspace_commands;
  }
  project.is_backlog = !!project.is_backlog;
  normalizeStoredCursorRemotes(project);
  if (!Array.isArray(project.cursor_workspaces)) {
    project.cursor_workspaces = [];
    return;
  }
  const normalizedWorkspaces = [];
  for (const item of project.cursor_workspaces) {
    try {
      normalizedWorkspaces.push(normalizeCursorWorkspace(item));
    } catch {
      // Drop invalid persisted rows.
    }
  }
  project.cursor_workspaces = normalizedWorkspaces;
}

/** Ensure tasks have cursor_tracking for older data.json files. */
function normalizeTaskShape(task) {
  try {
    const rawFocusItems = Array.isArray(task.focus_items)
      ? mergeWorkspaceCommands(task.focus_items, task.focus_commands)
      : undefined;
    const rawFocusCommands = Array.isArray(rawFocusItems) ? [] : task.focus_commands;
    const focus = normalizeWorkspaceState(rawFocusItems, rawFocusCommands);
    setTaskFocusState(task, focus);
  } catch {
    setTaskFocusState(task, normalizeWorkspaceState(undefined, task.focus_commands));
  }
  if (task.watch_tracking === undefined) task.watch_tracking = null;
  if (task.cursor_tracking === undefined) task.cursor_tracking = null;
  if (task.watch_finished === undefined) task.watch_finished = null;
  if (task.paused_watch_tracking === undefined) task.paused_watch_tracking = null;
  if (task.is_task_backlog === undefined) task.is_task_backlog = false;
  task.is_task_backlog = !!task.is_task_backlog;
  task.watch_tracking = normalizeWatchTracking(task.watch_tracking, task.cursor_tracking);
  task.paused_watch_tracking = normalizeWatchTracking(task.paused_watch_tracking, null);
  task.cursor_tracking =
    task.watch_tracking && task.watch_tracking.kind === 'cursor' ? task.watch_tracking : null;
}

function parseBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function getProjectRemoteRows(project) {
  return Array.isArray(project.cursor_remotes) && project.cursor_remotes.length
    ? project.cursor_remotes
    : project.cursor_remote?.host
      ? [project.cursor_remote]
      : [];
}

function tunnelStatusForRemote(remoteHookTunnelManager, remote, localPort = null) {
  const remotePort = Number(remote?.remote_hook_tunnel_port);
  if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort > 65535 || !remote?.host) return null;
  const running = remoteHookTunnelManager.status(remote.host, remotePort);
  return (
    running || {
      host: remote.host,
      local_port: localPort,
      remote_port: remotePort,
      api_base: remote.remote_hook_tunnel_api_base || `http://127.0.0.1:${remotePort}`,
      running: false,
      error: null,
    }
  );
}

function persistRemoteHookTunnel(project, remote, tunnel) {
  const port = Number(tunnel?.remote_port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return;
  const apiBase = tunnel.api_base || `http://127.0.0.1:${port}`;
  const rows = getProjectRemoteRows(project);
  const hit =
    rows.find((r) => remote.id && r.id === remote.id) ||
    rows.find((r) => r.host === remote.host && r.projects_root === remote.projects_root) ||
    rows.find((r) => r.host === remote.host);
  if (hit) {
    hit.remote_hook_tunnel_port = port;
    hit.remote_hook_tunnel_api_base = apiBase;
  }
  if (project.cursor_remote?.host === remote.host) {
    project.cursor_remote.remote_hook_tunnel_port = port;
    project.cursor_remote.remote_hook_tunnel_api_base = apiBase;
  }
}

async function ensureRemoteHookTunnelForInstall(project, remote, remoteHookTunnelManager, localPort) {
  const cfg = assertValidRemoteSource(remote);
  const tunnel = await remoteHookTunnelManager.ensureTunnel({
    host: cfg.host,
    storedRemotePort: remote.remote_hook_tunnel_port,
    preferredRemotePort: preferredRemoteTunnelPort({ localPort }),
  });
  persistRemoteHookTunnel(project, remote, tunnel);
  storage.save();
  return { cfg, tunnel, remoteApiBase: tunnel.api_base };
}

function restorePersistedRemoteHookTunnels(state, remoteHookTunnelManager, localPort) {
  const seen = new Set();
  for (const project of state.projects || []) {
    for (const remote of getProjectRemoteRows(project)) {
      if (!remote?.host || !remote.remote_hook_tunnel_port) continue;
      const key = `${remote.host}\0${remote.remote_hook_tunnel_port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      remoteHookTunnelManager
        .ensureTunnel({
          host: remote.host,
          storedRemotePort: remote.remote_hook_tunnel_port,
          preferredRemotePort: preferredRemoteTunnelPort({ localPort }),
        })
        .catch((err) => {
          console.warn(
            `[remote-hooks] could not restore tunnel for ${remote.host}:${remote.remote_hook_tunnel_port}: ${
              err.message || String(err)
            }`
          );
        });
    }
  }
}

/** Paths from `cursor_workspaces` used to filter terminal process listings by cwd. */
function getProcessListWorkspaceRoots(project, source) {
  const ws = Array.isArray(project?.cursor_workspaces) ? project.cursor_workspaces : [];
  if (source === 'ssh') {
    return ws
      .filter((w) => w && w.source === 'ssh' && typeof w.workspace_path === 'string')
      .map((w) => w.workspace_path.trim())
      .filter(Boolean);
  }
  return ws
    .filter((w) => w && w.source !== 'ssh' && typeof w.workspace_path === 'string')
    .map((w) => w.workspace_path.trim())
    .filter(Boolean);
}

/** Transcript fallback for Claude watches: skips assistant `end_turn` and `tool_use` (see claude_tracker). */
async function shouldCompleteClaudeWatchFromTranscript(ideTracking) {
  if (!ideTracking || ideTracking.provider !== 'claude' || !ideTracking.transcript_path) return false;
  let transcriptPath;
  try {
    transcriptPath = assertAllowedClaudeTranscriptPath(ideTracking.transcript_path);
  } catch {
    return false;
  }
  let raw = '';
  try {
    raw = await fs.promises.readFile(transcriptPath, 'utf8');
  } catch {
    return false;
  }
  return claudeTranscriptWatchCompletionSince(raw, ideTracking.linked_at);
}

function parseCursorRemote(body) {
  if (
    !hasOwn(body, 'cursor_remote_host') &&
    !hasOwn(body, 'cursor_remote_projects_root') &&
    !hasOwn(body, 'cursor_remote')
  ) {
    return undefined;
  }
  if (hasOwn(body, 'cursor_remote') && body.cursor_remote == null) {
    return null;
  }
  if (hasOwn(body, 'cursor_remote') && typeof body.cursor_remote === 'object') {
    return assertValidRemoteSource(body.cursor_remote);
  }
  const host = typeof body.cursor_remote_host === 'string' ? body.cursor_remote_host.trim() : '';
  const root =
    typeof body.cursor_remote_projects_root === 'string' ? body.cursor_remote_projects_root.trim() : '';
  if (!host) return null;
  return assertValidRemoteSource({ host, projects_root: root || undefined });
}

function parseCursorRemotesBody(body) {
  if (!hasOwn(body, 'cursor_remotes')) return undefined;
  if (body.cursor_remotes == null) return [];
  if (!Array.isArray(body.cursor_remotes)) {
    throw new Error('cursor_remotes must be an array');
  }
  return body.cursor_remotes.map((row) => normalizeRemoteRow(row, { generateId: true }));
}

/** Explicit `cursor_remotes` or legacy `cursor_remote` / host fields. */
function parseProjectCursorRemotesFromRequest(body) {
  const explicit = parseCursorRemotesBody(body);
  if (explicit !== undefined) return explicit;
  const legacy = parseCursorRemote(body);
  if (legacy === undefined) return undefined;
  if (legacy === null) return [];
  return [normalizeRemoteRow({ host: legacy.host, projects_root: legacy.projects_root }, { generateId: true })];
}

function preserveRemoteHookTunnelFields(project, nextRows) {
  const current = getProjectRemoteRows(project);
  return (Array.isArray(nextRows) ? nextRows : []).map((row) => {
    const hit =
      current.find((r) => row.id && r.id === row.id) ||
      current.find((r) => r.host === row.host && r.projects_root === row.projects_root) ||
      current.find((r) => r.host === row.host);
    if (!hit) return row;
    const merged = { ...row };
    if (hit.remote_hook_tunnel_port && !merged.remote_hook_tunnel_port) {
      merged.remote_hook_tunnel_port = hit.remote_hook_tunnel_port;
    }
    if (hit.remote_hook_tunnel_api_base && !merged.remote_hook_tunnel_api_base) {
      merged.remote_hook_tunnel_api_base = hit.remote_hook_tunnel_api_base;
    }
    return merged;
  });
}

function parseCursorWorkspaces(body) {
  if (!hasOwn(body, 'cursor_workspaces')) return undefined;
  if (body.cursor_workspaces == null) return [];
  if (!Array.isArray(body.cursor_workspaces)) {
    throw new Error('cursor_workspaces must be an array');
  }
  return body.cursor_workspaces.map((item) => normalizeCursorWorkspace(item));
}

function resolveSshWatchRemote(project, body) {
  const rid = typeof body.remote_id === 'string' ? body.remote_id.trim() : '';
  if (rid) {
    return resolveCursorRemoteEntryStrict(project, rid);
  }
  return assertValidRemoteSource({
    host: body.host || project.cursor_remote?.host,
    projects_root: body.projects_root || project.cursor_remote?.projects_root,
  });
}

function normalizeStateShape() {
  const root = storage.getState();
  if (!root.global_settings || typeof root.global_settings !== 'object') {
    root.global_settings = {};
  }
  for (const project of storage.getState().projects) {
    normalizeProjectShape(project);
    for (const task of project.tasks) {
      normalizeTaskShape(task);
    }
  }
}

const LOCAL_HOOK_SCRIPT_REL = 'hooks/task-app-cursor-hook.sh';
// Research-only capture recorder (scripts/cursor_cli_session.js installs it). The live app
// never needs it, so the installer prunes it to keep ~/.cursor/hooks.json minimal.
const LOCAL_CAPTURE_SCRIPT_REL = 'hooks/capture-hook-payload.sh';
const LOCAL_HOOK_SCRIPT_ABS = path.join(process.env.HOME || '', '.cursor', LOCAL_HOOK_SCRIPT_REL);
const LOCAL_HOOKS_JSON_ABS = path.join(process.env.HOME || '', '.cursor', 'hooks.json');
const CODEX_LOCAL_HOOK_SCRIPT_ABS = path.join(process.env.HOME || '', '.codex', 'hooks', 'task-app-codex-hook.sh');
const CODEX_CONFIG_TOML_ABS = path.join(process.env.HOME || '', '.codex', 'config.toml');
/** Legacy relative command in settings.json before absolute paths. */
const CLAUDE_LOCAL_HOOK_SCRIPT_LEGACY_REL = 'hooks/task-app-claude-hook.sh';
const CLAUDE_LOCAL_HOOK_SCRIPT_ABS = path.join(process.env.HOME || '', '.claude', 'hooks', 'task-app-claude-hook.sh');
const CLAUDE_SETTINGS_JSON_ABS = path.join(process.env.HOME || '', '.claude', 'settings.json');
const GEMINI_LOCAL_HOOK_SCRIPT_ABS = path.join(process.env.HOME || '', '.gemini', 'hooks', 'task-app-gemini-hook.sh');
const GEMINI_AGY_HOOKS_JSON_ABS = path.join(process.env.HOME || '', '.gemini', 'config', 'hooks.json');
const GEMINI_SETTINGS_JSON_ABS = path.join(process.env.HOME || '', '.gemini', 'settings.json');

function getDesiredLocalHookScript() {
  const forwarder = buildHookForwarderBlock({
    envApiBase: 'CURSOR_HOOK_API_BASE',
    envToken: 'CURSOR_HOOK_TOKEN',
    envRemoteHost: 'CURSOR_HOOK_REMOTE_HOST',
    tokenField: 'cursor',
    endpoint: '/api/cursor-hooks/event',
    header: 'X-Cursor-Hook-Token',
    configEndpoint: '/api/cursor-hooks/config',
  });
  return `#!/bin/bash
set +e
payload="$(cat)"

${forwarder}
exit 0
`;
}

function ensureHookCommand(config, eventName) {
  const list = Array.isArray(config.hooks?.[eventName]) ? config.hooks[eventName] : [];
  const exists = list.some((h) => h && h.command === LOCAL_HOOK_SCRIPT_REL);
  if (!exists) list.push({ command: LOCAL_HOOK_SCRIPT_REL });
  config.hooks[eventName] = list;
}

/**
 * Trim ~/.cursor/hooks.json to exactly what the live app needs: the forwarder on the
 * `needed` events only. Drops the research capture recorder everywhere, and drops any
 * Orchestra-managed event NOT in `needed` (the maximal capture-only events the recorder
 * left behind). Third-party hook commands are preserved untouched.
 */
function pruneCursorHooksConfig(config, neededEvents) {
  const needed = new Set(neededEvents);
  for (const [eventName, list] of Object.entries(config.hooks || {})) {
    const arr = Array.isArray(list) ? list : [];
    // Capture recorder is research-only — never part of the live install.
    const withoutCapture = arr.filter((h) => h && h.command !== LOCAL_CAPTURE_SCRIPT_REL);
    if (needed.has(eventName)) {
      config.hooks[eventName] = withoutCapture; // forwarder ensured by ensureHookCommand
      continue;
    }
    // Not a needed event: strip our forwarder too; keep only any third-party commands.
    const thirdParty = withoutCapture.filter((h) => h && h.command !== LOCAL_HOOK_SCRIPT_REL);
    if (thirdParty.length) config.hooks[eventName] = thirdParty;
    else delete config.hooks[eventName];
  }
  return config;
}

function installProfileFromReq(req) {
  return normalizeHookProfile(req.body?.profile || req.query?.profile);
}

function ensureLocalCursorHooksInstalled(options = {}) {
  const profile = normalizeHookProfile(options.profile);
  const hookEvents = getHookEventsForProfile('cursor', profile);
  fs.mkdirSync(path.dirname(LOCAL_HOOK_SCRIPT_ABS), { recursive: true });
  fs.writeFileSync(LOCAL_HOOK_SCRIPT_ABS, getDesiredLocalHookScript(), 'utf8');
  fs.chmodSync(LOCAL_HOOK_SCRIPT_ABS, 0o755);
  const hooksJsonBackup = backupLocalHookConfigFile(LOCAL_HOOKS_JSON_ABS);
  let config = { version: 1, hooks: {} };
  if (hooksJsonBackup) {
    try {
      const raw = fs.readFileSync(hooksJsonBackup, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') config = parsed;
    } catch {
      // malformed file was backed up; start from safe default
    }
  }
  if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {};
  for (const eventName of hookEvents) ensureHookCommand(config, eventName);
  pruneCursorHooksConfig(config, hookEvents);
  fs.mkdirSync(path.dirname(LOCAL_HOOKS_JSON_ABS), { recursive: true });
  fs.writeFileSync(LOCAL_HOOKS_JSON_ABS, JSON.stringify(config, null, 2), 'utf8');
  return {
    hook_script: LOCAL_HOOK_SCRIPT_ABS,
    hooks_json: LOCAL_HOOKS_JSON_ABS,
    hooks_json_backup: hooksJsonBackup,
    profile,
    hook_events: hookEvents,
  };
}

function ensureCodexHookCommand(config, eventName) {
  config.push(
    `[[hooks.${eventName}]]`,
    'matcher = "*"',
    `[[hooks.${eventName}.hooks]]`,
    'type = "command"',
    `command = ${JSON.stringify(CODEX_LOCAL_HOOK_SCRIPT_ABS)}`,
    'timeout = 10',
    `statusMessage = "Orchestra ${eventName}"`,
    ''
  );
}

function codexHookConfigBlock(options = {}) {
  const hookEvents = getHookEventsForProfile('codex', options.profile);
  const lines = [
    '# Orchestra Codex hooks begin',
    '# Managed by Orchestra. These hooks forward lifecycle payloads to the local app.',
  ];
  for (const eventName of hookEvents) ensureCodexHookCommand(lines, eventName);
  lines.push('# Orchestra Codex hooks end');
  return lines.join('\n');
}

function upsertCodexHookConfigBlock(raw, options = {}) {
  const withoutExisting = String(raw || '')
    .replace(/\n?# Orchestra Codex hooks begin\n[\s\S]*?\n# Orchestra Codex hooks end\n?/g, '\n')
    .replace(/\s+$/g, '');
  const prefix = withoutExisting ? `${withoutExisting}\n\n` : '';
  return `${prefix}${codexHookConfigBlock(options)}\n`;
}

function ensureLocalCodexHooksInstalled(options = {}) {
  const profile = normalizeHookProfile(options.profile);
  fs.mkdirSync(path.dirname(CODEX_LOCAL_HOOK_SCRIPT_ABS), { recursive: true });
  fs.writeFileSync(CODEX_LOCAL_HOOK_SCRIPT_ABS, getCodexTaskAppHookScript(), 'utf8');
  fs.chmodSync(CODEX_LOCAL_HOOK_SCRIPT_ABS, 0o755);
  const configTomlBackup = backupLocalHookConfigFile(CODEX_CONFIG_TOML_ABS);
  let raw = '';
  if (configTomlBackup) raw = fs.readFileSync(configTomlBackup, 'utf8');
  fs.mkdirSync(path.dirname(CODEX_CONFIG_TOML_ABS), { recursive: true });
  fs.writeFileSync(CODEX_CONFIG_TOML_ABS, upsertCodexHookConfigBlock(raw, { profile }), 'utf8');
  return {
    hook_script: CODEX_LOCAL_HOOK_SCRIPT_ABS,
    config_toml: CODEX_CONFIG_TOML_ABS,
    config_toml_backup: configTomlBackup,
    profile,
    hook_events: getHookEventsForProfile('codex', profile),
  };
}

function migrateClaudeSettingsTaskAppHookPaths(node, absCommandPath) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) migrateClaudeSettingsTaskAppHookPaths(item, absCommandPath);
    return;
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (k === 'command' && v === CLAUDE_LOCAL_HOOK_SCRIPT_LEGACY_REL) {
      node[k] = absCommandPath;
    } else if (v && typeof v === 'object') {
      migrateClaudeSettingsTaskAppHookPaths(v, absCommandPath);
    }
  }
}

function ensureClaudeHookCommand(settings, eventName) {
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const list = Array.isArray(hooks[eventName]) ? hooks[eventName] : [];
  const hasScript = list.some(
    (entry) =>
      entry &&
      Array.isArray(entry.hooks) &&
      entry.hooks.some(
        (hook) =>
          hook &&
          hook.type === 'command' &&
          (hook.command === CLAUDE_LOCAL_HOOK_SCRIPT_ABS || hook.command === CLAUDE_LOCAL_HOOK_SCRIPT_LEGACY_REL)
      )
  );
  if (!hasScript) {
    list.push({
      hooks: [
        {
          type: 'command',
          command: CLAUDE_LOCAL_HOOK_SCRIPT_ABS,
          timeout: 10,
        },
      ],
    });
  }
  hooks[eventName] = list;
  settings.hooks = hooks;
}

function ensureLocalClaudeHooksInstalled(options = {}) {
  const profile = normalizeHookProfile(options.profile);
  const hookEvents = getHookEventsForProfile('claude', profile);
  fs.mkdirSync(path.dirname(CLAUDE_LOCAL_HOOK_SCRIPT_ABS), { recursive: true });
  fs.writeFileSync(CLAUDE_LOCAL_HOOK_SCRIPT_ABS, getClaudeTaskAppHookScript(), 'utf8');
  fs.chmodSync(CLAUDE_LOCAL_HOOK_SCRIPT_ABS, 0o755);
  const settingsBackup = backupLocalHookConfigFile(CLAUDE_SETTINGS_JSON_ABS);
  let settings = {};
  if (settingsBackup) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsBackup, 'utf8'));
      if (!settings || typeof settings !== 'object') settings = {};
    } catch {
      settings = {};
    }
  }
  migrateClaudeSettingsTaskAppHookPaths(settings, CLAUDE_LOCAL_HOOK_SCRIPT_ABS);
  for (const eventName of hookEvents) ensureClaudeHookCommand(settings, eventName);
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_JSON_ABS), { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS_JSON_ABS, JSON.stringify(settings, null, 2), 'utf8');
  return {
    hook_script: CLAUDE_LOCAL_HOOK_SCRIPT_ABS,
    settings_json: CLAUDE_SETTINGS_JSON_ABS,
    settings_backup: settingsBackup,
    profile,
    hook_events: hookEvents,
  };
}

function ensureGeminiHookCommand(settings, eventName) {
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const list = Array.isArray(hooks[eventName]) ? hooks[eventName] : [];
  const hasScript = list.some(
    (entry) =>
      entry &&
      Array.isArray(entry.hooks) &&
      entry.hooks.some(
        (hook) =>
          hook &&
          hook.type === 'command' &&
          hook.command === GEMINI_LOCAL_HOOK_SCRIPT_ABS
      )
  );
  if (!hasScript) {
    list.push({
      matcher: '*',
      hooks: [
        {
          name: `task-app-${eventName.toLowerCase()}`,
          type: 'command',
          command: GEMINI_LOCAL_HOOK_SCRIPT_ABS,
        },
      ],
    });
  }
  hooks[eventName] = list;
  settings.hooks = hooks;
}

const AGY_TOOL_HOOK_EVENTS = ['PreToolUse', 'PostToolUse'];

function stripAgyHookCommandFromEventList(list, command) {
  const items = Array.isArray(list) ? list : [];
  const next = [];
  for (const entry of items) {
    if (!entry || typeof entry !== 'object') {
      next.push(entry);
      continue;
    }
    if (entry.type === 'command' && entry.command === command) continue;
    if (!Array.isArray(entry.hooks)) {
      next.push(entry);
      continue;
    }
    const keptHooks = entry.hooks.filter(
      (hook) => !(hook && hook.type === 'command' && hook.command === command)
    );
    if (keptHooks.length > 0) next.push({ ...entry, hooks: keptHooks });
  }
  return next;
}

function ensureAgyLifecycleDirectHook(settings, eventName) {
  const command = `${GEMINI_LOCAL_HOOK_SCRIPT_ABS} ${eventName}`;
  const list = Array.isArray(settings[eventName]) ? settings[eventName] : [];
  const hasScript = list.some(
    (entry) => entry && entry.type === 'command' && entry.command === command
  );
  if (!hasScript) {
    list.push({
      type: 'command',
      command,
    });
  }
  settings[eventName] = list;
}

function ensureAgyToolMatcherHook(settings, eventName) {
  const hooks = settings && typeof settings === 'object' ? settings : {};
  const list = Array.isArray(hooks[eventName]) ? hooks[eventName] : [];
  const command = `${GEMINI_LOCAL_HOOK_SCRIPT_ABS} ${eventName}`;
  const hasScript = list.some(
    (entry) =>
      entry &&
      Array.isArray(entry.hooks) &&
      entry.hooks.some((hook) => hook && hook.type === 'command' && hook.command === command)
  );
  if (!hasScript) {
    list.push({
      matcher: '*',
      hooks: [
        {
          name: `task-app-${eventName.toLowerCase()}`,
          type: 'command',
          command,
        },
      ],
    });
  }
  hooks[eventName] = list;
}

function removeGeminiHookCommand(settings, eventName) {
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const list = Array.isArray(hooks[eventName]) ? hooks[eventName] : [];
  const next = [];
  for (const entry of list) {
    if (!entry || !Array.isArray(entry.hooks)) {
      next.push(entry);
      continue;
    }
    const keptHooks = entry.hooks.filter(
      (hook) => !(hook && hook.type === 'command' && hook.command === GEMINI_LOCAL_HOOK_SCRIPT_ABS)
    );
    if (keptHooks.length > 0) next.push({ ...entry, hooks: keptHooks });
  }
  if (next.length > 0) hooks[eventName] = next;
  else delete hooks[eventName];
  settings.hooks = hooks;
}

function ensureLocalGeminiHooksInstalled(options = {}) {
  const profile = normalizeHookProfile(options.profile);
  const hookEvents = getHookEventsForProfile('gemini', profile);
  const lifecycleEvents = hookEvents.filter((eventName) => !AGY_TOOL_HOOK_EVENTS.includes(eventName));
  const toolEvents = hookEvents.filter((eventName) => AGY_TOOL_HOOK_EVENTS.includes(eventName));
  fs.mkdirSync(path.dirname(GEMINI_LOCAL_HOOK_SCRIPT_ABS), { recursive: true });
  fs.writeFileSync(GEMINI_LOCAL_HOOK_SCRIPT_ABS, getGeminiTaskAppHookScript(), 'utf8');
  fs.chmodSync(GEMINI_LOCAL_HOOK_SCRIPT_ABS, 0o755);

  const agyHooksBackup = backupLocalHookConfigFile(GEMINI_AGY_HOOKS_JSON_ABS);
  let agyHooks = {};
  if (agyHooksBackup) {
    try {
      agyHooks = JSON.parse(fs.readFileSync(agyHooksBackup, 'utf8'));
      if (!agyHooks || typeof agyHooks !== 'object') agyHooks = {};
    } catch {
      agyHooks = {};
    }
  }
  if (!agyHooks.hooks || typeof agyHooks.hooks !== 'object') {
    agyHooks.hooks = {};
  }
  if (!agyHooks['task-app-hooks'] || typeof agyHooks['task-app-hooks'] !== 'object') {
    agyHooks['task-app-hooks'] = {};
  }
  agyHooks['task-app-hooks'].enabled = true;

  for (const eventName of lifecycleEvents) {
    const command = `${GEMINI_LOCAL_HOOK_SCRIPT_ABS} ${eventName}`;
    ensureAgyLifecycleDirectHook(agyHooks['task-app-hooks'], eventName);
    agyHooks.hooks[eventName] = stripAgyHookCommandFromEventList(agyHooks.hooks[eventName], command);
    if (Array.isArray(agyHooks.hooks[eventName]) && agyHooks.hooks[eventName].length === 0) {
      delete agyHooks.hooks[eventName];
    }
  }
  for (const eventName of toolEvents) {
    const command = `${GEMINI_LOCAL_HOOK_SCRIPT_ABS} ${eventName}`;
    ensureAgyToolMatcherHook(agyHooks.hooks, eventName);
    agyHooks['task-app-hooks'][eventName] = stripAgyHookCommandFromEventList(
      agyHooks['task-app-hooks'][eventName],
      command
    );
    if (
      Array.isArray(agyHooks['task-app-hooks'][eventName]) &&
      agyHooks['task-app-hooks'][eventName].length === 0
    ) {
      delete agyHooks['task-app-hooks'][eventName];
    }
  }
  fs.mkdirSync(path.dirname(GEMINI_AGY_HOOKS_JSON_ABS), { recursive: true });
  fs.writeFileSync(GEMINI_AGY_HOOKS_JSON_ABS, JSON.stringify(agyHooks, null, 2), 'utf8');

  const settingsBackup = backupLocalHookConfigFile(GEMINI_SETTINGS_JSON_ABS);
  let settings = {};
  if (settingsBackup) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsBackup, 'utf8'));
      if (!settings || typeof settings !== 'object') settings = {};
    } catch {
      settings = {};
    }
  }
  removeGeminiHookCommand(settings, 'BeforeAgent');
  removeGeminiHookCommand(settings, 'AfterAgent');
  removeGeminiHookCommand(settings, 'Notification');
  removeGeminiHookCommand(settings, 'BeforeTool');
  removeGeminiHookCommand(settings, 'BeforeModel');
  removeGeminiHookCommand(settings, 'AfterModel');
  removeGeminiHookCommand(settings, 'SessionStart');
  removeGeminiHookCommand(settings, 'SessionEnd');
  fs.mkdirSync(path.dirname(GEMINI_SETTINGS_JSON_ABS), { recursive: true });
  fs.writeFileSync(GEMINI_SETTINGS_JSON_ABS, JSON.stringify(settings, null, 2), 'utf8');
  return {
    hook_script: GEMINI_LOCAL_HOOK_SCRIPT_ABS,
    agy_hooks_json: GEMINI_AGY_HOOKS_JSON_ABS,
    agy_hooks_backup: agyHooksBackup,
    settings_json: GEMINI_SETTINGS_JSON_ABS,
    settings_backup: settingsBackup,
    profile,
    hook_events: hookEvents,
  };
}

function applyGeminiHookCompletion(getState, onEachTask, snapshot, options = {}) {
  if (!snapshot) return 0;
  const isAfterAgent =
    snapshot.event_name === 'AfterAgent' &&
    snapshot.generating === false &&
    snapshot.event_source_kind !== 'scan' &&
    snapshot.source_kind !== 'scan';
  const isAgyDone =
    snapshot.event_name === 'Stop' &&
    snapshot.completion_hint === true &&
    snapshot.generating === false &&
    snapshot.event_source_kind !== 'scan' &&
    snapshot.source_kind !== 'scan';
  const isAgyCancel = snapshot.cancel_hint === true;
  const isPermissionPending =
    (snapshot.event_name === 'Notification' && snapshot.notification_type === 'ToolPermission') ||
    snapshot.permission_pending === true;
  const isQuestionPending = snapshot.question_pending === true;
  const permissionResolvedMs = Date.parse(snapshot.permission_resolved_at || '') || 0;
  const questionResolvedMs = Date.parse(snapshot.question_resolved_at || '') || 0;
  const isPermissionResolved = permissionResolvedMs && snapshot.permission_pending !== true;
  const isQuestionResolved = questionResolvedMs && snapshot.question_pending !== true;
  const isGateResolution = isPermissionResolved || isQuestionResolved;
  if (
    !isAfterAgent &&
    !isAgyDone &&
    !isAgyCancel &&
    !isPermissionPending &&
    !isQuestionPending &&
    !isGateResolution
  ) return 0;
  const clearReason = isQuestionPending
    ? 'question_pending'
    : isPermissionPending
      ? 'permission_pending'
      : isAgyCancel
        ? 'cancel'
        : 'completion';
  const gate = clearReason === 'question_pending' ? 'question' : clearReason === 'permission_pending' ? 'permission' : '';
  const resolvedGate = isQuestionResolved ? 'question' : isPermissionResolved ? 'permission' : '';
  let completedCount = 0;
  const targetTranscript = typeof snapshot.transcript_path === 'string' ? snapshot.transcript_path : '';
  const targetSessionId = normalizeSessionId(snapshot.session_id);
  const targetHost =
    (typeof snapshot.remote_host === 'string' && snapshot.remote_host.trim()) ||
    (typeof snapshot.host === 'string' && snapshot.host.trim()) ||
    '';
  const snapMs = Date.parse(snapshot.updated_at || '') || 0;
  for (const project of getState().projects || []) {
    for (const task of project.tasks || []) {
      if (task.status === 'todo' && task.watch_finished?.needs_input && task.paused_watch_tracking && !gate) {
        const pausedWt = normalizeWatchTracking(task.paused_watch_tracking, null);
        const pausedAtMs = Date.parse(task.watch_finished.paused_at || pausedWt?.clear_signal_at || '') || 0;
        if (pausedWt?.kind === 'ide_agent' && (pausedWt.provider === 'gemini' || pausedWt.provider === 'gemini_cli')) {
          const watchHost = typeof pausedWt.host === 'string' ? pausedWt.host.trim() : '';
          if (!targetHost || !watchHost || targetHost === watchHost) {
            const watchTranscript = typeof pausedWt.transcript_path === 'string' ? pausedWt.transcript_path : '';
            const watchSessionId = normalizeSessionId(pausedWt.session_id);
            const transcriptMatch = targetTranscript && watchTranscript && targetTranscript === watchTranscript;
            const sessionMatch = targetSessionId && watchSessionId && targetSessionId === watchSessionId;
            let subAgentMatch = false;
            if (targetSessionId && typeof options.subAgentIds === 'function') {
              try {
                const ids = options.subAgentIds(pausedWt) || [];
                subAgentMatch = ids.some((id) => normalizeSessionId(id) === targetSessionId);
              } catch {
                subAgentMatch = false;
              }
            }
            const resolvedAtMs = resolvedGate === 'question' ? questionResolvedMs : permissionResolvedMs;
            if (
              isGateResolution &&
              pausedWt.clear_gate === resolvedGate &&
              (transcriptMatch || sessionMatch || subAgentMatch) &&
              (!pausedAtMs || !resolvedAtMs || resolvedAtMs > pausedAtMs)
            ) {
              if (typeof options.resumeTask === 'function') {
                options.resumeTask(task, pausedWt);
              } else if (typeof onEachTask === 'function') {
                resumeWatchTracking(task, pausedWt, (t, status) => {
                  t.status = status;
                });
              }
              completedCount += 1;
              continue;
            }
            // Sub-agent match only counts for a cancel here: a child's *done* is not the parent's
            // done (cascade), but a child's *cancel* tears down the whole run including the parent.
            if (
              !isGateResolution &&
              (transcriptMatch || sessionMatch || (isAgyCancel && subAgentMatch)) &&
              (!pausedAtMs || !snapMs || snapMs > pausedAtMs)
            ) {
              const markerWt = { ...pausedWt };
              markerWt.clear_gate = null;
              markerWt.clear_reason = null;
              markerWt.clear_signal_at = null;
              markerWt.clear_event_name = '';
              if (isAgyCancel) markCancelledWatchClear(markerWt);
              task.last_watch_clear = null;
              recordWatchFinished(task, markerWt);
              completedCount += 1;
            }
          }
        }
        continue;
      }
      if (task.status !== 'waiting') continue;
      if (isGateResolution) continue;
      const wt = task.watch_tracking;
      if (!wt || wt.kind !== 'ide_agent' || (wt.provider !== 'gemini' && wt.provider !== 'gemini_cli')) continue;
      const linkedAtMs = Date.parse(wt.linked_at || '') || 0;
      if (linkedAtMs && snapMs && snapMs <= linkedAtMs) continue;
      const watchHost = typeof wt.host === 'string' ? wt.host.trim() : '';
      if (targetHost && watchHost && targetHost !== watchHost) continue;
      const watchTranscript = typeof wt.transcript_path === 'string' ? wt.transcript_path : '';
      const watchSessionId = normalizeSessionId(wt.session_id);
      const transcriptMatch = targetTranscript && watchTranscript && targetTranscript === watchTranscript;
      const sessionMatch = targetSessionId && watchSessionId && targetSessionId === watchSessionId;
      let subAgentMatch = false;
      // A cancel snapshot carries the cancelled child's conversationId; cancelling a sub-agent
      // tears down the whole run, so map it back to the tracked parent (as the gate paths do).
      if ((gate || isAgyCancel) && targetSessionId && typeof options.subAgentIds === 'function') {
        try {
          const ids = options.subAgentIds(wt) || [];
          subAgentMatch = ids.some((id) => normalizeSessionId(id) === targetSessionId);
        } catch {
          subAgentMatch = false;
        }
      }
      if (!transcriptMatch && !sessionMatch && !subAgentMatch) continue;
      if (isAgyCancel) {
        // Cancelled turn → clears straight back to monitor (no done / needs-input).
        markCancelledWatchClear(wt);
      } else if (gate) {
        // Carry the gate on the watcher so completeWatchTask/finishedMarker flags needs_input.
        wt.clear_gate = gate;
        wt.clear_reason = clearReason;
        task.last_watch_clear = {
          kind: 'ide_agent',
          provider: 'gemini',
          source: wt.source === 'ssh' ? 'ssh' : 'local',
          host: watchHost || targetHost || '',
          session_id: watchSessionId || targetSessionId || '',
          transcript_path: watchTranscript || targetTranscript || '',
          reason: clearReason,
          gate,
          event_name: snapshot.event_name || '',
          signal_at: snapshot.updated_at || '',
          cleared_at: nowIso(),
        };
      }
      onEachTask(task);
      completedCount += 1;
    }
  }
  return completedCount;
}

function shouldDeferGeminiCancelForPendingGate(options = {}) {
  if (options.overridePendingGate) return false;
  const sid = normalizeSessionId(options.conversationId || options.session_id || '');
  if (!sid) return false;
  const remoteHost = typeof options.remoteHost === 'string' ? options.remoteHost.trim() : '';
  const snapshots = Array.isArray(options.snapshots) ? options.snapshots : [];
  for (const snap of snapshots) {
    if (!snap || normalizeSessionId(snap.session_id) !== sid) continue;
    const snapHost =
      (typeof snap.remote_host === 'string' && snap.remote_host.trim()) ||
      (typeof snap.host === 'string' && snap.host.trim()) ||
      '';
    if (remoteHost) {
      if (snapHost !== remoteHost) continue;
    } else if (snapHost) {
      continue;
    }
    if (snap.permission_pending) return true;
    if (snap.event_name === 'Notification' && snap.notification_type === 'ToolPermission') return true;
    if (snap.agy_pending_pre_tool_step != null) return true;
    if (snap.question_pending) return true;
  }
  return !remoteHost && !!options.appHasPendingPermission;
}

async function completeGeminiPermissionWatchIfPending(task, options = {}) {
  const wt = task.watch_tracking;
  if (!wt || task.status !== 'waiting') return 0;
  if (wt.provider !== 'gemini' && wt.provider !== 'gemini_cli') return 0;
  const subAgentIds =
    typeof options.subAgentIds === 'function'
      ? (() => {
          try {
            return options.subAgentIds(wt) || [];
          } catch {
            return [];
          }
        })()
      : [];
  let snap = geminiHookStore.getPermissionPendingHintForTracking(wt, { subAgentIds });
  if (!snap && wt.session_id) {
    const pending =
      wt.source === 'ssh'
        ? false
        : (await agyCliSessionHasPendingPermission(wt.session_id)) ||
          (await agyAppSessionHasPendingPermission(wt.session_id));
    if (pending) {
      const body = agyAppSignalToGeminiHookBody({
        kind: 'permission_requested',
        conversationId: wt.session_id,
      });
      const result = body ? geminiHookStore.ingestEvent(body) : null;
      snap = result?.snapshot || null;
    }
  }
  if (!snap) return 0;
  const completed = applyGeminiHookCompletion(
    () => storage.getState(),
    (t) => {
      completeWatchTask(t);
    },
    snap,
    options
  );
  if (completed > 0) await storage.save();
  return completed;
}

async function refreshGeminiSubAgentCacheForHost(host, runSsh, options = {}) {
  const targetHost = typeof host === 'string' ? host.trim() : '';
  if (!targetHost || typeof runSsh !== 'function') return;
  const refreshes = [];
  for (const project of storage.getState().projects || []) {
    for (const task of project.tasks || []) {
      const candidates = [task.watch_tracking, task.cursor_tracking, task.paused_watch_tracking];
      for (const raw of candidates) {
        const wt = normalizeWatchTracking(raw, null);
        if (
          wt &&
          wt.kind === 'ide_agent' &&
          (wt.provider === 'gemini' || wt.provider === 'gemini_cli') &&
          wt.source === 'ssh' &&
          wt.host === targetHost &&
          wt.transcript_path
        ) {
          refreshes.push(geminiSubAgentIds.refresh(wt, runSsh, options));
        }
      }
    }
  }
  await Promise.all(refreshes);
}

function buildApp(port = DEFAULT_PORT, options = {}) {
  const remoteHookTunnelManager =
    options.remoteHookTunnelManager ||
    createRemoteHookTunnelManager({
      localPort: port,
    });
  const remoteHookInstallers = {
    cursor: ensureRemoteCursorHooks,
    codex: ensureRemoteCodexHooks,
    claude: ensureRemoteClaudeHooks,
    gemini: ensureRemoteGeminiHooks,
    ...(options.remoteHookInstallers || {}),
  };
  const app = express();
  const runSsh = createSshRunner();
  const browserChatStore = createBrowserChatStore({
    token:
      process.env.BROWSER_CHAT_TOKEN && String(process.env.BROWSER_CHAT_TOKEN).trim()
        ? String(process.env.BROWSER_CHAT_TOKEN).trim()
        : undefined,
  });
  app.use(express.json({ limit: '1mb' }));
  // API routes must be registered before express.static so paths like /api/cursor/runs
  // are never mistaken for static files (which would return HTML and break JSON clients).

  app.use((req, res, next) => {
    if (CONFIG_PATHS.has(req.path)) return requireAppTokenWhenExposed(req, res, next);
    const method = req.method && req.method.toUpperCase();
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      if (!routeHasDedicatedTokenAuth(req.path)) return requireAppTokenWhenExposed(req, res, next);
    }
    return next();
  });

  app.get('/api/state', (req, res) => {
    normalizeStateShape();
    res.json(storage.getState());
  });

  app.get('/api/cursor/runs', async (req, res) => {
    try {
      const runs = await discoverCursorRuns();
      res.json({ runs });
    } catch (err) {
      console.error('[server] /api/cursor/runs:', err);
      res.status(500).json({ error: err.message || 'Failed to list Cursor runs' });
    }
  });

  app.get('/api/projects/:id/cursor-runs', async (req, res) => {
    const project = findProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    try {
      const runs = cursorHookStore.listRunsForProject(project, {
        activeOnly: parseBool(req.query.active_only),
      });
      res.json({ runs });
    } catch (err) {
      console.error('[server] /api/projects/:id/cursor-runs:', err);
      res.status(500).json({ error: err.message || 'Failed to list Cursor runs' });
    }
  });

  app.get('/api/projects/:id/ide-agent-runs', async (req, res) => {
    const project = findProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const provider = typeof req.query.provider === 'string' ? req.query.provider.trim().toLowerCase() : '';
    const source = req.query.source === 'ssh' ? 'ssh' : 'local';
    if (
      provider !== 'codex' &&
      provider !== 'claude' &&
      provider !== 'claude_cowork' &&
      provider !== 'gemini'
    ) {
      return res.status(400).json({ error: 'provider must be codex, claude, claude_cowork, or gemini' });
    }
    if (provider === 'claude_cowork' && source === 'ssh') {
      return res.status(400).json({ error: 'Claude Cowork watching is local only' });
    }
    try {
      let runs;
      const activeOnly = parseBool(req.query.active_only);
      const localWorkspaces = (project.cursor_workspaces || [])
        .filter((item) => item && item.source === 'local' && typeof item.workspace_path === 'string')
        .map((item) => item.workspace_path.trim())
        .filter(Boolean);
      if (provider === 'codex') {
        const codexResult = await listCodexRunsFromHookStore(project, source);
        if (codexResult.error) {
          return res.status(400).json({ error: codexResult.error });
        }
        runs = codexResult.runs;
      } else if (provider === 'claude') {
        const claudeResult = await listClaudeRunsFromHookStore(project, source);
        if (claudeResult.error) {
          return res.status(400).json({ error: claudeResult.error });
        }
        runs = claudeResult.runs;
      } else if (provider === 'gemini') {
        const geminiResult = await listGeminiRunsFromHookStore(project, source);
        if (geminiResult.error) {
          return res.status(400).json({ error: geminiResult.error });
        }
        runs = geminiResult.runs;
      } else {
        if (provider === 'claude_cowork') runs = await discoverClaudeCoworkRuns();
      }
      if (activeOnly) {
        runs = (runs || []).filter((run) => run && run.generating === true);
      }
      res.json({ runs });
    } catch (err) {
      console.error('[server] /api/projects/:id/ide-agent-runs:', err);
      res.status(500).json({ error: err.message || 'Failed to list ide agent runs' });
    }
  });

  app.get('/api/cursor-hooks/config', (req, res) => {
    const host = req.get('host') || `${HOST}:${DEFAULT_PORT}`;
    res.json({
      token: cursorHookStore.getToken(),
      apiBase: `http://${host}`,
    });
  });

  app.get('/api/cursor-hooks/status', (req, res) => {
    const localInstalled = fs.existsSync(LOCAL_HOOK_SCRIPT_ABS) && fs.existsSync(LOCAL_HOOKS_JSON_ABS);
    const projectId = typeof req.query.project_id === 'string' ? req.query.project_id : '';
    const project = projectId ? findProject(projectId) : null;
    let remote = null;
    const remotes = [];
    if (project && getProjectRemoteRows(project).length) {
      for (const r of getProjectRemoteRows(project)) {
        if (!r?.host) continue;
        remotes.push({
          id: r.id,
          host: r.host,
          projects_root: r.projects_root,
          script_path: REMOTE_HOOK_SCRIPT_PATH,
          hooks_json_path: REMOTE_HOOKS_JSON_PATH,
          log_path: REMOTE_HOOK_LOG_PATH,
          tunnel: tunnelStatusForRemote(remoteHookTunnelManager, r, port),
        });
      }
      remote = remotes[0] || null;
    }
    res.json({ local: { installed: localInstalled }, remote, remotes });
  });

  app.post('/api/cursor-hooks/install-local', (req, res) => {
    try {
      const out = ensureLocalCursorHooksInstalled({ profile: installProfileFromReq(req) });
      res.json({ ok: true, ...out });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Failed to install local hooks' });
    }
  });

  app.post('/api/projects/:id/cursor-hooks/install-remote', async (req, res) => {
    const project = findProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const toInstall = getProjectRemoteRows(project);
    if (!toInstall.length) return res.status(400).json({ error: 'Project has no remote watch host configured' });
    const token = cursorHookStore.getToken();
    const profile = installProfileFromReq(req);
    const results = [];
    for (const r of toInstall) {
      try {
        const { cfg, tunnel, remoteApiBase } = await ensureRemoteHookTunnelForInstall(
          project,
          r,
          remoteHookTunnelManager,
          port
        );
        const out = await remoteHookInstallers.cursor(cfg, { token, profile, remoteApiBase });
        results.push({ host: cfg.host, ok: true, tunnel, ...out });
      } catch (err) {
        results.push({ host: r.host, ok: false, error: err.message || String(err) });
      }
    }
    const ok = results.every((r) => r.ok);
    res.json({ ok, results, log_path: REMOTE_HOOK_LOG_PATH });
  });

  app.post('/api/cursor-hooks/test', (req, res) => {
    const now = Date.now();
    const sample = {
      event_name: 'beforeSubmitPrompt',
      conversation_id: `test-${now}`,
      prompt_preview: 'orchestra hook test event',
      transcript_path: '',
      workspace_roots: [process.cwd()],
      source: 'local',
    };
    const result = cursorHookStore.ingestEvent(sample);
    if (!result.ok) return res.status(500).json({ error: result.error || 'Hook test failed' });
    res.json({ ok: true, snapshot: result.snapshot });
  });

  app.post('/api/cursor-hooks/event', (req, res) => {
    if (!cursorHookStore.verifyToken(req)) {
      return res.status(401).json({ error: 'Invalid or missing cursor hook token' });
    }
    const body = req.body || {};
    hookEventLog.push('cursor', body);
    // cursor-CLI permission inference: feed tool-call hooks (preToolUse/postToolUse/…) to the
    // config-eval tracker. CLI-only (IDE uses its own permission probes). These events are not
    // lifecycle events for cursorHookStore, so they'd be rejected below — the tracker is the
    // consumer and we ack them.
    if (isCursorCliHook(body)) {
      try {
        cursorCliPermissionTracker.ingest(body);
      } catch (err) {
        console.error('[server] cursor-cli permission ingest:', err.message);
      }
    }
    const result = cursorHookStore.ingestEvent(body);
    if (!result.ok) {
      // Tool-call / non-lifecycle hooks (preToolUse, postToolUse, …) are consumed by the
      // permission tracker above; ack them so the forwarder doesn't see a 4xx.
      return res.json({ ok: true, ignored: result.error });
    }
    const eventName = body.event_name || body.hook_event_name || '';
    const isStart = eventName === 'beforeSubmitPrompt' || eventName === 'sessionStart';
    let resumed = 0;
    if (isStart && result.snapshot?.generating) {
      resumed = applyCursorHookResume(
        () => storage.getState(),
        (task, wt) => {
          resumeWatchTracking(task, wt, (t, status) => { t.status = status; });
        },
        result.snapshot
      );
    }
    const activated = applyCursorSubagentWatchOnSpawn(() => storage.getState(), body);
    const completed = applyCursorHookCompletion(
      () => storage.getState(),
      (task) => {
        completeWatchTask(task);
      },
      result.snapshot
    );
    if (resumed > 0 || activated > 0 || completed > 0) storage.save();
    return res.json({ ok: true, completed, activated, resumed, snapshot: result.snapshot });
  });

  app.get('/api/cursor-hooks/snapshots', (req, res) => {
    if (!cursorHookStore.verifyToken(req)) {
      return res.status(401).json({ error: 'Invalid or missing cursor hook token' });
    }
    res.json({ ok: true, snapshots: cursorHookStore.listSnapshots() });
  });

  // Raw-hook tap (exact /event bodies) for signal recording. Token-guarded.
  app.get('/api/cursor-hooks/raw-events', (req, res) => {
    if (!cursorHookStore.verifyToken(req)) {
      return res.status(401).json({ error: 'Invalid or missing cursor hook token' });
    }
    res.json({ ok: true, events: hookEventLog.since('cursor', req.query.since) });
  });

  app.get('/api/codex-hooks/config', (req, res) => {
    const host = req.get('host') || `${HOST}:${DEFAULT_PORT}`;
    res.json({
      token: codexHookStore.getToken(),
      apiBase: `http://${host}`,
    });
  });

  app.get('/api/codex-hooks/status', (req, res) => {
    const localInstalled = fs.existsSync(CODEX_LOCAL_HOOK_SCRIPT_ABS) && fs.existsSync(CODEX_CONFIG_TOML_ABS);
    const projectId = typeof req.query.project_id === 'string' ? req.query.project_id : '';
    const project = projectId ? findProject(projectId) : null;
    const remotes = [];
    if (project) {
      for (const r of getProjectRemoteRows(project)) {
        if (!r?.host) continue;
        remotes.push({
          id: r.id,
          host: r.host,
          projects_root: r.projects_root,
          tunnel: tunnelStatusForRemote(remoteHookTunnelManager, r, port),
        });
      }
    }
    res.json({
      local: {
        installed: localInstalled,
        hook_script: CODEX_LOCAL_HOOK_SCRIPT_ABS,
        config_toml: CODEX_CONFIG_TOML_ABS,
      },
      remote: remotes[0] || null,
      remotes,
    });
  });

  app.get('/api/codex-hooks/snapshots', (req, res) => {
    if (!codexHookStore.verifyToken(req)) {
      return res.status(401).json({ error: 'Invalid or missing codex hook token' });
    }
    res.json({ ok: true, snapshots: codexHookStore.listSnapshots() });
  });

  app.get('/api/codex-hooks/raw-events', (req, res) => {
    if (!codexHookStore.verifyToken(req)) {
      return res.status(401).json({ error: 'Invalid or missing codex hook token' });
    }
    res.json({ ok: true, events: hookEventLog.since('codex', req.query.since) });
  });

  app.post('/api/codex-hooks/install-local', (req, res) => {
    try {
      const out = ensureLocalCodexHooksInstalled({ profile: installProfileFromReq(req) });
      res.json({ ok: true, ...out });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Failed to install local Codex hooks' });
    }
  });

  app.post('/api/projects/:id/codex-hooks/install-remote', async (req, res) => {
    const project = findProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const toInstall = getProjectRemoteRows(project);
    if (!toInstall.length) {
      return res.status(400).json({ error: 'Project has no remote watch host configured' });
    }
    const profile = installProfileFromReq(req);
    const results = [];
    for (const r of toInstall) {
      try {
        const { cfg, tunnel, remoteApiBase } = await ensureRemoteHookTunnelForInstall(
          project,
          r,
          remoteHookTunnelManager,
          port
        );
        const out = await remoteHookInstallers.codex(cfg, {
          getCodexHookScript: () => getCodexTaskAppHookScript(),
          remoteApiBase,
          token: codexHookStore.getToken(),
          profile,
        });
        results.push({ host: cfg.host, ok: true, tunnel, ...out });
      } catch (err) {
        results.push({ host: r.host, ok: false, error: err.message || String(err) });
      }
    }
    const ok = results.every((x) => x.ok);
    res.json({ ok, results });
  });

  app.post('/api/codex-hooks/test', (req, res) => {
    const now = Date.now();
    const sample = {
      hook_event_name: 'UserPromptSubmit',
      session_id: `codex-test-${now}`,
      turn_id: `turn-${now}`,
      prompt: 'orchestra codex hook test event',
      cwd: process.cwd(),
      model: 'test-model',
      permission_mode: 'test',
    };
    const result = codexHookStore.ingestEvent(sample);
    if (!result.ok) return res.status(500).json({ error: result.error || 'Codex hook test failed' });
    res.json({ ok: true, snapshot: result.snapshot });
  });

  app.post('/api/codex-hooks/event', (req, res) => {
    if (!codexHookStore.verifyToken(req)) {
      return res.status(401).json({ error: 'Invalid or missing codex hook token' });
    }
    const body = req.body || {};
    hookEventLog.push('codex', body);
    const result = codexHookStore.ingestEvent(body);
    if (!result.ok) return res.status(400).json({ error: result.error });
    const eventName = body.event_name || body.hook_event_name || '';
    const isStart = eventName === 'UserPromptSubmit' || eventName === 'SessionStart';
    let resumed = 0;
    if (isStart && result.snapshot?.generating) {
      resumed = applyCodexHookResume(
        () => storage.getState(),
        (task, wt) => {
          resumeWatchTracking(task, wt, (t, status) => { t.status = status; });
        },
        result.snapshot
      );
    }
    const completed = applyCodexHookCompletion(
      () => storage.getState(),
      (task) => {
        completeWatchTask(task);
      },
      result.snapshot,
      {
        resumeTask: (task, pausedWt) => resumeWatchTracking(task, pausedWt, applyTaskStatusChange),
      }
    );
    if (resumed > 0 || completed > 0) storage.save();
    return res.json({ ok: true, completed, resumed, snapshot: result.snapshot });
  });

  app.get('/api/claude-hooks/config', (req, res) => {
    const host = req.get('host') || `${HOST}:${DEFAULT_PORT}`;
    res.json({
      token: claudeHookStore.getToken(),
      apiBase: `http://${host}`,
    });
  });

  app.get('/api/claude-hooks/status', (req, res) => {
    const localInstalled = fs.existsSync(CLAUDE_LOCAL_HOOK_SCRIPT_ABS) && fs.existsSync(CLAUDE_SETTINGS_JSON_ABS);
    const projectId = typeof req.query.project_id === 'string' ? req.query.project_id : '';
    const project = projectId ? findProject(projectId) : null;
    let remote = null;
    const remotes = [];
    if (project && getProjectRemoteRows(project).length) {
      for (const r of getProjectRemoteRows(project)) {
        if (!r?.host) continue;
        remotes.push({
          id: r.id,
          host: r.host,
          projects_root: r.projects_root,
          hook_script: REMOTE_CLAUDE_HOOK_SCRIPT_PATH,
          settings_json: REMOTE_CLAUDE_SETTINGS_PATH,
          tunnel: tunnelStatusForRemote(remoteHookTunnelManager, r, port),
        });
      }
      remote = remotes[0] || null;
    }
    res.json({ local: { installed: localInstalled }, remote, remotes });
  });

  app.get('/api/claude-hooks/snapshots', (req, res) => {
    if (!claudeHookStore.verifyToken(req)) {
      return res.status(401).json({ error: 'Invalid or missing claude hook token' });
    }
    res.json({ ok: true, snapshots: claudeHookStore.listSnapshots() });
  });

  // Raw-hook tap (exact /event bodies) for signal recording. Token-guarded.
  app.get('/api/claude-hooks/raw-events', (req, res) => {
    if (!claudeHookStore.verifyToken(req)) {
      return res.status(401).json({ error: 'Invalid or missing claude hook token' });
    }
    res.json({ ok: true, events: hookEventLog.since('claude', req.query.since) });
  });

  app.post('/api/claude-hooks/install-local', (req, res) => {
    try {
      const out = ensureLocalClaudeHooksInstalled({ profile: installProfileFromReq(req) });
      res.json({ ok: true, ...out });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Failed to install local Claude hooks' });
    }
  });

  app.post('/api/projects/:id/claude-hooks/install-remote', async (req, res) => {
    const project = findProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const toInstall = getProjectRemoteRows(project);
    if (!toInstall.length) {
      return res.status(400).json({ error: 'Project has no remote watch host configured' });
    }
    const profile = installProfileFromReq(req);
    const results = [];
    for (const r of toInstall) {
      try {
        const { cfg, tunnel, remoteApiBase } = await ensureRemoteHookTunnelForInstall(
          project,
          r,
          remoteHookTunnelManager,
          port
        );
        const out = await remoteHookInstallers.claude(cfg, {
          getClaudeHookScript: () => getClaudeTaskAppHookScript(),
          remoteApiBase,
          token: claudeHookStore.getToken(),
          profile,
        });
        results.push({ host: cfg.host, ok: true, tunnel, ...out });
      } catch (err) {
        results.push({ host: r.host, ok: false, error: err.message || String(err) });
      }
    }
    const ok = results.every((x) => x.ok);
    res.json({ ok, results });
  });

  app.post('/api/claude-hooks/test', (req, res) => {
    const now = Date.now();
    const sample = {
      event_name: 'UserPromptSubmit',
      session_id: `claude-test-${now}`,
      prompt_preview: 'orchestra claude hook test event',
      transcript_path: '',
      workspace_path: process.cwd(),
    };
    const result = claudeHookStore.ingestEvent(sample);
    if (!result.ok) return res.status(500).json({ error: result.error || 'Claude hook test failed' });
    res.json({ ok: true, snapshot: result.snapshot });
  });

  app.post('/api/claude-hooks/event', (req, res) => {
    if (!claudeHookStore.verifyToken(req)) {
      return res.status(401).json({ error: 'Invalid or missing claude hook token' });
    }
    const body = req.body || {};
    hookEventLog.push('claude', body);
    const result = claudeHookStore.ingestEvent(body);
    if (!result.ok) return res.status(400).json({ error: result.error });
    const eventName = body.event_name || body.hook_event_name || '';
    let resumed = 0;
    if (eventName === 'UserPromptSubmit' && result.snapshot?.generating) {
      resumed = applyClaudeHookResume(
        () => storage.getState(),
        (task, wt) => {
          resumeWatchTracking(task, wt, (t, status) => { t.status = status; });
        },
        result.snapshot
      );
    }
    const completed = applyClaudeHookCompletion(
      () => storage.getState(),
      (task) => {
        completeWatchTask(task);
      },
      result.snapshot
    );
    if (resumed > 0 || completed > 0) storage.save();
    return res.json({ ok: true, completed, resumed, snapshot: result.snapshot });
  });

  app.get('/api/gemini-hooks/config', (req, res) => {
    const host = req.get('host') || `${HOST}:${DEFAULT_PORT}`;
    res.json({
      token: geminiHookStore.getToken(),
      apiBase: `http://${host}`,
      // Lets the harness verify the server is actually in primary-done-only mode (the toggle
      // is read at startup, so a stale dev server would otherwise silently ignore the flag).
      agyPrimaryDoneOnly: AGY_PRIMARY_DONE_ONLY,
    });
  });

  app.get('/api/gemini-hooks/snapshots', (req, res) => {
    if (!geminiHookStore.verifyToken(req)) {
      return res.status(401).json({ error: 'Invalid or missing gemini hook token' });
    }
    res.json({ ok: true, snapshots: geminiHookStore.listSnapshots() });
  });

  app.get('/api/gemini-hooks/raw-events', (req, res) => {
    if (!geminiHookStore.verifyToken(req)) {
      return res.status(401).json({ error: 'Invalid or missing gemini hook token' });
    }
    res.json({ ok: true, events: hookEventLog.since('gemini', req.query.since) });
  });

  app.get('/api/gemini-hooks/status', (req, res) => {
    const localInstalled =
      fs.existsSync(GEMINI_LOCAL_HOOK_SCRIPT_ABS) &&
      (fs.existsSync(GEMINI_AGY_HOOKS_JSON_ABS) || fs.existsSync(GEMINI_SETTINGS_JSON_ABS));
    const projectId = typeof req.query.project_id === 'string' ? req.query.project_id : '';
    const project = projectId ? findProject(projectId) : null;
    let remote = null;
    const remotes = [];
    if (project && getProjectRemoteRows(project).length) {
      for (const r of getProjectRemoteRows(project)) {
        if (!r?.host) continue;
        remotes.push({
          id: r.id,
          host: r.host,
          projects_root: r.projects_root,
          hook_script: REMOTE_GEMINI_HOOK_SCRIPT_PATH,
          agy_hooks_json: REMOTE_GEMINI_AGY_HOOKS_JSON_PATH,
          settings_json: REMOTE_GEMINI_SETTINGS_PATH,
          tunnel: tunnelStatusForRemote(remoteHookTunnelManager, r, port),
        });
      }
      remote = remotes[0] || null;
    }
    res.json({ local: { installed: localInstalled }, remote, remotes });
  });

  app.post('/api/gemini-hooks/install-local', (req, res) => {
    try {
      const out = ensureLocalGeminiHooksInstalled({ profile: installProfileFromReq(req) });
      res.json({ ok: true, ...out });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Failed to install local Gemini hooks' });
    }
  });

  app.post('/api/projects/:id/gemini-hooks/install-remote', async (req, res) => {
    const project = findProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const toInstall = getProjectRemoteRows(project);
    if (!toInstall.length) {
      return res.status(400).json({ error: 'Project has no remote watch host configured' });
    }
    const profile = installProfileFromReq(req);
    const results = [];
    for (const r of toInstall) {
      try {
        const { cfg, tunnel, remoteApiBase } = await ensureRemoteHookTunnelForInstall(
          project,
          r,
          remoteHookTunnelManager,
          port
        );
        const out = await remoteHookInstallers.gemini(cfg, {
          getGeminiHookScript: () => getGeminiTaskAppHookScript(),
          remoteApiBase,
          token: geminiHookStore.getToken(),
          appToken: APP_TOKEN,
          profile,
        });
        results.push({ host: cfg.host, ok: true, tunnel, ...out });
      } catch (err) {
        results.push({ host: r.host, ok: false, error: err.message || String(err) });
      }
    }
    const ok = results.every((x) => x.ok);
    res.json({ ok, results });
  });

  app.post('/api/gemini-hooks/test', (req, res) => {
    const now = Date.now();
    const sample = {
      event_name: 'BeforeAgent',
      session_id: `gemini-test-${now}`,
      prompt: 'orchestra gemini hook test event',
      transcript_path: '',
      workspace_path: process.cwd(),
    };
    const result = geminiHookStore.ingestEvent(sample);
    if (!result.ok) return res.status(500).json({ error: result.error || 'Gemini hook test failed' });
    res.json({ ok: true, snapshot: result.snapshot });
  });

  app.post('/api/gemini-hooks/event', async (req, res) => {
    if (!geminiHookStore.verifyToken(req)) {
      return res.status(401).json({ error: 'Invalid or missing gemini hook token' });
    }
    const body = req.body || {};
    const eventName = body.event_name || body.hook_event_name || body.hookEventName || '';
    const eventNameLower = String(eventName).trim().toLowerCase();
    const legacyEvents = new Set([
      'beforeagent', 'beforemodel', 'aftermodel', 'afteragent', 'beforetool',
      'sessionstart', 'sessionend', 'notification',
      'before_agent', 'before_model', 'after_model', 'after_agent', 'before_tool',
      'session_start', 'session_end'
    ]);
    if (legacyEvents.has(eventNameLower)) {
      console.warn(`[deprecation] Received legacy Gemini CLI hook event: ${eventName}. Legacy Gemini CLI is deprecated.`);
      res.setHeader('X-Deprecation-Warning', 'Legacy Gemini CLI is deprecated and will be removed in a future release.');
    }
    hookEventLog.push('gemini', body);
    const remoteHost = typeof body.remote_host === 'string' ? body.remote_host.trim() : '';
    if (remoteHost) await refreshGeminiSubAgentCacheForHost(remoteHost, runSsh);
    const result = geminiHookStore.ingestEvent(body);
    if (!result.ok) return res.status(400).json({ error: result.error });
    let resumed = 0;
    if (result.snapshot?.generating) {
      resumed = applyGeminiHookResume(
        () => storage.getState(),
        (task, wt) => {
          resumeWatchTracking(task, wt, (t, status) => { t.status = status; });
        },
        result.snapshot
      );
    }
    const completed = applyGeminiHookCompletion(
      () => storage.getState(),
      (task) => {
        completeWatchTask(task);
      },
      result.snapshot,
      geminiHookApplyOptions()
    );
    if (resumed > 0 || completed > 0) storage.save();
    return res.json({ ok: true, completed, resumed, snapshot: result.snapshot });
  });
  function applyCursorSubagentWatchOnSpawn(getState, body) {
    if (body?.hook_event_name !== 'subagentStart') return 0;
    const parentId = normalizeConversationId(body.parent_conversation_id || body.conversation_id);
    if (!parentId) return 0;
    const conversationSnap = cursorHookStore.getConversationSnapshotForTracking({
      conversation_id: parentId,
    });
    let touched = 0;
    for (const project of getState().projects || []) {
      for (const task of project.tasks || []) {
        if (task.status !== 'waiting') continue;
        const wt = task.watch_tracking;
        if (!wt || wt.kind !== 'cursor') continue;
        const watchConversation = normalizeConversationId(wt.conversation_id);
        if (!watchConversation || watchConversation !== parentId) continue;
        if (touchCursorSubagentWatchOnSpawn(wt, conversationSnap)) touched += 1;
      }
    }
    return touched;
  }
  function applyCursorHookCompletion(getState, onEachTask, snapshot) {
    if (!snapshot || !snapshot.completion_hint) return 0;
    let completedCount = 0;
    const targetTranscript = typeof snapshot.transcript_path === 'string' ? snapshot.transcript_path : '';
    const targetConversation = normalizeConversationId(snapshot.conversation_id);
    for (const project of getState().projects || []) {
      for (const task of project.tasks || []) {
        if (task.status !== 'waiting') continue;
        const wt = task.watch_tracking;
        if (!wt || wt.kind !== 'cursor') continue;
        const watchTranscript = typeof wt.transcript_path === 'string' ? wt.transcript_path : '';
        const watchConversation = normalizeConversationId(wt.conversation_id);
        const transcriptMatch = targetTranscript && watchTranscript && targetTranscript === watchTranscript;
        const conversationMatch = targetConversation && watchConversation && targetConversation === watchConversation;
        if (!transcriptMatch && !conversationMatch) continue;
        const conversationSnap = cursorHookStore.getConversationSnapshotForTracking(wt);
        if (!shouldApplyCursorHookCompletionNow(wt, snapshot, conversationSnap)) continue;
        // An aborted/cancelled terminal status clears straight back to monitor.
        if (snapshot.completion_status === 'aborted' || snapshot.completion_status === 'cancelled') {
          markCancelledWatchClear(wt);
        }
        onEachTask(task);
        completedCount += 1;
      }
    }
    return completedCount;
  }
  function applyClaudeHookCompletion(getState, onEachTask, snapshot) {
    if (!snapshot || !snapshot.completion_hint) return 0;
    let completedCount = 0;
    const targetTranscript = typeof snapshot.transcript_path === 'string' ? snapshot.transcript_path : '';
    const targetSessionId = normalizeSessionId(snapshot.session_id);
    for (const project of getState().projects || []) {
      for (const task of project.tasks || []) {
        if (task.status !== 'waiting') continue;
        const wt = task.watch_tracking;
        if (!wt || wt.kind !== 'ide_agent' || wt.provider !== 'claude') continue;
        const watchTranscript = typeof wt.transcript_path === 'string' ? wt.transcript_path : '';
        const watchSessionId = normalizeSessionId(wt.session_id);
        const transcriptMatch = targetTranscript && watchTranscript && targetTranscript === watchTranscript;
        const sessionMatch = targetSessionId && watchSessionId && targetSessionId === watchSessionId;
        if (!transcriptMatch && !sessionMatch) continue;
        // Permission/AskUserQuestion stops carry a permission attention reason; plain
        // Stop does not. Tag the watcher so it flips to "needs input" vs "done".
        if (isPermissionAttentionReason(snapshot.attention_reason)) {
          markHumanGateWatchClear(wt, 'permission', snapshot, nowIso());
        }
        onEachTask(task);
        completedCount += 1;
      }
    }
    return completedCount;
  }
  function applyCursorHookResume(getState, onResumeTask, snapshot) {
    if (!snapshot) return 0;
    let resumedCount = 0;
    const targetTranscript = typeof snapshot.transcript_path === 'string' ? snapshot.transcript_path : '';
    const targetConversation = normalizeConversationId(snapshot.conversation_id);
    for (const project of getState().projects || []) {
      for (const task of project.tasks || []) {
        if (task.status === 'waiting') continue;
        const wt = task.completed_watch_tracking;
        if (!wt || wt.kind !== 'cursor') continue;
        const watchTranscript = typeof wt.transcript_path === 'string' ? wt.transcript_path : '';
        const watchConversation = normalizeConversationId(wt.conversation_id);
        const transcriptMatch = targetTranscript && watchTranscript && targetTranscript === watchTranscript;
        const conversationMatch = targetConversation && watchConversation && targetConversation === watchConversation;
        if (!transcriptMatch && !conversationMatch) continue;
        onResumeTask(task, wt);
        resumedCount += 1;
      }
    }
    return resumedCount;
  }
  function applyClaudeHookResume(getState, onResumeTask, snapshot) {
    if (!snapshot) return 0;
    let resumedCount = 0;
    const targetTranscript = typeof snapshot.transcript_path === 'string' ? snapshot.transcript_path : '';
    const targetSessionId = normalizeSessionId(snapshot.session_id);
    for (const project of getState().projects || []) {
      for (const task of project.tasks || []) {
        if (task.status === 'waiting') continue;
        const wt = task.completed_watch_tracking;
        if (!wt || wt.kind !== 'ide_agent' || wt.provider !== 'claude') continue;
        const watchTranscript = typeof wt.transcript_path === 'string' ? wt.transcript_path : '';
        const watchSessionId = normalizeSessionId(wt.session_id);
        const transcriptMatch = targetTranscript && watchTranscript && targetTranscript === watchTranscript;
        const sessionMatch = targetSessionId && watchSessionId && targetSessionId === watchSessionId;
        if (!transcriptMatch && !sessionMatch) continue;
        onResumeTask(task, wt);
        resumedCount += 1;
      }
    }
    return resumedCount;
  }
  function applyGeminiHookResume(getState, onResumeTask, snapshot) {
    if (!snapshot || !snapshot.generating) return 0;
    let resumedCount = 0;
    const targetTranscript = typeof snapshot.transcript_path === 'string' ? snapshot.transcript_path : '';
    const targetSessionId = normalizeSessionId(snapshot.session_id);
    const targetHost =
      (typeof snapshot.remote_host === 'string' && snapshot.remote_host.trim()) ||
      (typeof snapshot.host === 'string' && snapshot.host.trim()) ||
      '';
    for (const project of getState().projects || []) {
      for (const task of project.tasks || []) {
        if (task.status === 'waiting') continue;
        const wt = task.completed_watch_tracking;
        if (!wt || wt.kind !== 'ide_agent' || (wt.provider !== 'gemini' && wt.provider !== 'gemini_cli')) continue;
        const watchHost = typeof wt.host === 'string' ? wt.host.trim() : '';
        if (targetHost && watchHost && targetHost !== watchHost) continue;
        const watchTranscript = typeof wt.transcript_path === 'string' ? wt.transcript_path : '';
        const watchSessionId = normalizeSessionId(wt.session_id);
        const transcriptMatch = targetTranscript && watchTranscript && targetTranscript === watchTranscript;
        const sessionMatch = targetSessionId && watchSessionId && targetSessionId === watchSessionId;
        if (!transcriptMatch && !sessionMatch) continue;
        onResumeTask(task, wt);
        resumedCount += 1;
      }
    }
    return resumedCount;
  }
  app.get('/api/processes/local', async (req, res) => {
    try {
      const includeAll = parseBool(req.query.include_all);
      const query = typeof req.query.query === 'string' ? req.query.query : '';
      const out = await listLocalProcesses({ includeAll, query });
      res.json(out);
    } catch (err) {
      console.error('[server] /api/processes/local:', err);
      res.status(500).json({ error: err.message || 'Failed to list local processes' });
    }
  });

  app.get('/api/projects/:id/processes/local', async (req, res) => {
    const project = findProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    try {
      const includeAll = parseBool(req.query.include_all);
      const query = typeof req.query.query === 'string' ? req.query.query : '';
      const workspaceRoots = getProcessListWorkspaceRoots(project, 'local');
      const out = await listLocalProcesses({ includeAll, query, workspaceRoots, aggressiveClean: true });
      res.json(out);
    } catch (err) {
      console.error('[server] /api/projects/:id/processes/local:', err);
      res.status(500).json({ error: err.message || 'Failed to list local processes' });
    }
  });

  app.get('/api/projects/:id/processes/remote', async (req, res) => {
    const project = findProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const remotes =
      Array.isArray(project.cursor_remotes) && project.cursor_remotes.length
        ? project.cursor_remotes
        : project.cursor_remote?.host
          ? [project.cursor_remote]
          : [];
    if (!remotes.length) {
      return res.status(400).json({ error: 'Project has no remote watch host configured' });
    }
    try {
      const includeAll = parseBool(req.query.include_all);
      const query = typeof req.query.query === 'string' ? req.query.query : '';
      const merged = {
        likely: [],
        all: [],
        items: [],
        truncated: false,
        workspace_roots_applied: false,
        no_match_reason: null,
        remote_errors: [],
      };
      for (const r of remotes) {
        const cfg = assertValidRemoteSource(r);
        const workspaceRoots = workspaceRootsForRemoteConfig(project, cfg);
        const out = await listRemoteProcesses(cfg, {
          includeAll,
          query,
          workspaceRoots,
          aggressiveClean: true,
        });
        if (out.remote_error) {
          merged.remote_errors.push({ host: cfg.host, error: out.remote_error });
          console.warn(
            `[server] /api/projects/${req.params.id}/processes/remote: ${cfg.host}: ${out.remote_error}`
          );
        }
        merged.likely.push(...out.likely);
        merged.all.push(...out.all);
        merged.items.push(...out.items);
        merged.truncated ||= out.truncated;
        merged.workspace_roots_applied ||= out.workspace_roots_applied;
        if (!merged.no_match_reason && out.no_match_reason) merged.no_match_reason = out.no_match_reason;
      }
      res.json(merged);
    } catch (err) {
      console.error('[server] /api/projects/:id/processes/remote:', err);
      res.status(500).json({ error: err.message || 'Failed to list remote processes' });
    }
  });

  app.post('/api/projects/:id/tasks/:taskId/cursor-link', (req, res) => {
    const project = findProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const task = findTask(project, req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.status === 'done') {
      return res.status(400).json({ error: 'Cannot link Cursor run on a completed task' });
    }
    const body = req.body || {};
    const source = body.source === 'ssh' ? 'ssh' : 'local';
    const { transcript_path } = body;
    if (!transcript_path || typeof transcript_path !== 'string') {
      return res.status(400).json({ error: 'transcript_path is required' });
    }
    let tracking;
    if (source === 'ssh') {
      try {
        const remote = resolveSshWatchRemote(project, body);
        const resolved = assertAllowedRemoteTranscriptPath(transcript_path.trim(), remote.projects_root);
        const runId = path.posix.basename(resolved, '.jsonl');
        tracking = remoteCursorToWatchTracking(runId, resolved, remote);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    } else {
      let resolved;
      try {
        resolved = assertAllowedTranscriptPath(transcript_path.trim());
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      try {
        if (!fs.existsSync(resolved)) {
          return res.status(400).json({ error: 'Transcript file does not exist' });
        }
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      const runId = path.basename(resolved, '.jsonl');
      tracking = cursorToWatchTracking(runId, resolved);
    }

    applyTaskStatusChange(task, 'waiting');
    task.watch_tracking = tracking;
    task.cursor_tracking = tracking;
    storage.save();
    res.json(task);
  });

  app.post('/api/projects/:id/tasks/:taskId/cursor-unlink', (req, res) => {
    const project = findProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const task = findTask(project, req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    task.watch_tracking = null;
    task.cursor_tracking = null;
    storage.save();
    res.json(task);
  });

  app.post('/api/projects/:id/tasks/:taskId/watch-link', async (req, res) => {
    const project = findProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const task = findTask(project, req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.status === 'done') {
      return res.status(400).json({ error: 'Cannot watch a completed task' });
    }
    const body = req.body || {};
    const kind =
      body.kind === 'process'
        ? 'process'
        : body.kind === 'notification'
          ? 'notification'
          : body.kind === 'browser_chat'
            ? 'browser_chat'
            : body.kind === 'ide_agent'
              ? 'ide_agent'
            : 'cursor';
    const source = body.source === 'ssh' ? 'ssh' : 'local';
    let tracking;
    try {
      if (kind === 'process') {
        const pid = Number.parseInt(body.pid, 10);
        if (!Number.isInteger(pid) || pid <= 0) {
          return res.status(400).json({ error: 'pid must be a positive integer' });
        }
        if (source === 'ssh') {
          const remote = resolveSshWatchRemote(project, body);
          tracking = defaultRemoteProcessTracking(
            pid,
            {
              command: body.command,
              cwd: body.cwd,
              tty: body.tty,
              pgid: Number.parseInt(body.pgid, 10) || null,
              completion: body.completion,
            },
            remote
          );
        } else {
          tracking = defaultProcessTracking(pid, {
            command: body.command,
            cwd: body.cwd,
            tty: body.tty,
            pgid: Number.parseInt(body.pgid, 10) || null,
            completion: body.completion,
          });
        }
      } else if (kind === 'cursor') {
        const { transcript_path } = body;
        const conversation_id = normalizeConversationId(body.conversation_id);
        if ((!transcript_path || typeof transcript_path !== 'string') && !conversation_id) {
          return res.status(400).json({ error: 'transcript_path or conversation_id is required for cursor watch' });
        }
        if (source === 'ssh') {
          const remote = resolveSshWatchRemote(project, body);
          let resolved = '';
          if (transcript_path && typeof transcript_path === 'string') {
            resolved = assertAllowedRemoteTranscriptPath(transcript_path.trim(), remote.projects_root);
          }
          const runId = resolved ? path.posix.basename(resolved, '.jsonl') : conversation_id;
          tracking = resolved
            ? remoteCursorToWatchTracking(runId, resolved, remote)
            : {
                kind: 'cursor',
                source: 'ssh',
                host: remote.host,
                projects_root: remote.projects_root,
                run_id: runId,
                transcript_path: '',
                conversation_id,
                linked_at: nowIso(),
                last_seen_mtime_ms: null,
                idle_since_ms: null,
                last_error: null,
              };
          if (conversation_id) tracking.conversation_id = conversation_id;
          attachCursorWatchWorkspaceSlugs(project, tracking, source);
          await resolveCursorWatchTranscriptOnLink(tracking, source);
        } else {
          let resolved = '';
          if (transcript_path && typeof transcript_path === 'string') {
            resolved = assertAllowedTranscriptPath(transcript_path.trim());
          }
          const runId = resolved ? path.basename(resolved, '.jsonl') : conversation_id;
          tracking = cursorToWatchTracking(runId, resolved || '');
          if (conversation_id) {
            tracking.conversation_id = conversation_id;
          }
          attachCursorWatchWorkspaceSlugs(project, tracking, source);
          await resolveCursorWatchTranscriptOnLink(tracking, source);
        }
      } else if (kind === 'browser_chat') {
        const pasted = typeof body.pasted_url === 'string' ? body.pasted_url.trim() : '';
        const parsed = pasted ? browserChatStore.parseChatUrl(pasted) : null;
        let provider = body.provider;
        let conversation_id = body.conversation_id;
        if (parsed) {
          provider = parsed.provider;
          conversation_id = parsed.conversation_id;
        }
        if (provider !== 'chatgpt' && provider !== 'claude' && provider !== 'gemini') {
          return res.status(400).json({ error: 'provider must be "chatgpt", "claude", or "gemini"' });
        }
        const cid = typeof conversation_id === 'string' ? conversation_id.trim().toLowerCase() : '';
        if (!cid) {
          return res.status(400).json({ error: 'conversation_id or pasted_url with a recognized chat URL is required' });
        }
        tracking = browserChatStore.normalizeBrowserChatTracking({
          provider,
          conversation_id: cid,
          url: typeof body.url === 'string' ? body.url : pasted || '',
          title: typeof body.title === 'string' ? body.title : '',
          last_user_preview: typeof body.last_user_preview === 'string' ? body.last_user_preview : '',
          tab_id: body.tab_id != null ? Number.parseInt(body.tab_id, 10) : null,
        });
        if (!tracking) {
          return res.status(400).json({ error: 'Invalid browser chat watch data' });
        }
      } else if (kind === 'ide_agent') {
        const provider = ['claude', 'claude_cowork', 'codex', 'gemini'].includes(body.provider)
          ? body.provider
          : '';
        if (!provider) {
          return res
            .status(400)
            .json({ error: 'provider must be "codex", "claude", "claude_cowork", or "gemini"' });
        }
        const ideSource = body.source === 'ssh' ? 'ssh' : 'local';
        if (provider === 'claude_cowork' && ideSource === 'ssh') {
          return res.status(400).json({ error: 'Claude Cowork watching is local only' });
        }
        const sessionId = normalizeSessionId(body.session_id);
        const transcript_path_raw = typeof body.transcript_path === 'string' ? body.transcript_path.trim() : '';
        const audit_path_raw = typeof body.audit_path === 'string' ? body.audit_path.trim() : '';
        if (!sessionId && !transcript_path_raw && !audit_path_raw) {
          return res.status(400).json({ error: 'session_id, transcript_path, or audit_path is required for ide_agent watch' });
        }
        let transcriptPath = '';
        let auditPath = '';
        let remote = null;
        if (ideSource === 'ssh') {
          remote = resolveSshWatchRemote(project, body);
          if (transcript_path_raw) {
            transcriptPath =
              provider === 'codex'
                ? assertAllowedRemoteCodexTranscriptPath(transcript_path_raw)
                : provider === 'claude'
                  ? assertAllowedRemoteClaudeTranscriptPath(transcript_path_raw)
                  : assertAllowedRemoteGeminiTranscriptPath(transcript_path_raw);
          }
        } else if (transcript_path_raw) {
          transcriptPath =
            provider === 'codex'
              ? assertAllowedCodexTranscriptPath(transcript_path_raw)
              : provider === 'claude'
                ? assertAllowedClaudeTranscriptPath(transcript_path_raw)
                : assertAllowedGeminiTranscriptPath(transcript_path_raw);
        }
        if (provider === 'claude_cowork') {
          auditPath = assertAllowedCoworkAuditPath(audit_path_raw || transcript_path_raw);
          if (!fs.existsSync(auditPath)) {
            return res.status(400).json({ error: 'Audit file does not exist' });
          }
        }
        tracking = {
          kind: 'ide_agent',
          provider,
          source: ideSource,
          host: remote?.host || null,
          projects_root: remote?.projects_root || null,
          state_location:
            body.state_location === 'local'
              ? 'local'
              : body.state_location === 'remote'
                ? 'remote'
                : body.state_location === 'log'
                  ? 'log'
                  : '',
          session_id: sessionId || (auditPath ? path.basename(path.dirname(auditPath)) : path.basename(transcriptPath, '.jsonl')),
          transcript_path: transcriptPath,
          audit_path: auditPath,
          title: typeof body.title === 'string' ? body.title : '',
          workspace_path: typeof body.workspace_path === 'string' ? body.workspace_path : '',
          last_user_preview: typeof body.last_user_preview === 'string' ? body.last_user_preview : '',
          log_path: typeof body.log_path === 'string' ? body.log_path : '',
          log_request_id: typeof body.log_request_id === 'string' ? body.log_request_id : '',
          log_started_at: typeof body.log_started_at === 'string' ? body.log_started_at : '',
          log_done_at: typeof body.log_done_at === 'string' ? body.log_done_at : '',
          linked_at: nowIso(),
          last_seen_at: null,
          completion_hint_at: null,
          last_error: null,
        };
      } else {
        const provider = body.provider;
        if (provider !== 'chatgpt' && provider !== 'claude') {
          return res.status(400).json({ error: 'provider must be "chatgpt" or "claude"' });
        }
        tracking = defaultNotificationTracking(provider);
        const latest = await getLatestNotificationRecId();
        tracking.since_rec_id = latest.maxRecId;
        tracking.last_seen_rec_id = latest.maxRecId;
        tracking.last_error = latest.error || null;
      }
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (tracking.kind === 'browser_chat') {
      const snapshot = browserChatStore.findSnapshot(tracking.provider, tracking.conversation_id);
      if (snapshot && !snapshot.generating) {
        completeWatchTask(task);
        storage.save();
        return res.json(task);
      }
    }
    if (tracking.kind === 'cursor') {
      const conversationSnap = cursorHookStore.getConversationSnapshotForTracking(tracking);
      initializeMultitaskSubagentWatchOnLink(tracking, conversationSnap);
    }
    applyTaskStatusChange(task, 'waiting');
    task.watch_tracking = tracking;
    task.cursor_tracking = tracking.kind === 'cursor' ? tracking : null;
    if (
      tracking.kind === 'ide_agent' &&
      (tracking.provider === 'gemini' || tracking.provider === 'gemini_cli')
    ) {
      await completeGeminiPermissionWatchIfPending(task, geminiHookApplyOptions());
    }
    storage.save();
    res.json(task);
  });

  app.get('/api/browser-chats/config', (req, res) => {
    const host = req.get('host') || `${HOST}:${DEFAULT_PORT}`;
    res.json({
      token: browserChatStore.getToken(),
      apiBase: `http://${host}`,
    });
  });

  app.get('/api/browser-chats', (req, res) => {
    const provider = req.query.provider;
    if (provider != null && provider !== '' && !['chatgpt', 'claude', 'gemini'].includes(String(provider))) {
      return res.status(400).json({ error: 'provider must be chatgpt, claude, or gemini' });
    }
    const items = browserChatStore.listByProvider(provider || null);
    res.json({ items });
  });

  app.post('/api/browser-chats/snapshot', (req, res) => {
    if (!browserChatStore.verifyToken(req)) {
      return res.status(401).json({ error: 'Invalid or missing browser chat token' });
    }
    const result = browserChatStore.ingestSnapshot(req.body || {});
    if (!result.ok) return res.status(400).json({ error: result.error });
    if (result.snapshot?.generating) {
      const resumed = applyBrowserChatResume(
        () => storage.getState(),
        (task, wt) => {
          resumeWatchTracking(task, wt, applyTaskStatusChange);
        },
        result.snapshot.provider,
        result.snapshot.conversation_id
      );
      if (resumed > 0) storage.save();
    }
    res.json({ ok: true });
  });

  // Structural-only stream-body signal (S1/S3/S4/S5) forwarded by the extension's main-world hook.
  // Stores the signal on the tab/conversation; a stream-carried conversation_id becomes the
  // authoritative attribution key for ChatGPT/Gemini (closing findings/10 §4). Never carries model
  // content — see lib/browser_chat.js normalizeStreamSignal for the whitelist.
  app.post('/api/browser-chats/stream-signal', (req, res) => {
    if (!browserChatStore.verifyToken(req)) {
      return res.status(401).json({ error: 'Invalid or missing browser chat token' });
    }
    const result = browserChatStore.ingestStreamSignal(req.body || {});
    if (!result.ok) return res.status(400).json({ error: result.error });
    // If the stream gave us a real conversation id for ChatGPT/Gemini, resume any task that was
    // watching this (now better-attributed) conversation — same semantics as a generating snapshot.
    const sig = result.signal;
    if (sig.conversation_id && (sig.provider === 'chatgpt' || sig.provider === 'gemini')) {
      const resumed = applyBrowserChatResume(
        () => storage.getState(),
        (task, wt) => {
          resumeWatchTracking(task, wt, applyTaskStatusChange);
        },
        sig.provider,
        sig.conversation_id
      );
      if (resumed > 0) storage.save();
    }
    res.json({ ok: true });
  });

  // Read endpoint for the recorder's live capture (structural stream signals only).
  app.get('/api/browser-chats/stream-signals', (req, res) => {
    const provider = req.query.provider;
    if (provider != null && provider !== '' && !['chatgpt', 'claude', 'gemini'].includes(String(provider))) {
      return res.status(400).json({ error: 'provider must be chatgpt, claude, or gemini' });
    }
    res.json({ signals: browserChatStore.listAllStreamSignals(provider || null) });
  });

  app.post('/api/browser-chats/tab-closed', (req, res) => {
    if (!browserChatStore.verifyToken(req)) {
      return res.status(401).json({ error: 'Invalid or missing browser chat token' });
    }
    browserChatStore.removeTab(req.body && req.body.tab_id);
    res.json({ ok: true });
  });
  let probeLogs = [];

  app.post('/api/browser-chats/probe-log', (req, res) => {
    if (!browserChatStore.verifyToken(req)) {
      return res.status(401).json({ error: 'Invalid or missing browser chat token' });
    }
    const log = req.body || {};
    log.serverTimestamp = new Date().toISOString();
    probeLogs.push(log);
    if (probeLogs.length > 5000) {
      probeLogs.shift();
    }
    res.json({ ok: true });
  });

  app.get('/api/browser-chats/probe-logs', (req, res) => {
    res.json({ logs: probeLogs });
  });

  app.post('/api/browser-chats/probe-logs/clear', (req, res) => {
    probeLogs = [];
    res.json({ ok: true });
  });

  app.post('/api/browser-chats/complete', (req, res) => {
    if (!browserChatStore.verifyToken(req)) {
      return res.status(401).json({ error: 'Invalid or missing browser chat token' });
    }
    const body = req.body || {};
    const provider = body.provider;
    const conversation_id =
      typeof body.conversation_id === 'string' ? body.conversation_id.trim().toLowerCase() : '';
    if (provider !== 'chatgpt' && provider !== 'claude' && provider !== 'gemini') {
      return res.status(400).json({ error: 'provider must be "chatgpt", "claude", or "gemini"' });
    }
    if (!conversation_id) {
      return res.status(400).json({ error: 'conversation_id is required' });
    }
    const completed = applyBrowserChatCompletion(
      () => storage.getState(),
      (task) => {
        completeWatchTask(task);
      },
      provider,
      conversation_id
    );
    if (completed) storage.save();
    res.json({ ok: true, completed });
  });

  // ── TEST-ONLY browser-chat drive queue (v3-browser-driver) ──────────────────
  // Lets a harness/CLI (scripts/browser_chat_drive.js) enqueue "send this prompt"
  // commands that the extension's background drains and relays to driver.js. This
  // is a TEST driver: it only *sends prompts*. It never touches completion (that
  // stays /api/browser-chats/complete + the extension's webRequest edge). The
  // whole chain is also inert unless the extension's `taskAppChatWatchDriver`
  // flag is on, so registering these routes is harmless in normal use. The queue
  // is in-memory only (lost on restart) — appropriate for a dev test driver.
  let driveQueue = [];        // pending commands the background hasn't drained
  const driveResults = new Map(); // id -> result reported by the background
  let driveSeq = 0;

  app.post('/api/browser-chats/drive', (req, res) => {
    if (!browserChatStore.verifyToken(req)) {
      return res.status(401).json({ error: 'Invalid or missing browser chat token' });
    }
    const body = req.body || {};
    const provider = body.provider;
    if (provider !== 'chatgpt' && provider !== 'claude' && provider !== 'gemini') {
      return res.status(400).json({ error: 'provider must be "chatgpt", "claude", or "gemini"' });
    }
    const modeOnly = !!body.modeOnly;
    // modeOnly = "just turn on deep research, send nothing" (test toggle), so a
    // prompt is not required in that case.
    if (!modeOnly && (typeof body.prompt !== 'string' || !body.prompt.trim())) {
      return res.status(400).json({ error: 'prompt is required' });
    }
    driveSeq += 1;
    const id = `drive-${Date.now()}-${driveSeq}`;
    const command = {
      id,
      provider,
      prompt: typeof body.prompt === 'string' ? body.prompt : '',
      deepResearch: !!body.deepResearch,
      modeOnly,
      tabId: Number.isInteger(body.tab_id) ? body.tab_id : null,
      enqueued_at: new Date().toISOString(),
    };
    driveQueue.push(command);
    res.json({ ok: true, id });
  });

  // Background drains pending commands (token-authed). Returns and clears them.
  app.get('/api/browser-chats/drive/pending', (req, res) => {
    if (!browserChatStore.verifyToken(req)) {
      return res.status(401).json({ error: 'Invalid or missing browser chat token' });
    }
    const commands = driveQueue;
    driveQueue = [];
    res.json({ commands });
  });

  // Background reports the per-command drive outcome (token-authed). The harness
  // polls /drive/result/:id to learn whether the send landed. Guardrail: this is
  // a *send* result (submit method, deep-research toggle), never a done signal.
  app.post('/api/browser-chats/drive/result', (req, res) => {
    if (!browserChatStore.verifyToken(req)) {
      return res.status(401).json({ error: 'Invalid or missing browser chat token' });
    }
    const body = req.body || {};
    if (!body.id) return res.status(400).json({ error: 'id is required' });
    driveResults.set(body.id, {
      id: body.id,
      tab_id: body.tab_id != null ? body.tab_id : null,
      provider: body.provider || '',
      ok: !!body.ok,
      submit_method: body.submit_method || '',
      deep_research_enabled: !!body.deep_research_enabled,
      error: body.error || '',
      reported_at: new Date().toISOString(),
    });
    res.json({ ok: true });
  });

  // Harness polls for a command's outcome.
  app.get('/api/browser-chats/drive/result/:id', (req, res) => {
    const result = driveResults.get(req.params.id);
    if (!result) return res.json({ pending: true });
    res.json({ pending: false, result });
  });

  app.post('/api/projects/:id/tasks/:taskId/watch-unlink', (req, res) => {
    const project = findProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const task = findTask(project, req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    task.watch_tracking = null;
    task.cursor_tracking = null;
    storage.save();
    res.json(task);
  });

  // Manually mark tracking as finished — green "done" pill, task stays open (not crossed out).
  app.post('/api/projects/:id/tasks/:taskId/watch-complete', (req, res) => {
    const project = findProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const task = findTask(project, req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    manualCompleteWatchTask(task);
    storage.save();
    res.json(task);
  });

  // Acknowledge the green "agent finished" state — clears the marker so the task
  // returns to plain "monitor" without changing its status.
  app.post('/api/projects/:id/tasks/:taskId/watch-ack', (req, res) => {
    const project = findProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const task = findTask(project, req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    task.watch_finished = null;
    task.paused_watch_tracking = null;
    storage.save();
    res.json(task);
  });

  app.post('/api/projects', (req, res) => {
    const body = req.body || {};
    const { name, color, task_summary, is_backlog } = body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    let launchCommands;
    let workspace;
    try {
      launchCommands = parseLaunchCommands(body) || [];
      workspace = parseWorkspacePayload(body, launchCommands);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const state = storage.getState();
    let cursorRemotes;
    let cursorWorkspaces = [];
    try {
      cursorRemotes = parseProjectCursorRemotesFromRequest(body);
      const parsedWorkspaces = parseCursorWorkspaces(body);
      if (parsedWorkspaces !== undefined) cursorWorkspaces = parsedWorkspaces;
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const project = {
      id: projectId(),
      name: name.trim(),
      launch_command: launchCommands[0] || '',
      launch_commands: launchCommands,
      workspace_items: workspace.workspace_items,
      workspace_commands: workspace.workspace_commands,
      task_summary: typeof task_summary === 'string' ? task_summary : '',
      cursor_remotes: [],
      cursor_remote: null,
      cursor_workspaces: cursorWorkspaces,
      is_backlog: !!is_backlog,
      color: VALID_COLORS.has(color) ? color : 'teal',
      order: state.projects.length,
      created_at: nowIso(),
      tasks: [],
    };
    assignProjectCursorRemotes(project, cursorRemotes ?? []);
    state.projects.push(project);
    storage.save();
    res.status(201).json(project);
  });

  app.patch('/api/projects/:id', (req, res) => {
    const project = findProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const body = req.body || {};
    const { name, color, task_summary, is_backlog } = body;
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name must be a non-empty string' });
      }
      project.name = name.trim();
    }
    const launchChanged = hasOwn(body, 'launch_commands') || hasOwn(body, 'launch_command');
    const workspaceChanged = hasOwn(body, 'workspace_items') || hasOwn(body, 'workspace_commands');
    if (launchChanged) {
      try {
        setProjectLaunchCommands(project, parseLaunchCommands(body) || []);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }
    if (workspaceChanged) {
      try {
        const workspace = parseWorkspacePayload(body, project.launch_commands);
        project.workspace_items = workspace.workspace_items;
        project.workspace_commands = workspace.workspace_commands;
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    } else if (launchChanged) {
      try {
        const workspace = parseWorkspacePayload(project, project.launch_commands);
        project.workspace_items = workspace.workspace_items;
        project.workspace_commands = workspace.workspace_commands;
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }
    if (color !== undefined) {
      if (!VALID_COLORS.has(color)) {
        return res.status(400).json({ error: `color must be one of ${[...VALID_COLORS].join(', ')}` });
      }
      project.color = color;
    }
    if (task_summary !== undefined) {
      if (typeof task_summary !== 'string') {
        return res.status(400).json({ error: 'task_summary must be a string' });
      }
      project.task_summary = task_summary;
    }
    if (is_backlog !== undefined) {
      project.is_backlog = !!is_backlog;
    }
    try {
      const nextRemotesExplicit = parseCursorRemotesBody(body);
      if (nextRemotesExplicit !== undefined) {
        assignProjectCursorRemotes(project, preserveRemoteHookTunnelFields(project, nextRemotesExplicit));
      } else {
        const legacy = parseCursorRemote(body);
        if (legacy !== undefined) {
          if (legacy === null) {
            assignProjectCursorRemotes(project, []);
          } else {
            const keepId = Array.isArray(project.cursor_remotes) && project.cursor_remotes[0] ? project.cursor_remotes[0].id : '';
            assignProjectCursorRemotes(project, [
              normalizeRemoteRow(
                preserveRemoteHookTunnelFields(project, [
                  { id: keepId || undefined, host: legacy.host, projects_root: legacy.projects_root },
                ])[0],
                { generateId: true }
              ),
            ]);
          }
        }
      }
      const nextWorkspaces = parseCursorWorkspaces(body);
      if (nextWorkspaces !== undefined) {
        project.cursor_workspaces = nextWorkspaces;
      }
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    storage.save();
    res.json(project);
  });

  app.delete('/api/projects/:id', (req, res) => {
    const state = storage.getState();
    const idx = state.projects.findIndex((p) => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Project not found' });
    state.projects.splice(idx, 1);
    renumber(state.projects);
    storage.save();
    res.json({ ok: true });
  });

  app.post('/api/projects/reorder', (req, res) => {
    const { ids, items } = req.body || {};
    const reorderItems = Array.isArray(items)
      ? items
      : Array.isArray(ids)
        ? ids.map((id) => ({ id }))
        : null;
    if (!reorderItems) return res.status(400).json({ error: 'ids or items must be an array' });
    const state = storage.getState();
    if (reorderItems.length !== state.projects.length) {
      return res.status(400).json({ error: 'ids/items length does not match project count' });
    }
    const byId = new Map(state.projects.map((p) => [p.id, p]));
    const reordered = [];
    const seenIds = new Set();
    for (const item of reorderItems) {
      const id = typeof item === 'string' ? item : item?.id;
      if (typeof id !== 'string') return res.status(400).json({ error: 'Each reorder item needs an id' });
      if (seenIds.has(id)) return res.status(400).json({ error: `Duplicate project id: ${id}` });
      seenIds.add(id);
      const p = byId.get(id);
      if (!p) return res.status(400).json({ error: `Unknown project id: ${id}` });
      if (typeof item === 'object' && item && hasOwn(item, 'is_backlog')) {
        p.is_backlog = !!item.is_backlog;
      }
      reordered.push(p);
    }
    state.projects = reordered;
    renumber(state.projects);
    storage.save();
    res.json({ ok: true });
  });

  app.post('/api/projects/:id/tasks', (req, res) => {
    const project = findProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { 
      text, 
      is_agent, 
      is_task_backlog,
      id,
      status,
      waiting_since,
      watch_tracking,
      cursor_tracking,
      order,
      created_at,
      completed_at,
      insert_at_index
    } = req.body || {};
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required' });
    }
    const task = {
      id: id || taskId(),
      text: text.trim(),
      status: status || 'todo',
      is_agent: !!is_agent,
      is_task_backlog: !!is_task_backlog,
      waiting_since: waiting_since !== undefined ? waiting_since : null,
      watch_tracking: watch_tracking !== undefined ? watch_tracking : null,
      cursor_tracking: cursor_tracking !== undefined ? cursor_tracking : null,
      focus_items: [],
      focus_commands: [],
      order: typeof order === 'number' ? order : project.tasks.length,
      created_at: created_at || nowIso(),
      completed_at: completed_at !== undefined ? completed_at : null,
    };
    try {
      const body = req.body || {};
      if (hasOwn(body, 'focus_items') || hasOwn(body, 'focus_commands')) {
        setTaskFocusState(task, parseFocusPayload(body));
      }
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (typeof insert_at_index === 'number' && insert_at_index >= 0 && insert_at_index <= project.tasks.length) {
      project.tasks.splice(insert_at_index, 0, task);
    } else {
      project.tasks.push(task);
    }
    renumber(project.tasks);
    storage.save();
    res.status(201).json(task);
  });

  app.patch('/api/projects/:id/tasks/:taskId', (req, res) => {
    const project = findProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const task = findTask(project, req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const { text, status, is_agent, is_task_backlog } = req.body || {};
    if (text !== undefined) {
      if (typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'text must be a non-empty string' });
      }
      task.text = text.trim();
    }
    if (status !== undefined) {
      if (!VALID_STATUSES.has(status)) {
        return res.status(400).json({ error: `status must be one of ${[...VALID_STATUSES].join(', ')}` });
      }
      applyTaskStatusChange(task, status);
    }
    if (is_agent !== undefined) {
      task.is_agent = !!is_agent;
    }
    if (is_task_backlog !== undefined) {
      task.is_task_backlog = !!is_task_backlog;
    }
    if (hasOwn(req.body || {}, 'focus_items') || hasOwn(req.body || {}, 'focus_commands')) {
      try {
        setTaskFocusState(task, parseFocusPayload(req.body || {}));
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }
    storage.save();
    res.json(task);
  });

  app.delete('/api/projects/:id/tasks/:taskId', (req, res) => {
    const project = findProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const idx = project.tasks.findIndex((t) => t.id === req.params.taskId);
    if (idx === -1) return res.status(404).json({ error: 'Task not found' });
    project.tasks.splice(idx, 1);
    renumber(project.tasks);
    storage.save();
    res.json({ ok: true });
  });

  app.post('/api/projects/:id/tasks/reorder', (req, res) => {
    const project = findProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { ids } = req.body || {};
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids must be an array' });
    if (ids.length !== project.tasks.length) {
      return res.status(400).json({ error: 'ids length does not match task count' });
    }
    const byId = new Map(project.tasks.map((t) => [t.id, t]));
    const reordered = [];
    for (const id of ids) {
      const t = byId.get(id);
      if (!t) return res.status(400).json({ error: `Unknown task id: ${id}` });
      reordered.push(t);
    }
    project.tasks = reordered;
    renumber(project.tasks);
    storage.save();
    res.json({ ok: true });
  });

  app.post('/api/projects/:id/focus', async (req, res) => {
    const project = findProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    normalizeProjectShape(project);
    if (project.workspace_commands.length === 0) {
      return res.json({ ok: false, error: 'No workspace launch target set' });
    }
    const result = await runFocusCommands(project.workspace_commands);
    res.json(result);
  });

  app.post('/api/projects/:id/tasks/:taskId/focus', async (req, res) => {
    const project = findProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const task = findTask(project, req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    normalizeTaskShape(task);
    if (task.focus_commands.length === 0) {
      return res.json({ ok: false, error: 'No task focus target set' });
    }
    const result = await runFocusCommands(normalizeTaskFocusCommandsForRun(task.focus_commands));
    res.json(result);
  });

  app.post('/api/projects/:id/workspace', async (req, res) => {
    const project = findProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    normalizeProjectShape(project);
    if (project.workspace_commands.length === 0) {
      return res.json({ ok: false, error: 'No workspace launch target set' });
    }
    const result = await runFocusCommands(project.workspace_commands);
    res.json(result);
  });

  app.use(express.static(path.join(__dirname, 'public')));

  app.use((err, req, res, _next) => {
    console.error('[server] error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  });

  return { app, browserChatStore, remoteHookTunnelManager };
}

async function main() {
  await storage.load();
  normalizeStateShape();
  const port = await findPort(DEFAULT_PORT);
  await storage.writeConfig({ port, host: HOST, started_at: nowIso(), pid: process.pid });

  const { app, browserChatStore, remoteHookTunnelManager } = buildApp(port);
  restorePersistedRemoteHookTunnels(storage.getState(), remoteHookTunnelManager, port);
  const remoteHookOffsets = new Map();
  const remoteGeminiHookDebugOffsets = new Map();
  const localAgyCliLogOffsets = new Map();
  const remoteAgyCliLogOffsets = new Map();
  const localAgyCliPermissionOffsets = new Map();
  const localAgyCliLogPermissionOffsets = new Map();
  const remoteAgyCliPermissionOffsets = new Map();
  const remoteAgyCliLogPermissionOffsets = new Map();
  const localAgyAppCancelState = new Map();
  const localAgyAppPermissionState = new Map();
  const localAgyAppLanguageServerCancelState = {};
  const localAgyAppPermissionSinceMs = Date.now();
  const localAgyAppCancelSinceMs = Date.now();
  const localCursorRendererPermissionProbe = createRendererPermissionProbe();
  const localCursorAgentExecPermissionProbe = createAgentExecPermissionProbe({
    rendererProbe: localCursorRendererPermissionProbe,
  });
  try {
    await localCursorRendererPermissionProbe.init();
    await localCursorAgentExecPermissionProbe.init();
  } catch (err) {
    console.warn('[server] Cursor permission probe init failed:', err.message || String(err));
  }

  const applyGeminiCancelSnapshot = async ({ conversationId, remoteHost = '', overridePendingGate = false }) => {
    if (!conversationId) return 0;
    const sid = normalizeSessionId(conversationId);
    if (sid) {
      const appHasPendingPermission =
        !overridePendingGate && !remoteHost
          ? (await agyCliSessionHasPendingPermission(sid)) || (await agyAppSessionHasPendingPermission(sid))
          : false;
      if (
        shouldDeferGeminiCancelForPendingGate({
          conversationId: sid,
          remoteHost,
          overridePendingGate,
          snapshots: geminiHookStore.listSnapshots(),
          appHasPendingPermission,
        })
      ) {
        return 0;
      }
    }
    const result = geminiHookStore.ingestEvent(agyAppCancelHookBody(conversationId, { remoteHost }));
    if (!result.ok || !result.snapshot) return 0;
    const completed = applyGeminiHookCompletion(
      () => storage.getState(),
      (task) => {
        completeWatchTask(task);
      },
      result.snapshot,
      geminiHookApplyOptions()
    );
    if (completed > 0) await storage.save();
    return completed;
  };

  const pickRecentLocalAgyAppConversation = (notBeforeMs = 0) => {
    const snaps = geminiHookStore
      .listSnapshots()
      .filter((snap) => {
        if (!snap || snap.remote_host || snap.agy_agent_kind !== 'app') return false;
        if (!snap.session_id) return false;
        const updatedMs = Date.parse(snap.updated_at || '') || 0;
        return !notBeforeMs || updatedMs >= notBeforeMs;
      });
    snaps.sort((a, b) => (Date.parse(b.updated_at || '') || 0) - (Date.parse(a.updated_at || '') || 0));
    return snaps[0]?.session_id || '';
  };

  const applyLocalAgyAppPermissionSignals = async (events) => {
    let localGeminiCompleted = 0;
    for (const signal of events || []) {
      const body = agyAppSignalToGeminiHookBody(signal);
      if (body) hookEventLog.push('gemini', body); // DB-derived local app permission — tap for recorder/debug parity
      const result = body ? geminiHookStore.ingestEvent(body) : null;
      if (result?.ok && result.snapshot) {
        localGeminiCompleted += applyGeminiHookCompletion(
          () => storage.getState(),
          (task) => {
            completeWatchTask(task);
          },
          result.snapshot,
          geminiHookApplyOptions()
        );
      }
    }
    if (localGeminiCompleted > 0) await storage.save();
  };
  // The cursor renderer-permission decision now lives in lib/cursor_renderer_watch.js
  // so the signal-replay verifier can drive the real code against recorded events.
  const applyLocalCursorRendererPermissionEvents = (events) =>
    applyCursorRendererPermissionEvents(storage.getState(), events, {
      cursorHookStore,
      applyTaskStatusChange,
      nowIso,
    });
  const applyLocalCursorRendererPendingPermissions = () => {
    const pendingEvents = [
      ...(typeof localCursorRendererPermissionProbe.getPendingPermissionEvents === 'function'
        ? localCursorRendererPermissionProbe.getPendingPermissionEvents()
        : []),
      ...(typeof localCursorAgentExecPermissionProbe.getPendingPermissionEvents === 'function'
        ? localCursorAgentExecPermissionProbe.getPendingPermissionEvents()
        : []),
    ];
    if (!pendingEvents.length) return 0;
    return applyLocalCursorRendererPermissionEvents(pendingEvents);
  };
  const pollRemoteHookLogs = async () => {
    try {
      // Poll renderer probe first so activeComposerByLogPath is current for the exec probe.
      const rendererEvents = await localCursorRendererPermissionProbe.pollOnce();
      // Propagate generation_ended to clear stale exec probe pending entries.
      const execGenEndedClears = [];
      for (const ev of rendererEvents) {
        if (ev.type === 'generation_ended' && ev.conversation_id) {
          const cleared = localCursorAgentExecPermissionProbe.clearForConversation(
            ev.conversation_id,
            'generation_ended'
          );
          if (cleared) execGenEndedClears.push(cleared);
        }
      }
      const execEvents = await localCursorAgentExecPermissionProbe.pollOnce();
      const allEvents = [...rendererEvents, ...execGenEndedClears, ...execEvents];
      const cursorRendererChanged =
        applyLocalCursorRendererPermissionEvents(allEvents) +
        applyLocalCursorRendererPendingPermissions();
      if (cursorRendererChanged > 0) await storage.save();
    } catch {
      // Keep polling despite transient local Cursor renderer log errors.
    }
    try {
      const out = await readLocalAgyCliCancelSignals(localAgyCliLogOffsets);
      let localGeminiCompleted = 0;
      for (const signal of out.events || []) {
        if (!signal?.conversationId) continue;
        localGeminiCompleted += await applyGeminiCancelSnapshot({
          conversationId: signal.conversationId,
          overridePendingGate: true,
        });
      }
      if (localGeminiCompleted > 0) await storage.save();
    } catch {
      // Keep polling despite local log read errors.
    }
    try {
      const out = await readLocalAgyCliDbPermissionSignals(localAgyCliPermissionOffsets);
      await applyLocalAgyAppPermissionSignals(out.events);
    } catch {
      // Keep polling despite local agy CLI DB read errors.
    }
    try {
      // The DB poll above is lossy/laggy for a fast-answered gate: the status=9 "requested" row is
      // overwritten with the grant inside one ~1s poll window, so the request edge is never seen
      // (read_file gates especially auto-resolve fast). agy-cli also writes an append-only
      // "Surfacing tool confirmation: …" request line (and "Responding … stepIdx=N" grant) to its
      // cli-*.log the instant a gate surfaces — one per real gate, repaint-proof and step-indexed.
      // Read those additively so a gate the DB drops or lags is still surfaced as needs-input. Same
      // conversion + apply path (agyAppSignalToGeminiHookBody maps the permission_requested/_granted
      // kinds), and a gate both sources see is idempotent in the hook store (pending stays
      // pending/clears once). Separate offset map from the cancel reader so the two log scans don't
      // consume each other's bytes.
      const out = await readLocalAgyCliPermissionSignals(localAgyCliLogPermissionOffsets);
      await applyLocalAgyAppPermissionSignals(out.events);
    } catch {
      // Keep polling despite local agy CLI log read errors.
    }
    try {
      const out = await readLocalAgyAppPermissionSignals(localAgyAppPermissionState, {
        sinceMs: localAgyAppPermissionSinceMs,
      });
      await applyLocalAgyAppPermissionSignals(out.events);
    } catch {
      // Keep polling despite local app DB read errors.
    }
    try {
      const out = await readLocalAgyAppCancelSignals(localAgyAppCancelState, {
        sinceMs: localAgyAppCancelSinceMs,
      });
      for (const signal of out.events || []) {
        await applyGeminiCancelSnapshot({
          conversationId: signal.conversationId,
          overridePendingGate: signal.kind === 'context_canceled_by_user' || signal.kind === 'cancel_in_progress',
        });
      }
    } catch {
      // Keep polling despite local app cancel DB/WAL read errors.
    }
    try {
      const out = await readLocalAgyAppLanguageServerCancelSignals(localAgyAppLanguageServerCancelState);
      for (const signal of out.events || []) {
        if (signal.kind === 'stop_hook_executing') continue;
        const conversationId =
          signal.conversationId ||
          pickRecentLocalAgyAppConversation(Date.now() - 120_000);
        if (!conversationId) continue;
        await applyGeminiCancelSnapshot({
          conversationId,
          overridePendingGate: signal.kind === 'cancel_in_progress',
        });
      }
    } catch {
      // Keep polling despite local app language_server cancel read errors.
    }
    const state = storage.getState();
    for (const project of state.projects || []) {
      const remotes =
        Array.isArray(project.cursor_remotes) && project.cursor_remotes.length
          ? project.cursor_remotes
          : project.cursor_remote?.host
            ? [project.cursor_remote]
            : [];
      for (const remote of remotes) {
        if (!remote?.host) continue;
        let cfg;
        try {
          cfg = assertValidRemoteSource(remote);
        } catch {
          continue;
        }
        const key = `${cfg.host}::${cfg.projects_root}`;
        const currentOffset = remoteHookOffsets.get(key) || 0;
        try {
          const out = await readRemoteHookEvents(cfg, { offset: currentOffset, limit: 50 });
          remoteHookOffsets.set(key, out.offset || currentOffset);
          for (const event of out.events || []) {
            const body = {
              ...event,
              event_name: event.event_name || event.hook_event_name,
              source: 'ssh',
              host: cfg.host,
              projects_root: cfg.projects_root,
            };
            // Remote hooks are polled (not POSTed to /event), so tap them here too — the
            // signal recorder reads the raw-tap and would otherwise miss remote done/cancel.
            hookEventLog.push('cursor', body);
            cursorHookStore.ingestEvent(body);
          }
        } catch {
          // Keep polling despite transient ssh errors.
        }
        try {
          const geminiHookKey = `${cfg.host}::agy-hook-debug`;
          const geminiHookOffset = remoteGeminiHookDebugOffsets.get(geminiHookKey) || 0;
          const geminiHookOut = await readRemoteGeminiHookDebugEvents(cfg, {
            offset: geminiHookOffset,
            limit: 80,
            runSsh,
          });
          remoteGeminiHookDebugOffsets.set(geminiHookKey, geminiHookOut.offset || geminiHookOffset);
          if ((geminiHookOut.events || []).length) await refreshGeminiSubAgentCacheForHost(cfg.host, runSsh);
          for (const event of geminiHookOut.events || []) {
            const body = {
              ...event,
              event_name: event.event_name || event.hook_event_name,
              remote_host: cfg.host,
              source_kind: 'hook',
            };
            hookEventLog.push('gemini', body); // polled, not POSTed to /event — tap for the recorder
            geminiHookStore.ingestEvent(body);
          }
        } catch {
          // Keep polling despite transient remote agy hook-debug read errors.
        }
        try {
          const cancelKey = cfg.host;
          const cancelOffsets = remoteAgyCliLogOffsets.get(cancelKey) || new Map();
          remoteAgyCliLogOffsets.set(cancelKey, cancelOffsets);
          const out = await readRemoteAgyCliCancelSignals(cfg, cancelOffsets);
          let remoteGeminiCompleted = 0;
          for (const signal of out.events || []) {
            if (!signal?.conversationId) continue;
            remoteGeminiCompleted += await applyGeminiCancelSnapshot({
              conversationId: signal.conversationId,
              remoteHost: cfg.host,
              overridePendingGate: true,
            });
          }
          if (remoteGeminiCompleted > 0) await storage.save();
        } catch {
          // Keep polling despite transient remote agy CLI log errors.
        }
        try {
          const permissionKey = cfg.host;
          const permissionOffsets = remoteAgyCliPermissionOffsets.get(permissionKey) || new Map();
          remoteAgyCliPermissionOffsets.set(permissionKey, permissionOffsets);
          const out = await readRemoteAgyCliDbPermissionSignals(cfg, permissionOffsets, { runSsh });
          await refreshGeminiSubAgentCacheForHost(cfg.host, runSsh);
          let remoteGeminiCompleted = 0;
          for (const signal of out.events || []) {
            const body = agyAppSignalToGeminiHookBody({ ...signal, remoteHost: cfg.host });
            if (body) hookEventLog.push('gemini', body);
            const result = body ? geminiHookStore.ingestEvent(body) : null;
            if (result?.ok && result.snapshot) {
              remoteGeminiCompleted += applyGeminiHookCompletion(
                () => storage.getState(),
                (task) => {
                  completeWatchTask(task);
                },
                result.snapshot,
                geminiHookApplyOptions()
              );
            }
          }
          if (remoteGeminiCompleted > 0) await storage.save();
        } catch {
          // Keep polling despite transient remote agy CLI permission DB errors.
        }
        try {
          // Remote parity for the local log-line permission read: the remote DB poll above misses a
          // fast-answered gate (status=9 row overwritten within a poll), so additively read the remote
          // agy CLI log gate lines ("Surfacing tool confirmation: … at step N") over ssh and surface a
          // dropped gate as needs-input. Same conversion + apply path as the remote DB signals; a gate
          // both sources see is idempotent in the hook store. Separate offset map from the cancel reader.
          const logPermissionKey = cfg.host;
          const logPermissionOffsets = remoteAgyCliLogPermissionOffsets.get(logPermissionKey) || new Map();
          remoteAgyCliLogPermissionOffsets.set(logPermissionKey, logPermissionOffsets);
          const out = await readRemoteAgyCliPermissionSignals(cfg, logPermissionOffsets, { runSsh });
          let remoteGeminiCompleted = 0;
          for (const signal of out.events || []) {
            const body = agyAppSignalToGeminiHookBody({ ...signal, remoteHost: cfg.host });
            if (body) hookEventLog.push('gemini', body);
            const result = body ? geminiHookStore.ingestEvent(body) : null;
            if (result?.ok && result.snapshot) {
              remoteGeminiCompleted += applyGeminiHookCompletion(
                () => storage.getState(),
                (task) => {
                  completeWatchTask(task);
                },
                result.snapshot,
                geminiHookApplyOptions()
              );
            }
          }
          if (remoteGeminiCompleted > 0) await storage.save();
        } catch {
          // Keep polling despite transient remote agy CLI permission log errors.
        }

      }
    }
  };
  const poller = createWatchPoller({
    getState: () => storage.getState(),
    save: () => storage.save(),
    applyTaskStatusChange,
    findBrowserChatSnapshot: (provider, conversation_id) =>
      browserChatStore.findSnapshot(provider, conversation_id),
    getCursorCompletionHint: (cursorTracking) => cursorHookStore.getCompletionHintForTracking(cursorTracking),
    getCursorConversationSnapshot: (cursorTracking) =>
      cursorHookStore.getConversationSnapshotForTracking(cursorTracking),
    isCursorRendererPermissionPending: (cursorTracking) =>
      localCursorRendererPermissionProbe.isPermissionPendingForWatch(cursorTracking) ||
      localCursorAgentExecPermissionProbe.isPermissionPendingForWatch(cursorTracking),
    // cursor-CLI config-eval permission gate (lib/cursor_cli_permission.js). Returns the
    // visible (debounced) pending snapshot for a tracked conversation, or null. Only CLI runs
    // ever arm it, so IDE watches get null here and keep using the renderer/agent-exec probes.
    getCursorPermissionPendingHint: (cursorTracking) => {
      const conv = cursorTracking?.conversation_id || cursorTracking?.run_id || '';
      const snap = conv ? cursorCliPermissionTracker.getVisiblePending(conv) : null;
      if (!snap) return null;
      return {
        conversation_id: snap.conversation_id,
        gate: 'permission',
        detail: snap.pending_detail,
        event_name: 'preToolUse',
        updated_at: new Date(snap.armed_at_ms).toISOString(),
      };
    },
    // Resume predicate for a watch paused on a cursor-CLI permission gate: true while still
    // pending (don't resume), false once the matching after-hook/next-tool/stop resolved it.
    isCursorCliPermissionPending: (cursorTracking) => {
      const conv = cursorTracking?.conversation_id || cursorTracking?.run_id || '';
      return conv ? cursorCliPermissionTracker.isPending(conv) : false;
    },
    // cursor question gate via the chat store.db (lib/cursor_chat_db.js). Returns true while the
    // conversation head is a pending AskQuestion asked AFTER linked_at — the sole question-open
    // signal for cursor-cli (the transcript AskQuestion row is delayed until after the answer).
    // Local runs read the local store.db synchronously; ssh runs read the REMOTE store.db over ssh via
    // a background-refreshed cache (the hint is sync, so a cold miss returns false and the next poll
    // picks up the cached pending state) — cursor-cli runs the agent headless on the remote.
    getCursorChatDbQuestionHint: (cursorTracking) => {
      if (!cursorTracking) return false;
      const conv = cursorTracking.conversation_id || cursorTracking.run_id || '';
      if (!conv) return false;
      const sinceMs = Date.parse(cursorTracking.linked_at || '') || 0;
      if (cursorTracking.source === 'ssh') {
        const host = cursorTracking.host || cursorTracking.remote_host || '';
        if (!host) return false;
        const key = `${host}\0${conv}`;
        const cached = cursorChatDbRemoteCache.get(key);
        if (!cached || Date.now() - cached.at >= CURSOR_CHATDB_REMOTE_TTL_MS) {
          scheduleRemoteCursorChatDbRefresh(key, host, conv, sinceMs);
        }
        return cached ? cached.pending : false;
      }
      return cursorChatDbReader.pendingAskQuestion(conv, { sinceMs });
    },
    // Positive resume signal for a cursor-cli question gate: AskQuestion recorded in the transcript
    // after the pause (written only after the user answers).
    getCursorTranscriptAskQuestionRecordedSince: (cursorTracking, options = {}) =>
      cursorTranscriptAskQuestionRecordedSince(cursorTracking, options),
    shouldCompleteCursorWatch: (cursorTracking, options = {}) =>
      cursorWatchShouldClearSince(cursorTracking, options),
    shouldCompleteRemoteCursorWatch: (cursorTracking, options = {}) =>
      cursorWatchShouldClearSince(cursorTracking, options),
    shouldCancelCursorWatchFromTranscript: async (cursorTracking, options = {}) => {
      const raw = await readCursorTranscriptText(cursorTracking, options);
      return cursorTranscriptCancelSince(raw, cursorTracking.linked_at);
    },
    shouldCancelRemoteCursorWatchFromTranscript: async (cursorTracking, options = {}) => {
      const raw = await readCursorTranscriptText(cursorTracking, options);
      return cursorTranscriptCancelSince(raw, cursorTracking.linked_at);
    },
    getClaudeCompletionHint: (ideTracking) => claudeHookStore.getCompletionHintForTracking(ideTracking),
    isClaudeStopDebouncePending: (ideTracking) => claudeHookStore.isStopDebouncePending(ideTracking),
    getClaudeHookActivityHint: (ideTracking, options) =>
      claudeHookStore.getHookActivityHintForTracking(ideTracking, options),
    isClaudePermissionCompletionHintStale: (ideTracking, hint) =>
      claudePermissionCompletionHintIsStale(ideTracking, hint, {
        remote:
          ideTracking?.source === 'ssh' && ideTracking?.host
            ? { host: ideTracking.host, projects_root: ideTracking.projects_root }
            : undefined,
      }),
    getCodexCompletionHint: (ideTracking) => codexHookStore.getCompletionHintForTracking(ideTracking),
    // Gemini deps come from one shared builder (lib/gemini_poller_deps.js) so the live
    // server and signal replay can't drift. The transcript predicates below are the
    // server's live file/ssh reads; replay injects its in-memory equivalents.
    ...buildGeminiPollerDeps({
      hookStore: geminiHookStore,
      hooksEnabled: true,
      transcriptEnabled: true,
      primaryDoneOnly: AGY_PRIMARY_DONE_ONLY,
      subAgentIds: geminiCollectSubAgentIds,
      transcriptCancelLocal: (ideTracking) =>
        ideTracking.transcript_path
          ? geminiTaskCancelledSince(ideTracking.transcript_path, ideTracking.linked_at)
          : false,
      transcriptCancelRemote: (ideTracking) => {
        const projectsRoot = typeof ideTracking.projects_root === 'string' ? ideTracking.projects_root.trim() : '';
        if (!ideTracking.transcript_path || !ideTracking.host || !projectsRoot) return false;
        return remoteGeminiTaskCancelledSince(
          {
            host: ideTracking.host,
            projects_root: ideTracking.projects_root,
          },
          ideTracking.transcript_path,
          ideTracking.linked_at
        );
      },
      transcriptDoneLocal: (ideTracking) =>
        ideTracking.transcript_path
          ? geminiTaskCompletedSince(ideTracking.transcript_path, ideTracking.linked_at)
          : false,
      transcriptDoneRemote: (ideTracking) => {
        const projectsRoot = typeof ideTracking.projects_root === 'string' ? ideTracking.projects_root.trim() : '';
        if (!ideTracking.transcript_path || !ideTracking.host || !projectsRoot) return false;
        const remote = {
          host: ideTracking.host,
          projects_root: projectsRoot,
        };
        return remoteGeminiTaskCompletedSince(remote, ideTracking.transcript_path, ideTracking.linked_at);
      },
    }),
    // Resume detection for paused (needs-input) coding-agent watches (local + ssh transcripts).
    shouldResumeCodexWatch: (ideTracking) => {
      if (!ideTracking.transcript_path) return null;
      if (ideTracking.source === 'ssh') {
        const projectsRoot =
          typeof ideTracking.projects_root === 'string' ? ideTracking.projects_root.trim() : '';
        if (!ideTracking.host || !projectsRoot) return null;
        return remoteCodexWatchActiveGenerationSince(
          { host: ideTracking.host, projects_root: projectsRoot },
          ideTracking.transcript_path
        );
      }
      return codexWatchActiveGenerationSince(ideTracking.transcript_path);
    },
    shouldResumeClaudeWatch: (ideTracking) => {
      if (!ideTracking.transcript_path) return null;
      if (ideTracking.source === 'ssh') {
        const projectsRoot =
          typeof ideTracking.projects_root === 'string' ? ideTracking.projects_root.trim() : '';
        if (!ideTracking.host || !projectsRoot) return null;
        return remoteClaudeWatchActiveGenerationSince(
          { host: ideTracking.host, projects_root: projectsRoot },
          ideTracking.transcript_path
        );
      }
      return claudeWatchActiveGenerationSince(ideTracking.transcript_path);
    },
    shouldResumeClaudeCoworkWatch: (ideTracking) =>
      coworkWatchActiveGenerationSince(ideTracking.audit_path || ideTracking.transcript_path),
    onIdeAgentWatchComplete: (ideTracking) => {
      // Synthesize a Stop event so the hook store snapshot is marked done even if the
      // remote Stop hook POST never arrived (e.g. curl --max-time 1 timed out on cancel).
      if (ideTracking.provider === 'claude' && (ideTracking.session_id || ideTracking.transcript_path)) {
        claudeHookStore.ingestEvent({
          event_name: 'Stop',
          session_id: ideTracking.session_id || '',
          transcript_path: ideTracking.transcript_path || '',
          remote_host: ideTracking.host || '',
        });
      } else if (ideTracking.provider === 'codex' && (ideTracking.session_id || ideTracking.transcript_path)) {
        codexHookStore.ingestEvent({
          event_name: 'Stop',
          session_id: ideTracking.session_id || '',
          transcript_path: ideTracking.transcript_path || '',
          remote_host: ideTracking.host || '',
        });
      }
    },
    shouldCompleteCodexWatch: (ideTracking) =>
      codexWatchShouldClearSince(ideTracking.transcript_path, ideTracking.linked_at),
    shouldCompleteRemoteCodexWatch: (ideTracking) => {
      const projectsRoot = typeof ideTracking.projects_root === 'string' ? ideTracking.projects_root.trim() : '';
      if (!ideTracking.host || !projectsRoot) return false;
      return remoteCodexWatchShouldClearSince(
        {
          host: ideTracking.host,
          projects_root: projectsRoot,
        },
        ideTracking.transcript_path,
        ideTracking.linked_at
      );
    },
    shouldCompleteClaudeWatch: (ideTracking) => shouldCompleteClaudeWatchFromTranscript(ideTracking),
    shouldClaudePausedWatchCancel: (ideTracking, pausedAtIso) =>
      claudePausedWatchShouldCancel(ideTracking, pausedAtIso),
    shouldCompleteRemoteClaudeWatch: (ideTracking) => {
      const projectsRoot = typeof ideTracking.projects_root === 'string' ? ideTracking.projects_root.trim() : '';
      if (!ideTracking.host || !projectsRoot) return false;
      return remoteClaudeWatchCompletionSince(
        {
          host: ideTracking.host,
          projects_root: projectsRoot,
        },
        ideTracking.transcript_path,
        ideTracking.linked_at
      );
    },
    shouldCompleteClaudeCoworkWatch: (ideTracking) =>
      coworkTurnCompletedSince(ideTracking.audit_path || ideTracking.transcript_path, ideTracking.linked_at),
  });
  poller.start();
  setInterval(() => {
    pollRemoteHookLogs().catch(() => {});
  }, 1000).unref();
  pollRemoteHookLogs().catch(() => {});

  if (serverExposesNonLocalBind()) {
    console.warn(
      `[server] WARNING: HOST=${HOST} exposes Orchestra to your network. ` +
        'Use 127.0.0.1 for normal local-only use. Non-loopback clients must send X-Orchestra-App-Token.'
    );
  }

  const server = app.listen(port, HOST, () => {
    console.log(`[server] Orchestra listening on http://${HOST}:${port}`);
  });

  const shutdown = async (signal) => {
    console.log(`[server] received ${signal}, shutting down`);
    try {
      await storage.flush();
    } catch (err) {
      console.error('[server] flush failed:', err);
    }
    remoteHookTunnelManager.stopAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[server] fatal error:', err);
    process.exit(1);
  });
}

module.exports = {
  buildApp,
  DEFAULT_PORT,
  HOST,
  APP_TOKEN,
  serverExposesNonLocalBind,
  requireAppTokenWhenExposed,
  CONFIG_PATHS,
  _test: {
    annotateGeminiPermissionState,
    shouldDeferGeminiCancelForPendingGate,
    listGeminiRunsFromHookStore,
    geminiSubAgentSessionIdSet,
    localAgySnapshotTranscriptPath,
  },
};
