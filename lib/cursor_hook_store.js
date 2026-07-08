const crypto = require('crypto');
const path = require('path');
const { workspacePathToProjectSlug, DEFAULT_MAX_RUNS } = require('./cursor_tracker');
const { resolveCursorRemoteEntry } = require('./cursor_remotes');
const { isUserRequestInterruptedPreview } = require('./request_interrupted_preview');
const {
  anyLocalPathUnderConfiguredRoots,
  anyPosixPathUnderConfiguredRoots,
} = require('./workspace_scope');

const VALID_EVENTS = new Set([
  'beforeSubmitPrompt',
  'sessionStart',
  'stop',
  'sessionEnd',
  'subagentStart',
  'subagentStop',
]);
const SUBAGENT_EVENTS = new Set(['subagentStart', 'subagentStop']);
const TERMINAL_SNAPSHOT_TTL_MS = 15 * 60 * 1000;
const WEAK_ACTIVE_SNAPSHOT_TTL_MS = 60 * 1000;
const ACTIVE_PROMPT_SNAPSHOT_TTL_MS = Number.POSITIVE_INFINITY;

function normalizeConversationId(id) {
  if (typeof id !== 'string') return '';
  return id.trim().toLowerCase();
}

function normalizeTranscriptPath(transcriptPath) {
  if (typeof transcriptPath !== 'string') return '';
  const trimmed = transcriptPath.trim();
  if (!trimmed) return '';
  return path.resolve(trimmed);
}

function normalizeWorkspaceRoots(workspaceRoots) {
  if (!Array.isArray(workspaceRoots)) return [];
  return workspaceRoots.filter((p) => typeof p === 'string').map((p) => p.trim()).filter(Boolean);
}

function buildWorkspaceSlugs(workspaceRoots) {
  return normalizeWorkspaceRoots(workspaceRoots)
    .map((root) => workspacePathToProjectSlug(root, 'local'))
    .filter(Boolean);
}

function normalizePromptPreview(input) {
  if (typeof input !== 'string') return '';
  const one = input.replace(/\s+/g, ' ').trim();
  if (!one) return '';
  const words = one.split(' ');
  return words.length <= 10 ? one : `${words.slice(0, 10).join(' ')}…`;
}

/** Cursor synthetic user rows when a turn is interrupted (optionally "for tool use"). */
function isCursorUserRequestInterruptedPreview(input) {
  return isUserRequestInterruptedPreview(input);
}

function normalizeGenerationId(id) {
  if (typeof id !== 'string') return '';
  return id.trim().toLowerCase();
}

/** Rewind re-submits the same prompt with a new generation_id after stop. */
function isNewGenerationAfterCompletion(existing, generationId) {
  const prev = normalizeGenerationId(existing?.generation_id);
  const next = normalizeGenerationId(generationId);
  return !!prev && !!next && prev !== next;
}

function runStateFromPromptPreview(promptPreview, existing = null, generationId = '') {
  if (isCursorUserRequestInterruptedPreview(promptPreview)) {
    return {
      completion_hint: false,
      completion_status: '',
      terminal_hint: true,
      generating: false,
    };
  }
  if (existing?.completion_hint && samePromptPreview(existing, promptPreview)) {
    if (isNewGenerationAfterCompletion(existing, generationId)) {
      return {
        completion_hint: false,
        completion_status: '',
        terminal_hint: false,
        generating: !!promptPreview,
      };
    }
    return {
      completion_hint: true,
      completion_status: existing.completion_status || 'completed',
      terminal_hint: true,
      generating: false,
    };
  }
  return {
    completion_hint: false,
    completion_status: '',
    terminal_hint: false,
    generating: !!promptPreview,
  };
}

// 'error' added 2026-07-07 (cursor-cli sapd ssh residual, backlog #11): a stop with status=error
// ends the generation — no further work is coming from it — so it must produce a completion hint
// or a watch whose trailing generation errors (observed on the headless-ssh notification-spawned
// trailing gen, 2/2) never clears at all. Unlike aborted/cancelled it is NOT a cancel: the watch
// clears as done, and the continuation gate holds it exactly like a completed stop (an error stop
// mid-continuation, e.g. a parent erroring while its Task child still works, must not early-clear)
// — see cursorCompletedHintContinuationGate in lib/watch_tracker.js.
const CURSOR_TERMINAL_COMPLETION_STATUSES = new Set(['completed', 'aborted', 'cancelled', 'error']);

function terminalCompletionStatus(status) {
  if (typeof status !== 'string') return '';
  return status.trim().toLowerCase();
}

function completionHintFromEvent(eventName, body) {
  if (eventName === 'stop') {
    return CURSOR_TERMINAL_COMPLETION_STATUSES.has(terminalCompletionStatus(body.status));
  }
  if (eventName === 'sessionEnd') {
    return CURSOR_TERMINAL_COMPLETION_STATUSES.has(terminalCompletionStatus(body.final_status));
  }
  return false;
}

function samePromptPreview(existing, nextPreview) {
  return !!existing?.last_user_preview && !!nextPreview && existing.last_user_preview === nextPreview;
}

function normalizeSubagentId(id) {
  return normalizeConversationId(id);
}

function subagentTaskPreview(body) {
  return normalizePromptPreview(body.task || body.description || '');
}

function isNonTerminalParentHookEvent(eventName, runState) {
  if (eventName === 'subagentStart') return true;
  if (eventName === 'beforeSubmitPrompt' || eventName === 'sessionStart') {
    return !!runState?.generating;
  }
  return false;
}

function nonTerminalHookFieldsForEvent(eventName, body, existing, runState, updatedAt) {
  if (!isNonTerminalParentHookEvent(eventName, runState)) {
    return {
      last_non_terminal_hook_at: existing?.last_non_terminal_hook_at || '',
      last_non_terminal_generation_id: existing?.last_non_terminal_generation_id || '',
    };
  }
  const generationId =
    typeof body.generation_id === 'string' && body.generation_id
      ? body.generation_id
      : existing?.generation_id || '';
  return {
    last_non_terminal_hook_at: updatedAt,
    last_non_terminal_generation_id: generationId,
  };
}

function snapshotKeyForEvent(eventName, body, conversationId, transcriptPath) {
  if (SUBAGENT_EVENTS.has(eventName)) {
    const subagentId = normalizeSubagentId(body.subagent_id);
    if (subagentId) return `subagent:${subagentId}`;
    const agentTranscript = normalizeTranscriptPath(body.agent_transcript_path);
    if (agentTranscript) {
      const base = path.basename(agentTranscript, '.jsonl');
      if (base) return `subagent:${base}`;
    }
    const parentId = normalizeConversationId(body.parent_conversation_id || body.conversation_id);
    if (parentId) return `subagent:${parentId}:${eventName}`;
  }
  return conversationId || transcriptPath;
}

function runStateForEvent(eventName, body, existing = null) {
  if (eventName === 'beforeSubmitPrompt' || eventName === 'sessionStart') {
    const promptPreview = normalizePromptPreview(body.prompt_preview || body.prompt || '');
    const generationId = eventName === 'beforeSubmitPrompt' ? body.generation_id || '' : '';
    const state = runStateFromPromptPreview(promptPreview, existing, generationId);
    // Cursor often fires sessionStart right after beforeSubmitPrompt without a prompt.
    // Do not clear an active run the prompt hook just opened.
    if (
      eventName === 'sessionStart' &&
      !promptPreview &&
      existing?.generating === true &&
      !existing?.terminal_hint &&
      !existing?.completion_hint
    ) {
      return {
        completion_hint: false,
        completion_status: '',
        terminal_hint: false,
        generating: true,
      };
    }
    return state;
  }
  if (eventName === 'subagentStart') {
    return {
      completion_hint: false,
      completion_status: '',
      terminal_hint: false,
      generating: true,
    };
  }
  if (eventName === 'subagentStop') {
    return {
      // Subagent completion is separate from the parent conversation watch.
      completion_hint: false,
      completion_status: typeof body.status === 'string' ? body.status : '',
      terminal_hint: true,
      generating: false,
    };
  }
  if (eventName === 'stop') {
    return {
      completion_hint: completionHintFromEvent(eventName, body),
      completion_status: typeof body.status === 'string' ? body.status : '',
      terminal_hint: true,
      generating: false,
    };
  }
  if (eventName === 'sessionEnd') {
    return {
      completion_hint: completionHintFromEvent(eventName, body),
      completion_status: typeof body.final_status === 'string' ? body.final_status : '',
      terminal_hint: true,
      generating: false,
    };
  }
  return {
    completion_hint: existing?.completion_hint || false,
    completion_status: existing?.completion_status || '',
    terminal_hint: existing?.terminal_hint || false,
    generating: existing?.generating || false,
  };
}

function createCursorHookStore(options = {}) {
  const token = options.token || crypto.randomBytes(24).toString('hex');
  const terminalTtlMs =
    Number.isInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : TERMINAL_SNAPSHOT_TTL_MS;
  const weakActiveTtlMs =
    Number.isInteger(options.weakActiveTtlMs) && options.weakActiveTtlMs > 0
      ? options.weakActiveTtlMs
      : WEAK_ACTIVE_SNAPSHOT_TTL_MS;
  const activePromptTtlMs =
    Number.isFinite(options.activePromptTtlMs) && options.activePromptTtlMs > 0
      ? options.activePromptTtlMs
      : ACTIVE_PROMPT_SNAPSHOT_TTL_MS;
  /** @type {Map<string, object>} */
  const byKey = new Map();

  function verifyToken(req) {
    const header = typeof req.get === 'function' ? req.get('x-cursor-hook-token') : null;
    const bodyToken = req.body && typeof req.body === 'object' ? req.body.token : undefined;
    const q = req.query && typeof req.query === 'object' ? req.query.token : undefined;
    const t = header || bodyToken || q;
    return typeof t === 'string' && t === token;
  }

  function prune(nowMs = Date.now()) {
    for (const [key, value] of byKey.entries()) {
      const ts = Date.parse(value.updated_at || '') || 0;
      if (!ts) {
        byKey.delete(key);
        continue;
      }
      const hasPrompt = !!String(value.last_user_preview || '').trim();
      const ttlMs =
        value.generating && hasPrompt
          ? activePromptTtlMs
          : value.generating || (!hasPrompt && !value.terminal_hint && !value.completion_hint)
            ? weakActiveTtlMs
            : terminalTtlMs;
      if (Number.isFinite(ttlMs) && nowMs - ts > ttlMs) byKey.delete(key);
    }
  }

  function ingestEvent(body, opts = {}) {
    // Honor the replay's virtual clock so a resumed gate watch can reach done deterministically — a
    // real wall-clock stamp collapses to the same instant as a virtual-time linked_at and gets
    // dropped by the completion-hint linked_at guard. Mirrors the gemini hook store.
    const stampMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    const eventName =
      typeof body.event_name === 'string'
        ? body.event_name.trim()
        : typeof body.hook_event_name === 'string'
          ? body.hook_event_name.trim()
          : '';
    if (!VALID_EVENTS.has(eventName)) {
      return {
        ok: false,
        error:
          'event_name must be one of beforeSubmitPrompt, sessionStart, stop, sessionEnd, subagentStart, subagentStop',
      };
    }
    const parentConversationId = normalizeConversationId(body.parent_conversation_id);
    const conversationId = normalizeConversationId(body.conversation_id) || parentConversationId;
    const transcriptPath = normalizeTranscriptPath(body.transcript_path);
    const agentTranscriptPath = normalizeTranscriptPath(body.agent_transcript_path);
    const subagentId = normalizeSubagentId(body.subagent_id);
    if (SUBAGENT_EVENTS.has(eventName)) {
      if (!subagentId && !parentConversationId && !conversationId && !agentTranscriptPath) {
        return {
          ok: false,
          error: 'subagent_id, parent_conversation_id, conversation_id, or agent_transcript_path is required',
        };
      }
    } else if (!conversationId && !transcriptPath) {
      return { ok: false, error: 'conversation_id or transcript_path is required' };
    }
    const key = snapshotKeyForEvent(eventName, body, conversationId, transcriptPath);
    const existing = byKey.get(key) || null;
    const workspaceRoots = normalizeWorkspaceRoots(body.workspace_roots);
    const workspaceSlugs = buildWorkspaceSlugs(workspaceRoots);
    const promptPreview = normalizePromptPreview(body.prompt_preview || body.prompt || '');
    const subagentPreview = subagentTaskPreview(body);
    const runState = runStateForEvent(eventName, body, existing);
    const durationMs = Number.parseInt(String(body.duration_ms ?? ''), 10);
    const updatedAt = new Date(stampMs).toISOString();
    const nonTerminalHookFields = nonTerminalHookFieldsForEvent(
      eventName,
      body,
      existing,
      runState,
      updatedAt
    );
    const next = {
      source: body.source === 'ssh' ? 'ssh' : existing?.source || 'local',
      host: typeof body.host === 'string' ? body.host : existing?.host || '',
      projects_root: typeof body.projects_root === 'string' ? body.projects_root : existing?.projects_root || '',
      snapshot_key: key,
      event_name: eventName,
      conversation_id: conversationId || existing?.conversation_id || '',
      parent_conversation_id: parentConversationId || existing?.parent_conversation_id || conversationId || '',
      transcript_path: transcriptPath || existing?.transcript_path || '',
      agent_transcript_path: agentTranscriptPath || existing?.agent_transcript_path || '',
      subagent_id: subagentId || existing?.subagent_id || '',
      subagent_type: typeof body.subagent_type === 'string' ? body.subagent_type : existing?.subagent_type || '',
      subagent_task: subagentPreview || existing?.subagent_task || '',
      is_parallel_worker:
        typeof body.is_parallel_worker === 'boolean'
          ? body.is_parallel_worker
          : existing?.is_parallel_worker ?? null,
      tool_call_id: typeof body.tool_call_id === 'string' ? body.tool_call_id : existing?.tool_call_id || '',
      duration_ms: Number.isFinite(durationMs) ? durationMs : existing?.duration_ms ?? null,
      subagent_summary:
        typeof body.summary === 'string' ? body.summary.slice(0, 500) : existing?.subagent_summary || '',
      subagent_spawn_count: existing?.subagent_spawn_count || 0,
      composer_mode: typeof body.composer_mode === 'string' ? body.composer_mode : existing?.composer_mode || '',
      // CLI (CalVer) vs IDE (SemVer) discriminator — the turn_ended completed-stop gate is CLI-only.
      cursor_version: typeof body.cursor_version === 'string' ? body.cursor_version : existing?.cursor_version || '',
      model: typeof body.model === 'string' ? body.model : existing?.model || '',
      generation_id: typeof body.generation_id === 'string' ? body.generation_id : existing?.generation_id || '',
      workspace_roots: workspaceRoots.length ? workspaceRoots : existing?.workspace_roots || [],
      workspace_slugs: workspaceSlugs.length ? workspaceSlugs : existing?.workspace_slugs || [],
      last_user_preview: isCursorUserRequestInterruptedPreview(promptPreview)
        ? existing?.last_user_preview || promptPreview
        : promptPreview || subagentPreview || existing?.last_user_preview || '',
      completion_hint: runState.completion_hint,
      completion_status: runState.completion_status,
      terminal_hint: runState.terminal_hint,
      generating: runState.generating,
      updated_at: updatedAt,
      last_non_terminal_hook_at:
        nonTerminalHookFields.last_non_terminal_hook_at || existing?.last_non_terminal_hook_at || '',
      last_non_terminal_generation_id:
        nonTerminalHookFields.last_non_terminal_generation_id ||
        existing?.last_non_terminal_generation_id ||
        '',
    };
    byKey.set(key, next);
    if (eventName === 'subagentStart') {
      const parentId = normalizeConversationId(body.parent_conversation_id || body.conversation_id);
      if (parentId) {
        const parentExisting = byKey.get(parentId) || null;
        const parentUpdatedAt = new Date(stampMs).toISOString();
        const parentGenerationId =
          typeof body.generation_id === 'string' && body.generation_id
            ? body.generation_id
            : parentExisting?.generation_id || '';
        byKey.set(parentId, {
          ...(parentExisting || {}),
          snapshot_key: parentId,
          conversation_id: parentId,
          parent_conversation_id: parentId,
          transcript_path:
            parentExisting?.transcript_path ||
            transcriptPath ||
            normalizeTranscriptPath(body.transcript_path) ||
            '',
          composer_mode:
            typeof body.composer_mode === 'string' && body.composer_mode
              ? body.composer_mode
              : parentExisting?.composer_mode || next.composer_mode || '',
          subagent_spawn_count: (parentExisting?.subagent_spawn_count || 0) + 1,
          workspace_roots: workspaceRoots.length ? workspaceRoots : parentExisting?.workspace_roots || [],
          workspace_slugs: workspaceSlugs.length ? workspaceSlugs : parentExisting?.workspace_slugs || [],
          completion_hint: parentExisting?.completion_hint || false,
          completion_status: parentExisting?.completion_status || '',
          terminal_hint: parentExisting?.terminal_hint || false,
          generating: true,
          event_name: parentExisting?.event_name || '',
          updated_at: parentUpdatedAt,
          last_non_terminal_hook_at: parentUpdatedAt,
          last_non_terminal_generation_id: parentGenerationId,
        });
      }
    }
    prune();
    return { ok: true, snapshot: next };
  }

  function listSnapshots() {
    prune();
    return [...byKey.values()].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  }

  function listRunsForProject(project, options = {}) {
    const activeOnly = !!options.activeOnly;
    const workspaces = Array.isArray(project?.cursor_workspaces) ? project.cursor_workspaces : [];
    const localWorkspacePaths = workspaces
      .filter((w) => w && w.source !== 'ssh' && typeof w.workspace_path === 'string')
      .map((w) => w.workspace_path.trim())
      .filter(Boolean);
    const sshWorkspacePathsByHost = new Map();
    for (const w of workspaces) {
      if (!w || w.source !== 'ssh' || typeof w.workspace_path !== 'string') continue;
      let cfg;
      try {
        cfg = resolveCursorRemoteEntry(project, w.remote_id);
      } catch {
        continue;
      }
      const host = cfg.host;
      const trimmed = w.workspace_path.trim();
      if (!host || !trimmed) continue;
      if (!sshWorkspacePathsByHost.has(host)) sshWorkspacePathsByHost.set(host, []);
      sshWorkspacePathsByHost.get(host).push(trimmed);
    }
    const remotes = project?.cursor_remotes?.length
      ? project.cursor_remotes
      : project?.cursor_remote?.host
        ? [project.cursor_remote]
        : [];
    const configuredRemoteHosts = new Set(remotes.map((r) => r && r.host).filter(Boolean));
    const out = [];
    for (const snap of listSnapshots()) {
      if (String(snap.snapshot_key || '').startsWith('subagent:')) continue;
      if (activeOnly && snap.generating !== true) continue;
      if (activeOnly && isCursorUserRequestInterruptedPreview(snap.last_user_preview)) continue;
      if (snap.source === 'ssh') {
        if (!configuredRemoteHosts.size) continue;
        const snapHost = snap.host || '';
        if (!configuredRemoteHosts.has(snapHost)) continue;
        const configuredPaths = sshWorkspacePathsByHost.get(snapHost) || [];
        if (sshWorkspacePathsByHost.size) {
          if (!configuredPaths.length) continue;
          const roots = normalizeWorkspaceRoots(snap.workspace_roots);
          if (!anyPosixPathUnderConfiguredRoots(configuredPaths, roots)) continue;
        }
      }
      if (snap.source === 'local' && localWorkspacePaths.length) {
        const roots = normalizeWorkspaceRoots(snap.workspace_roots);
        if (!anyLocalPathUnderConfiguredRoots(localWorkspacePaths, roots)) continue;
      }
      const slug = (snap.workspace_slugs && snap.workspace_slugs[0]) || '';
      out.push({
        source: snap.source || 'local',
        host: snap.host || '',
        projects_root: snap.projects_root || '',
        run_id: snap.conversation_id || path.basename(snap.transcript_path || '', '.jsonl') || '',
        transcript_path: snap.transcript_path || '',
        project_slug: slug,
        mtime_ms: Date.parse(snap.updated_at || '') || 0,
        user_preview: snap.last_user_preview || '',
        conversation_id: snap.conversation_id || '',
        hook_hint: true,
        completion_hint: !!snap.completion_hint,
        terminal_hint: !!snap.terminal_hint,
        generating: !!snap.generating,
        updated_at: snap.updated_at,
      });
    }
    out.sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0));
    return out.slice(0, DEFAULT_MAX_RUNS);
  }

  function getCompletionHintForTracking(cursorTracking) {
    if (!cursorTracking) return null;
    prune();
    const transcriptPath = normalizeTranscriptPath(cursorTracking.transcript_path);
    const conversationId = normalizeConversationId(cursorTracking.conversation_id);
    const linkedAtMs = Date.parse(cursorTracking.linked_at || '') || 0;
    for (const snap of byKey.values()) {
      if (!snap.completion_hint) continue;
      if (String(snap.snapshot_key || '').startsWith('subagent:')) continue;
      const snapUpdatedMs = Date.parse(snap.updated_at || '') || 0;
      if (linkedAtMs && snapUpdatedMs && snapUpdatedMs <= linkedAtMs) continue;
      if (transcriptPath && snap.transcript_path && transcriptPath === normalizeTranscriptPath(snap.transcript_path)) {
        return snap;
      }
      if (conversationId && snap.conversation_id && conversationId === normalizeConversationId(snap.conversation_id)) {
        return snap;
      }
    }
    return null;
  }

  function getConversationSnapshotForTracking(cursorTracking) {
    if (!cursorTracking) return null;
    prune();
    const conversationId = normalizeConversationId(cursorTracking.conversation_id);
    const transcriptPath = normalizeTranscriptPath(cursorTracking.transcript_path);
    if (conversationId && byKey.has(conversationId)) {
      return byKey.get(conversationId);
    }
    for (const snap of byKey.values()) {
      if (String(snap.snapshot_key || '').startsWith('subagent:')) continue;
      if (conversationId && snap.conversation_id === conversationId) return snap;
      if (transcriptPath && snap.transcript_path === transcriptPath) return snap;
    }
    return null;
  }

  return {
    getToken: () => token,
    verifyToken,
    ingestEvent,
    listSnapshots,
    listRunsForProject,
    getCompletionHintForTracking,
    getConversationSnapshotForTracking,
    prune,
  };
}

module.exports = {
  createCursorHookStore,
  normalizeConversationId,
  isCursorUserRequestInterruptedPreview,
};
