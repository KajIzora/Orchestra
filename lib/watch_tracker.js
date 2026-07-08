const {
  normalizeCursorTracking,
  defaultCursorTracking,
  defaultRemoteCursorTracking,
  cursorWatchShouldClearSince,
  resolveCursorTranscriptPath,
  DEFAULT_POLL_MS,
} = require('./cursor_tracker');
const {
  activateCursorMultitaskSubagentWatch,
  shouldDeferCursorHookCompletionForMultitask,
  cursorMultitaskSubagentWatchShouldClear,
} = require('./cursor_multitask_subagent');
const { assertValidRemoteSource } = require('./remote_cursor_tracker');
const {
  isLocalPidAlive,
  probeRemotePidAlive,
  readLocalDockerLogs,
  readRemoteDockerLogs,
  assertValidDockerContainerName,
  normalizeLogContainsPatterns,
  dockerLogsMatchAnyPattern,
} = require('./process_tracker');
const {
  defaultNotificationTracking,
  normalizeNotificationTracking,
  findMatchingProviderNotification,
} = require('./notification_center');
const { normalizeBrowserChatTracking, shouldCompleteBrowserChatWatch } = require('./browser_chat');
const { createPausedTranscriptWatcher } = require('./paused_transcript_watch');
const { isCodexQuestionGateEvent, codexSubagentIsOpen } = require('./codex_hook_store');

function defaultProcessTracking(pid, processMeta = {}) {
  const iso = new Date().toISOString();
  let completion = null;
  if (processMeta.completion && typeof processMeta.completion === 'object') {
    const mode = processMeta.completion.mode === 'log_contains' ? 'log_contains' : '';
    if (mode === 'log_contains') {
      const patterns = normalizeLogContainsPatterns(processMeta.completion);
      let dockerContainer = '';
      try {
        dockerContainer = assertValidDockerContainerName(processMeta.completion.docker_container);
      } catch {
        dockerContainer = '';
      }
      if (dockerContainer) {
        completion = {
          mode: 'log_contains',
          patterns,
          docker_container: dockerContainer,
        };
      }
    }
  }
  return {
    kind: 'process',
    source: 'local',
    pid,
    pgid: processMeta.pgid || null,
    command: processMeta.command || '',
    cwd: processMeta.cwd || '',
    tty: processMeta.tty || '',
    linked_at: iso,
    last_seen_at: null,
    last_error: null,
    completion,
  };
}

function defaultRemoteProcessTracking(pid, processMeta = {}, remote) {
  const cfg = assertValidRemoteSource(remote);
  return {
    ...defaultProcessTracking(pid, processMeta),
    source: 'ssh',
    host: cfg.host,
    projects_root: cfg.projects_root,
  };
}

function normalizeWatchTracking(watchTracking, cursorTracking = null) {
  if (watchTracking && typeof watchTracking === 'object') {
    if (watchTracking.kind === 'process') {
      let completion = null;
      if (watchTracking.completion && typeof watchTracking.completion === 'object') {
        if (watchTracking.completion.mode === 'log_contains') {
          try {
            const dockerContainer = assertValidDockerContainerName(watchTracking.completion.docker_container);
            const patterns = normalizeLogContainsPatterns(watchTracking.completion);
            completion = {
              mode: 'log_contains',
              patterns,
              docker_container: dockerContainer,
            };
          } catch {
            completion = null;
          }
        }
      }
      return {
        ...watchTracking,
        kind: 'process',
        source: watchTracking.source === 'ssh' ? 'ssh' : 'local',
        last_error: watchTracking.last_error || null,
        completion,
      };
    }
    if (watchTracking.kind === 'cursor') {
      const ct = normalizeCursorTracking(watchTracking);
      if (!ct) return null;
      return { ...ct, kind: 'cursor' };
    }
    if (watchTracking.kind === 'notification') {
      return normalizeNotificationTracking(watchTracking);
    }
    if (watchTracking.kind === 'browser_chat') {
      return normalizeBrowserChatTracking(watchTracking);
    }
    if (watchTracking.kind === 'ide_agent') {
      const rawProvider = ['claude', 'claude_cowork', 'codex', 'gemini', 'gemini_cli'].includes(watchTracking.provider)
        ? watchTracking.provider
        : '';
      const provider = rawProvider === 'gemini_cli' ? 'gemini' : rawProvider;
      if (!provider) return null;
      const source = watchTracking.source === 'ssh' ? 'ssh' : 'local';
      if (provider === 'claude_cowork' && source === 'ssh') return null;
      const session_id = typeof watchTracking.session_id === 'string' ? watchTracking.session_id.trim() : '';
      const transcript_path =
        typeof watchTracking.transcript_path === 'string' ? watchTracking.transcript_path.trim() : '';
      const audit_path = typeof watchTracking.audit_path === 'string' ? watchTracking.audit_path.trim() : '';
      if (!session_id && !transcript_path && !audit_path) return null;
      let remote = null;
      if (source === 'ssh') {
        try {
          remote = assertValidRemoteSource({
            host: watchTracking.host,
            projects_root: watchTracking.projects_root,
          });
        } catch {
          return null;
        }
      }
      return {
        ...watchTracking,
        kind: 'ide_agent',
        provider,
        source,
        host: remote?.host || null,
        projects_root: remote?.projects_root || null,
        session_id,
        transcript_path,
        audit_path,
        title: typeof watchTracking.title === 'string' ? watchTracking.title : '',
        workspace_path: typeof watchTracking.workspace_path === 'string' ? watchTracking.workspace_path : '',
        last_user_preview: typeof watchTracking.last_user_preview === 'string' ? watchTracking.last_user_preview : '',
        state_location: typeof watchTracking.state_location === 'string' ? watchTracking.state_location : '',
        log_path: typeof watchTracking.log_path === 'string' ? watchTracking.log_path : '',
        log_request_id: typeof watchTracking.log_request_id === 'string' ? watchTracking.log_request_id : '',
        log_started_at: typeof watchTracking.log_started_at === 'string' ? watchTracking.log_started_at : '',
        log_done_at: typeof watchTracking.log_done_at === 'string' ? watchTracking.log_done_at : '',
        linked_at: watchTracking.linked_at || new Date().toISOString(),
        completion_hint_at: watchTracking.completion_hint_at || null,
        last_seen_at: watchTracking.last_seen_at || null,
        last_error: watchTracking.last_error || null,
      };
    }
  }
  const legacy = normalizeCursorTracking(cursorTracking);
  if (!legacy) return null;
  return { ...legacy, kind: 'cursor' };
}

// Claude hook attention reasons that mean "stopped, waiting on you" vs a plain finish.
function isPermissionAttentionReason(reason) {
  return reason === 'permission_request' || reason === 'permission_prompt';
}

function markHumanGateWatchClear(watchTracking, gate, hint, nowIso) {
  if (!watchTracking || !gate) return;
  watchTracking.clear_reason = gate === 'question' ? 'question_pending' : 'permission_pending';
  watchTracking.clear_gate = gate;
  watchTracking.clear_signal_at = hint?.updated_at || nowIso;
  watchTracking.clear_event_name = hint?.event_name || '';
  // The gated tool's id (hook-driven pauses only). Lets a later PreToolUse for a DIFFERENT tool
  // count as post-pause work (chained gates from concurrent sub-agents) without the gate's own
  // PreToolUse ever reading as a resume.
  watchTracking.clear_tool_use_id = hint?.tool_use_id || '';
}

// The agent's turn was cancelled/aborted/interrupted (not a real finish). The watch
// clears straight back to "monitor" — no green "done", no amber "needs input".
function markCancelledWatchClear(watchTracking) {
  if (!watchTracking) return;
  watchTracking.clear_cancelled = true;
  watchTracking.clear_reason = 'cancelled';
  watchTracking.clear_gate = null;
}

// Marker left on a task when an auto-watch completes, so the UI can show the
// green "done" state until the user acknowledges it (clicks the task or the ×).
function finishedMarker(watchTracking) {
  const wt = watchTracking || {};
  const needsInput = !!wt.clear_gate;
  return {
    at: new Date().toISOString(),
    kind: wt.kind || '',
    provider: wt.provider || '',
    source: wt.source || '',
    host: wt.host || '',
    // True when the agent stopped blocked on you (a question or permission prompt)
    // rather than truly finishing — drives the coral "needs input" pill.
    needs_input: needsInput,
    // When it paused, used as the loop-guard cutoff for resume detection.
    paused_at: needsInput ? new Date().toISOString() : '',
  };
}

// Record a completed watch on a task. "Done" (no gate) discards the watcher;
// "needs input" (gate set) retains it in paused_watch_tracking so the resume poll
// can re-arm tracking once the agent starts generating again.
function recordWatchFinished(task, wt) {
  // Cancelled turn → straight back to "monitor": no done marker, no paused watcher. The
  // tracking BINDING is retained (completed_watch_tracking, marked clear_cancelled) so a fresh
  // generation under the same conversation can re-arm cancelled→working — without it a cancel
  // that turns out to be an agy suspend/reschedule (or a user resuming a cancelled thread) is
  // structurally impossible to re-track (the 2026-07-06 background-checkin false-cancel proof).
  if (wt && wt.clear_cancelled) {
    task.watch_finished = null;
    task.paused_watch_tracking = null;
    task.completed_watch_tracking = { ...wt };
    return;
  }
  task.watch_finished = finishedMarker(wt);
  task.paused_watch_tracking = wt && wt.clear_gate ? wt : null;
  task.completed_watch_tracking = wt ? { ...wt } : null;
}

// True when an active-generation result represents a *new* burst of generation that
// started after the watch paused (the loop-guard against re-detecting the stale signal).
function generatedAfter(gen, pausedAtMs) {
  if (!gen || gen.generating !== true) return false;
  const ts =
    Date.parse(gen.start_signal_at || gen.last_activity_at || gen.updated_at || '') || 0;
  return ts > pausedAtMs;
}

// Resume detection for a paused (needs-input) coding-agent watch.
async function shouldResumeIdeAgentWatch(watchTracking, deps = {}, pausedAtMs = 0) {
  if (!watchTracking || watchTracking.kind !== 'ide_agent') return false;
  if (watchTracking.provider === 'gemini' || watchTracking.provider === 'gemini_cli') {
    if (
      (watchTracking.clear_gate === 'permission' || watchTracking.clear_gate === 'question') &&
      typeof deps.getGeminiGateResolutionHint === 'function'
    ) {
      const resolved = deps.getGeminiGateResolutionHint(watchTracking, {
        gate: watchTracking.clear_gate,
        pausedAtMs,
      });
      if (resolved) return true;
    }
    const hint =
      typeof deps.getGeminiActiveGenerationHint === 'function'
        ? deps.getGeminiActiveGenerationHint(watchTracking)
        : null;
    // For a gate pause, never resume on stale "generating" while the gate is STILL pending — the
    // in-flight tool that triggered the gate reads as active-after-pause and would otherwise flip the
    // watch needs-input -> working -> needs-input repeatedly during the wait. The gate-resolution
    // hint above is the normal resume path; this active-generation fallback (the safety net for a
    // missed resolution signal) only applies once the gate is no longer pending.
    if (watchTracking.clear_gate === 'permission' && hint && hint.permission_pending) return false;
    if (watchTracking.clear_gate === 'question' && hint && hint.question_pending) return false;
    return generatedAfter(hint, pausedAtMs);
  }
  if (watchTracking.provider === 'claude') {
    // Gate-pause resume is HOOK-driven and gate-precise: the gated tool's PostToolUse (now captured)
    // fires when the permission/question prompt is answered, re-arming the watch at the answer. A fresh
    // UserPromptSubmit (a new prompt) also re-arms.
    if (typeof deps.getClaudeHookActivityHint === 'function') {
      const hookHint = deps.getClaudeHookActivityHint(watchTracking, { pausedAtMs });
      if (generatedAfter(hookHint, pausedAtMs)) return true;
    }
    // GATE-PAUSE GUARD (closes the former KNOWN GAP): do NOT fall through to the transcript
    // active-generation resume while a gate is open. The in-flight tool that triggered the gate reads
    // as "generating", which used to resume the watch every tick before the answer (the
    // needs-input<->working bounce that collapsed later gates in a multi-gate run). Claude pauses ONLY
    // on gates, so the PostToolUse hook above is the re-arm; otherwise hold needs-input until that hook
    // or the terminal Stop (done) clears it. See docs/internal/gate-scenarios-tracking.md.
    if (watchTracking.clear_gate === 'permission' || watchTracking.clear_gate === 'question') return false;
  }
  if (watchTracking.provider === 'codex' && typeof deps.getCodexHookActivityHint === 'function') {
    // Hook-driven resume: a generating codex hook (post-gate PostToolUse) after the pause flips the
    // watch back to working — mirrors the live server's applyCodexHookCompletion/shouldResumePausedCodexWatch.
    // Provided only by the replay deps (the live server resumes via its own hook POST path), so this is
    // a no-op for live. Codex is gate-safe here (unlike the claude note above): its PermissionRequest is
    // the latest snapshot while a gate is pending, so no stale generating leaks in before the answer.
    const hookHint = deps.getCodexHookActivityHint(watchTracking, { pausedAtMs });
    if (generatedAfter(hookHint, pausedAtMs)) return true;
  }
  let fn = null;
  if (watchTracking.provider === 'codex') fn = deps.shouldResumeCodexWatch;
  else if (watchTracking.provider === 'claude') fn = deps.shouldResumeClaudeWatch;
  else if (watchTracking.provider === 'claude_cowork') fn = deps.shouldResumeClaudeCoworkWatch;
  if (typeof fn !== 'function') return false;
  const gen = await fn(watchTracking);
  return generatedAfter(gen, pausedAtMs);
}

function hintIsAfterPaused(hint, pausedAtMs) {
  if (!hint || !pausedAtMs) return !!hint;
  const hintMs = Date.parse(hint.updated_at || hint.completion_hint_at || '') || 0;
  return hintMs > pausedAtMs;
}

async function finishPausedClaudeWatchIfTerminal(task, watchTracking, deps = {}, pausedAtMs = 0) {
  if (!watchTracking || watchTracking.kind !== 'ide_agent') return false;
  if (watchTracking.provider !== 'claude') return false;
  if (watchTracking.clear_gate !== 'permission') return false;

  const pausedAtIso =
    pausedAtMs > 0
      ? new Date(pausedAtMs).toISOString()
      : typeof watchTracking.clear_signal_at === 'string'
        ? watchTracking.clear_signal_at.trim()
        : '';
  if (!pausedAtIso) return false;

  const fn = deps.shouldClaudePausedWatchCancel;
  if (typeof fn !== 'function') return false;
  const cancelled = await fn(watchTracking, pausedAtIso);
  if (!cancelled) return false;

  const wt = { ...watchTracking };
  markCancelledWatchClear(wt);
  task.last_watch_clear = null;
  recordWatchFinished(task, wt);
  return true;
}

function finishPausedGeminiWatchIfTerminal(task, watchTracking, deps = {}, pausedAtMs = 0) {
  if (!watchTracking || watchTracking.kind !== 'ide_agent') return false;
  if (watchTracking.provider !== 'gemini' && watchTracking.provider !== 'gemini_cli') return false;

  const completionHint =
    typeof deps.getGeminiCompletionHint === 'function'
      ? deps.getGeminiCompletionHint(watchTracking)
      : null;
  if (hintIsAfterPaused(completionHint, pausedAtMs)) {
    const wt = {
      ...watchTracking,
      clear_gate: null,
      clear_reason: null,
      clear_signal_at: null,
      clear_event_name: '',
      completion_hint_at: completionHint.updated_at || new Date().toISOString(),
    };
    task.last_watch_clear = null;
    recordWatchFinished(task, wt);
    return true;
  }

  const cancelHint =
    typeof deps.getGeminiCancelHint === 'function' ? deps.getGeminiCancelHint(watchTracking) : null;
  if (hintIsAfterPaused(cancelHint, pausedAtMs)) {
    const wt = { ...watchTracking };
    markCancelledWatchClear(wt);
    task.last_watch_clear = null;
    recordWatchFinished(task, wt);
    return true;
  }

  return false;
}

// Sub-agent hold for a codex DONE clear: hooks know which sub-agents of this session are (or may
// still be) working (lib/codex_hook_store getSubagentActivity); the parent transcript knows which
// ones have completed (<subagent_notification> — deps.getCodexSubagentNotifiedIds). Hold the done
// while any hook-seen sub-agent is neither notified-complete nor quiet-closed. Sub-agent turns emit
// no Stop hook, so without this the parent's Stop clears the watch while the sub-agent works on
// (the subagent-outlives-parent false clear). Gates and cancel are never held.
async function codexSubagentDoneHoldActive(watchTracking, deps = {}) {
  if (typeof deps.getCodexSubagentActivity !== 'function') return false;
  let agents;
  try {
    agents = deps.getCodexSubagentActivity(watchTracking)?.agents || [];
  } catch {
    return false;
  }
  if (!agents.length) return false;
  let notified = null;
  if (typeof deps.getCodexSubagentNotifiedIds === 'function') {
    try {
      notified = await deps.getCodexSubagentNotifiedIds(watchTracking);
    } catch {
      notified = null;
    }
  }
  const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();
  for (const agent of agents) {
    if (notified && notified.has(agent.agent_id)) continue;
    if (agent.stopped_ms) continue; // SubagentStop hook = hook-native worker end
    // Worker-rollout liveness (getCodexSubagentRolloutStatus → codexAgentRolloutFacts): the worker's
    // own rollout is the only live channel for a HOOKLESS worker (desktop spawn_agent workers fire
    // no hooks, even for tool calls). Its task_complete/turn_aborted closes the worker outright —
    // more precise than hook quiet; recent records / an in-flight call hold it open using the same
    // quiet/in-flight windows the hooks-only view uses.
    let rollout = null;
    if (typeof deps.getCodexSubagentRolloutStatus === 'function') {
      try {
        rollout = await deps.getCodexSubagentRolloutStatus(watchTracking, agent.agent_id);
      } catch {
        rollout = null;
      }
    }
    if (rollout?.found) {
      if (rollout.terminal_ms) continue; // worker finished — closed regardless of hook recency
      if (
        codexSubagentIsOpen(
          { last_ms: rollout.last_record_ms, open_call_count: rollout.open_call ? 1 : 0 },
          nowMs
        )
      ) {
        return true;
      }
      continue; // rollout exists but is stale with no terminal — treat as abandoned, don't hold
    }
    if (codexSubagentIsOpen(agent, nowMs)) return true;
  }
  return false;
}

// A paused codex gate whose agent then finished (a terminal Stop, not the next PermissionRequest)
// clears straight to done — needed when the agent stops right after answering the last gate, so there
// is no intervening "working" generation for the resume path to latch onto. Mirrors
// finishPausedGeminiWatchIfTerminal; the PermissionRequest guard keeps the *next* gate on the resume
// path rather than mis-finishing it as done.
async function finishPausedCodexWatchIfTerminal(task, watchTracking, deps = {}, pausedAtMs = 0) {
  if (!watchTracking || watchTracking.kind !== 'ide_agent') return false;
  if (watchTracking.provider !== 'codex') return false;

  const hint =
    typeof deps.getCodexCompletionHint === 'function' ? deps.getCodexCompletionHint(watchTracking) : null;
  if (hint && hint.event_name !== 'PermissionRequest' && hintIsAfterPaused(hint, pausedAtMs)) {
    const nowIso = new Date(typeof deps.now === 'function' ? deps.now() : Date.now()).toISOString();
    if (await codexSubagentDoneHoldActive(watchTracking, deps)) {
      if (!watchTracking.codex_subagent_held_at) watchTracking.codex_subagent_held_at = nowIso;
      return false;
    }
    const wt = {
      ...watchTracking,
      clear_gate: null,
      clear_reason: null,
      clear_signal_at: null,
      clear_event_name: '',
      // Held-then-released: stamp the release moment, not the stale hint arrival.
      completion_hint_at: watchTracking.codex_subagent_held_at
        ? nowIso
        : hint.updated_at || new Date().toISOString(),
    };
    delete wt.codex_subagent_held_at;
    task.last_watch_clear = null;
    recordWatchFinished(task, wt);
    return true;
  }
  return false;
}

// Safety escape for the continuation hold: if the continuation evidence wedges (e.g. a sub-agent
// transcript never receives its turn_ended), a held watch clears after this window instead of
// hanging. Generous by design — a Task sub-agent can work with NO observable activity (no hooks,
// no transcript/store.db writes) for minutes between the parent's early stop and the wake-up
// generation, so a short escape would recreate the early-clear bug it exists to backstop.
const CURSOR_CONTINUATION_HOLD_MAX_MS = (() => {
  const v = Number.parseInt(process.env.CURSOR_CONTINUATION_HOLD_MAX_MS || '', 10);
  return Number.isFinite(v) && v > 0 ? v : 10 * 60 * 1000;
})();

// Cursor final-turn gate for a completed stop hint. cursor-agent fires `stop` once per
// GENERATION, but a turn can span several generations: a finishing Task sub-agent or a background
// task completing queues a system notification that cursor injects as a synthetic user record,
// starting a new generation (with its own stop) in the same conversation — clearing on the first
// stop is the sub-agent/background early-clear class. The hold decision (open sub-agent
// transcript — sibling dir for the CLI, subagents/ underdir for the IDE — / queued
// system-notification blob / short post-stop settle when continuation machinery was used — see
// lib/cursor_cli_continuation.js) comes from the injectable deps.getCursorCliContinuationHold;
// when it is not wired (older callers, hooks-only replays) the gate fails open to the plain stop
// behavior. Applies to BOTH cursor-cli (CalVer) and Cursor IDE (SemVer) watches — the IDE's
// subagentStop hook is unreliable (observed missing while a sub-agent ran 90s past the parent
// stop), so its hold rides the same transcript-tail check. sessionEnd (process exit) and
// aborted/cancelled stops are never held.
// Returns true when the hint may clear the watch now, false while held.
async function cursorCompletedHintContinuationGate(watchTracking, hint, deps = {}) {
  if (!watchTracking || !hint) return true;
  // aborted/cancelled bypass (cancel semantics — never held). 'error' is GATED like 'completed'
  // (backlog #11, 2026-07-07): an error stop ends its generation and may clear the watch as done,
  // but only once the continuation evidence releases — an error mid-continuation (parent errors
  // while a Task child still works) must hold exactly like a completed stop would.
  if (
    hint.completion_status
    && hint.completion_status !== 'completed'
    && hint.completion_status !== 'error'
  ) return true;
  if (hint.event_name === 'sessionEnd') return true;
  const holdFn = deps.getCursorCliContinuationHold;
  if (typeof holdFn !== 'function') return true;
  let hold = false;
  try {
    hold = !!(await holdFn(watchTracking, hint));
  } catch {
    hold = false;
  }
  if (!hold) {
    watchTracking.continuation_hold = false;
    watchTracking.continuation_hold_at = null;
    return true;
  }
  const heldSinceMs = Date.parse(watchTracking.continuation_hold_at || '') || 0;
  const nowMs = Date.now();
  if (heldSinceMs && nowMs - heldSinceMs > CURSOR_CONTINUATION_HOLD_MAX_MS) {
    watchTracking.continuation_hold = false;
    watchTracking.continuation_hold_at = null;
    return true;
  }
  watchTracking.continuation_hold = true;
  if (!heldSinceMs) watchTracking.continuation_hold_at = new Date(nowMs).toISOString();
  return false;
}

// A paused (needs-input) cursor watch whose agent then terminally finished clears straight to
// done (or cancelled for an aborted stop) — mirrors finishPausedGemini/Codex/ClaudeWatchIfTerminal.
// Needed because shouldResumeCursorWatch never resumes while a completion hint is present: without
// this, a question watch whose answer→finish happened between resume ticks stayed needs-input
// forever (the recorded cursor-cli question gap). The continuation gate keeps a NON-final
// generation stop (sub-agent still working) from mis-finishing an open gate as done.
async function finishPausedCursorWatchIfTerminal(task, watchTracking, deps = {}, pausedAtMs = 0) {
  if (!watchTracking || watchTracking.kind !== 'cursor') return false;
  const hint =
    typeof deps.getCursorCompletionHint === 'function' ? deps.getCursorCompletionHint(watchTracking) : null;
  if (!hint || !hintIsAfterPaused(hint, pausedAtMs)) return false;
  if (hint.completion_status === 'aborted' || hint.completion_status === 'cancelled') {
    const wt = { ...watchTracking };
    markCancelledWatchClear(wt);
    task.last_watch_clear = null;
    recordWatchFinished(task, wt);
    return true;
  }
  if (!(await cursorCompletedHintContinuationGate(watchTracking, hint, deps))) return false;
  const wt = {
    ...watchTracking,
    clear_gate: null,
    clear_reason: null,
    clear_signal_at: null,
    clear_event_name: '',
    completion_hint_at: hint.updated_at || new Date().toISOString(),
  };
  task.last_watch_clear = null;
  recordWatchFinished(task, wt);
  return true;
}

// Resume detection for a paused Cursor watch: renderer permission cleared, the pending
// AskQuestion is no longer pending (the user answered), and no fresh stop hint has landed.
async function shouldResumeCursorWatch(watchTracking, deps = {}) {
  if (!watchTracking) return false;
  if (
    typeof deps.isCursorRendererPermissionPending === 'function' &&
    deps.isCursorRendererPermissionPending(watchTracking)
  ) {
    return false;
  }
  // cursor-CLI config-eval permission gate still pending → stay paused. Only CLI runs ever
  // arm this tracker, so IDE watches are unaffected (the renderer guard above handles those).
  // Once the matching after-hook / next tool resolves the gate, this returns false and the
  // transcript check below resumes the watch.
  if (
    typeof deps.isCursorCliPermissionPending === 'function' &&
    deps.isCursorCliPermissionPending(watchTracking)
  ) {
    return false;
  }
  const hint =
    typeof deps.getCursorCompletionHint === 'function' ? deps.getCursorCompletionHint(watchTracking) : null;
  if (hint) return false;
  const transcriptFn =
    watchTracking.source === 'ssh'
      ? deps.shouldCompleteRemoteCursorWatch || deps.shouldCompleteCursorWatch
      : deps.shouldCompleteCursorWatch;
  if (typeof transcriptFn !== 'function') return false;
  const workspaceSlugs =
    watchTracking.workspace_slugs instanceof Set
      ? watchTracking.workspace_slugs
      : new Set(Array.isArray(watchTracking.workspace_slugs) ? watchTracking.workspace_slugs : []);
  if (watchTracking.clear_gate === 'question') {
    // cursor-cli asymmetric model: chat store.db opens the gate; the transcript AskQuestion row
    // (written only after the answer) is the positive resume signal — never resume on db-clear alone.
    if (typeof deps.getCursorChatDbQuestionHint === 'function') {
      const sinceIso = watchTracking.clear_signal_at || '';
      if (typeof deps.getCursorTranscriptAskQuestionRecordedSince === 'function') {
        return !!(await deps.getCursorTranscriptAskQuestionRecordedSince(watchTracking, { sinceIso }));
      }
      return false;
    }
  }

  const stillBlocked = !!(await transcriptFn(watchTracking, { workspaceSlugs }));
  return !stillBlocked;
}

// Re-arm a paused watch as active tracking: restore the watcher, clear the gate, and
// advance linked_at so the completion check restarts from the resume point (no flip-flop).
function resumeWatchTracking(task, wt, applyTaskStatusChange) {
  wt.clear_gate = null;
  wt.clear_reason = null;
  wt.clear_signal_at = null;
  wt.clear_event_name = null;
  wt.clear_tool_use_id = null;
  // A re-armed watch must not carry a stale cancel marker: recordWatchFinished routes a
  // clear_cancelled tracking through the cancel branch, which would wrongly swallow this
  // watch's NEXT legitimate finish.
  wt.clear_cancelled = false;
  wt.ask_question_hint = false;
  wt.ask_question_hint_at = null;
  wt.hook_completion_hint = false;
  wt.hook_completion_hint_at = null;
  wt.completion_hint_at = null;
  wt.linked_at = new Date().toISOString();
  applyTaskStatusChange(task, 'waiting');
  task.watch_tracking = wt;
  task.cursor_tracking = wt.kind === 'cursor' ? wt : null;
  task.paused_watch_tracking = null;
  task.watch_finished = null;
}

function watchClearInfo(watchTracking) {
  if (!watchTracking?.clear_gate) return null;
  return {
    kind: watchTracking.kind || '',
    provider: watchTracking.provider || '',
    source: watchTracking.source || '',
    host: watchTracking.host || '',
    session_id: watchTracking.session_id || watchTracking.conversation_id || watchTracking.run_id || '',
    transcript_path: watchTracking.transcript_path || '',
    reason: watchTracking.clear_reason || '',
    gate: watchTracking.clear_gate || '',
    event_name: watchTracking.clear_event_name || '',
    signal_at: watchTracking.clear_signal_at || '',
    cleared_at: new Date().toISOString(),
  };
}

async function shouldCompleteProcessWatch(watchTracking, deps = {}) {
  if (!watchTracking || watchTracking.kind !== 'process') return false;
  const pid = Number.isInteger(watchTracking.pid) ? watchTracking.pid : Number.parseInt(watchTracking.pid, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    watchTracking.last_error = 'Invalid PID';
    return false;
  }
  let alive = false;
  if (watchTracking.source === 'ssh') {
    try {
      const remote = assertValidRemoteSource({
        host: watchTracking.host,
        projects_root: watchTracking.projects_root,
      });
      const probe = deps.probeRemotePidAlive || probeRemotePidAlive;
      const pr = await probe(remote, pid);
      if (pr.status === 'unknown') {
        watchTracking.last_error = pr.error || 'Remote PID check inconclusive';
        watchTracking.last_seen_at = new Date().toISOString();
        return false;
      }
      alive = pr.status === 'alive';
    } catch (err) {
      watchTracking.last_error = err.message || String(err);
      return false;
    }
  } else {
    const localPidAlive = deps.isLocalPidAlive || isLocalPidAlive;
    alive = await localPidAlive(pid);
  }
  const completion = watchTracking.completion;
  if (completion && completion.mode === 'log_contains') {
    try {
      const readRemoteLogs = deps.readRemoteDockerLogs || readRemoteDockerLogs;
      const readLocalLogs = deps.readLocalDockerLogs || readLocalDockerLogs;
      const logs =
        watchTracking.source === 'ssh'
          ? await readRemoteLogs(
              {
                host: watchTracking.host,
                projects_root: watchTracking.projects_root,
              },
              completion.docker_container
            )
          : await readLocalLogs(completion.docker_container);
      if (dockerLogsMatchAnyPattern(logs, completion.patterns || normalizeLogContainsPatterns(null))) {
        watchTracking.last_seen_at = new Date().toISOString();
        watchTracking.last_error = null;
        return true;
      }
    } catch (err) {
      watchTracking.last_error = err.message || String(err);
    }
  }
  watchTracking.last_seen_at = new Date().toISOString();
  if (!watchTracking.last_error) watchTracking.last_error = null;
  return !alive;
}

async function inspectNotificationWatch(watchTracking) {
  if (!watchTracking || watchTracking.kind !== 'notification') {
    return { completed: false, consumedRecId: null };
  }
  const result = await findMatchingProviderNotification({
    provider: watchTracking.provider,
    sinceRecId: watchTracking.since_rec_id,
  });
  watchTracking.last_checked_at = new Date().toISOString();
  if (result.error) {
    watchTracking.last_error = result.error;
    return { completed: false, consumedRecId: null };
  }
  watchTracking.last_error = null;
  watchTracking.last_seen_rec_id = result.latestRecId;
  if (!result.matchedEvent) {
    watchTracking.since_rec_id = result.latestRecId;
    return { completed: false, consumedRecId: null };
  }
  return { completed: true, consumedRecId: result.matchedEvent.rec_id };
}

async function shouldCompleteIdeAgentWatch(watchTracking, deps = {}) {
  if (!watchTracking || watchTracking.kind !== 'ide_agent') return false;
  // Honor an injected clock (deps.now) so the replay stamps clear_signal_at / last_seen_at on its
  // virtual clock. This matters for gates detected WITHOUT a hook hint (codex questions, cowork): their
  // clear_signal_at falls back to nowIso, and under the real wall-clock every gate in a fast replay
  // lands in the same millisecond — collapsing the per-gate identity the re-detection guard keys on.
  // Live callers pass no deps.now → real wall-clock, unchanged.
  const nowIso = new Date(typeof deps.now === 'function' ? deps.now() : Date.now()).toISOString();
  if (watchTracking.provider === 'claude') {
    // Primary: Claude Code hook store (Stop, and permission prompts when enabled).
    // Fallback: session JSONL — same as legacy except we skip assistant `end_turn` and
    // `tool_use` so early end_turn lines do not clear the watch before the Stop hook.
    const hint =
      typeof deps.getClaudeCompletionHint === 'function' ? deps.getClaudeCompletionHint(watchTracking) : null;
    if (hint) {
      const permissionStale =
        typeof deps.isClaudePermissionCompletionHintStale === 'function'
          ? await deps.isClaudePermissionCompletionHintStale(watchTracking, hint)
          : false;
      if (!permissionStale) {
        watchTracking.completion_hint_at = hint.updated_at || nowIso;
        watchTracking.last_seen_at = nowIso;
        watchTracking.last_error = null;
        // Instrumentation: this done came from the busy-hold CAP expiring (no task-exit
        // notification ever arrived — eternal task or dead session), not from a completion
        // signal. Persisted on the tracking so production data can tune the cap.
        if (hint.busy_hold_expired) watchTracking.busy_hold_cap_cleared_at = nowIso;
        // Claude stopped because it needs you (permission prompt / AskUserQuestion
        // surfaces as a permission-style Notification), vs a plain Stop = finished.
        if (isPermissionAttentionReason(hint.attention_reason)) {
          markHumanGateWatchClear(watchTracking, 'permission', hint, nowIso);
        }
        return true;
      }
    }
    // A "busy" Stop (running background tasks / pending crons) is held for the debounce window
    // before flipping to done. While pending, keep tracking and skip the transcript-completion
    // fallback so it can't clear early.
    if (typeof deps.isClaudeStopDebouncePending === 'function' && deps.isClaudeStopDebouncePending(watchTracking)) {
      watchTracking.last_seen_at = nowIso;
      watchTracking.last_error = null;
      return false;
    }
    const claudeFn =
      watchTracking.source === 'ssh'
        ? deps.shouldCompleteRemoteClaudeWatch || deps.shouldCompleteClaudeWatch
        : deps.shouldCompleteClaudeWatch;
    if (typeof claudeFn === 'function') {
      // Transcript fallback returns a reason: 'cancelled' (interrupted) or 'done'.
      // Legacy mocks may return a bare boolean (treated as done).
      const result = await claudeFn(watchTracking);
      watchTracking.last_seen_at = nowIso;
      watchTracking.last_error = null;
      if (result === 'cancelled') {
        markCancelledWatchClear(watchTracking);
      }
      return !!result;
    }
    watchTracking.last_seen_at = nowIso;
    watchTracking.last_error = null;
    return false;
  }
  if (watchTracking.provider === 'claude_cowork') {
    const coworkFn = deps.shouldCompleteClaudeCoworkWatch;
    if (typeof coworkFn === 'function') {
      // Reason: 'permission' (tool permission / AskUserQuestion) = needs you; '' / 'done' otherwise.
      const result = await coworkFn(watchTracking);
      watchTracking.last_seen_at = nowIso;
      watchTracking.last_error = null;
      if (result === 'permission' || result === 'question') {
        markHumanGateWatchClear(watchTracking, result, null, nowIso);
      } else if (result === 'cancelled') {
        markCancelledWatchClear(watchTracking);
      }
      return !!result;
    }
    watchTracking.last_seen_at = nowIso;
    watchTracking.last_error = null;
    return false;
  }
  if (watchTracking.provider === 'codex') {
    const hint =
      typeof deps.getCodexCompletionHint === 'function' ? deps.getCodexCompletionHint(watchTracking) : null;
    if (hint) {
      // Codex Stop = finished; PermissionRequest = stopped on a permission gate; a request_user_input
      // PreToolUse = stopped on a question gate (codex fires no PermissionRequest for it).
      if (hint.event_name === 'PermissionRequest') {
        watchTracking.completion_hint_at = hint.updated_at || nowIso;
        watchTracking.last_seen_at = nowIso;
        watchTracking.last_error = null;
        markHumanGateWatchClear(watchTracking, 'permission', hint, nowIso);
        return true;
      }
      if (isCodexQuestionGateEvent(hint.event_name, hint.tool_name)) {
        watchTracking.completion_hint_at = hint.updated_at || nowIso;
        watchTracking.last_seen_at = nowIso;
        watchTracking.last_error = null;
        markHumanGateWatchClear(watchTracking, 'question', hint, nowIso);
        return true;
      }
      // A done hint (Stop) is held while a self-scheduled near-future heartbeat is pending — the
      // agent yielded to its own wakeup, it did not finish. The wake's UserPromptSubmit consumes
      // the heartbeat (hook store) and the DTSTART + grace bound releases if it never comes.
      if (typeof deps.isCodexHeartbeatDoneHoldActive === 'function' && deps.isCodexHeartbeatDoneHoldActive(watchTracking)) {
        if (!watchTracking.codex_heartbeat_held_at) watchTracking.codex_heartbeat_held_at = nowIso;
        watchTracking.last_seen_at = nowIso;
        watchTracking.last_error = null;
        return false;
      }
      // A done hint (Stop) is held while a sub-agent of this session is still working — release
      // comes from the sub-agent's completion notification or the quiet backstop.
      if (!(await codexSubagentDoneHoldActive(watchTracking, deps))) {
        // Held-then-released: the DONE moment is the release (the last sub-agent's finish), not the
        // parent Stop's arrival — the stale hint time would report a done minutes early.
        watchTracking.completion_hint_at = (watchTracking.codex_subagent_held_at || watchTracking.codex_heartbeat_held_at)
          ? nowIso
          : hint.updated_at || nowIso;
        delete watchTracking.codex_subagent_held_at;
        delete watchTracking.codex_heartbeat_held_at;
        watchTracking.last_seen_at = nowIso;
        watchTracking.last_error = null;
        return true;
      }
      if (!watchTracking.codex_subagent_held_at) watchTracking.codex_subagent_held_at = nowIso;
      watchTracking.last_seen_at = nowIso;
      watchTracking.last_error = null;
      return false;
    }
    // A heartbeat wake turn is in flight (the wake consumed the pending heartbeat, no Stop
    // since): a transcript-fallback 'done' would be STALE evidence — the snapshot predates the
    // wake. Skip the fallback this tick; the wake turn's own Stop clears via the hint path.
    if (typeof deps.isCodexHeartbeatWakeActive === 'function' && deps.isCodexHeartbeatWakeActive(watchTracking)) {
      watchTracking.last_seen_at = nowIso;
      watchTracking.last_error = null;
      return false;
    }
    const codexFn =
      watchTracking.source === 'ssh'
        ? deps.shouldCompleteRemoteCodexWatch || deps.shouldCompleteCodexWatch
        : deps.shouldCompleteCodexWatch;
    if (typeof codexFn !== 'function') {
      watchTracking.last_seen_at = nowIso;
      watchTracking.last_error = null;
      return false;
    }
    // Transcript fallback returns a reason: 'permission' / 'question' (needs you) or
    // 'done' (task_complete / turn_aborted). Legacy mocks may return a bare boolean.
    const result = await codexFn(watchTracking);
    watchTracking.last_seen_at = nowIso;
    watchTracking.last_error = null;
    if (result === 'permission' || result === 'question') {
      markHumanGateWatchClear(watchTracking, result, null, nowIso);
    } else if (result === 'cancelled') {
      markCancelledWatchClear(watchTracking);
    } else if (result && (await codexSubagentDoneHoldActive(watchTracking, deps))) {
      // Transcript says done but hook-seen sub-agents (e.g. grandchildren the parent transcript
      // never notifies about) are still active — keep waiting.
      return false;
    }
    return !!result;
  }
  if (watchTracking.provider === 'gemini' || watchTracking.provider === 'gemini_cli') {
    const hint =
      typeof deps.getGeminiCompletionHint === 'function' ? deps.getGeminiCompletionHint(watchTracking) : null;
    if (hint) {
      watchTracking.completion_hint_at = hint.updated_at || nowIso;
      watchTracking.last_seen_at = nowIso;
      watchTracking.last_error = null;
      return true;
    }
    const transcriptCancelFn =
      watchTracking.source === 'ssh'
        ? deps.shouldCompleteRemoteGeminiTranscriptCancelWatch || deps.shouldCompleteGeminiTranscriptCancelWatch
        : deps.shouldCompleteGeminiTranscriptCancelWatch;
    if (typeof transcriptCancelFn === 'function' && watchTracking.transcript_path) {
      const done = await transcriptCancelFn(watchTracking);
      watchTracking.last_seen_at = nowIso;
      watchTracking.last_error = null;
      if (done) {
        watchTracking.completion_hint_at = nowIso;
        markCancelledWatchClear(watchTracking);
        return true;
      }
    }
    const permissionPendingHint =
      typeof deps.getGeminiPermissionPendingHint === 'function'
        ? deps.getGeminiPermissionPendingHint(watchTracking)
        : null;
    if (permissionPendingHint) {
      watchTracking.completion_hint_at = permissionPendingHint.updated_at || nowIso;
      watchTracking.last_seen_at = nowIso;
      watchTracking.last_error = null;
      markHumanGateWatchClear(watchTracking, 'permission', permissionPendingHint, nowIso);
      return true;
    }
    const questionPendingHint =
      typeof deps.getGeminiQuestionPendingHint === 'function'
        ? deps.getGeminiQuestionPendingHint(watchTracking)
        : null;
    if (questionPendingHint) {
      watchTracking.completion_hint_at = questionPendingHint.updated_at || nowIso;
      watchTracking.last_seen_at = nowIso;
      watchTracking.last_error = null;
      markHumanGateWatchClear(watchTracking, 'question', questionPendingHint, nowIso);
      return true;
    }
    const cancelHint =
      typeof deps.getGeminiCancelHint === 'function' ? deps.getGeminiCancelHint(watchTracking) : null;
    if (cancelHint) {
      watchTracking.completion_hint_at = cancelHint.updated_at || nowIso;
      watchTracking.last_seen_at = nowIso;
      watchTracking.last_error = null;
      markCancelledWatchClear(watchTracking);
      return true;
    }
    const agyTranscriptIdleHint =
      typeof deps.getGeminiAgyTranscriptIdleCompletionHint === 'function'
        ? await deps.getGeminiAgyTranscriptIdleCompletionHint(watchTracking)
        : null;
    if (agyTranscriptIdleHint) {
      watchTracking.completion_hint_at = agyTranscriptIdleHint.updated_at || nowIso;
      watchTracking.last_seen_at = nowIso;
      watchTracking.last_error = null;
      return true;
    }
    const activeHint =
      typeof deps.getGeminiActiveGenerationHint === 'function'
        ? deps.getGeminiActiveGenerationHint(watchTracking)
        : null;
    if (activeHint?.generating === true) {
      watchTracking.last_seen_at = nowIso;
      watchTracking.last_error = null;
      return false;
    }
    const geminiFn =
      watchTracking.source === 'ssh'
        ? deps.shouldCompleteRemoteGeminiWatch || deps.shouldCompleteGeminiWatch
        : deps.shouldCompleteGeminiWatch;
    if (typeof geminiFn === 'function') {
      const done = await geminiFn(watchTracking);
      watchTracking.last_seen_at = nowIso;
      watchTracking.last_error = null;
      if (done) {
        watchTracking.completion_hint_at = nowIso;
        return true;
      }
    }
    watchTracking.last_seen_at = nowIso;
    watchTracking.last_error = null;
    return false;
  }
  watchTracking.last_error = 'Unknown ide_agent provider';
  return false;
}

function createWatchPoller(deps) {
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  let timer = null;
  let started = false;
  let tickInFlight = false;
  let tickQueued = false;
  const transcriptWatcher =
    deps.pausedTranscriptWatch === false
      ? null
      : typeof deps.createPausedTranscriptWatcher === 'function'
        ? deps.createPausedTranscriptWatcher({
            onActivity: () => {
              runTick().catch((err) => console.error('[watch_tracker] transcript-triggered tick error:', err));
            },
            debounceMs: deps.pausedTranscriptDebounceMs,
            pollIntervalMs: deps.pausedTranscriptPollMs,
          })
        : createPausedTranscriptWatcher({
            onActivity: () => {
              runTick().catch((err) => console.error('[watch_tracker] transcript-triggered tick error:', err));
            },
            debounceMs: deps.pausedTranscriptDebounceMs,
            pollIntervalMs: deps.pausedTranscriptPollMs,
          });

  async function tick() {
    let state;
    try {
      state = deps.getState();
    } catch {
      return;
    }
    let changed = false;
    const notificationQueue = [];
    for (const project of state.projects || []) {
      for (const task of project.tasks || []) {
        // Resume pass: a paused "needs input" task whose agent started generating
        // again flips back to active tracking.
        if (task.status === 'todo' && task.watch_finished?.needs_input && task.paused_watch_tracking) {
          const pwt = normalizeWatchTracking(task.paused_watch_tracking, null);
          task.paused_watch_tracking = pwt;
          if (pwt) {
            const pausedAtMs =
              Date.parse(task.watch_finished.paused_at || pwt.clear_signal_at || '') || 0;
            let resumed = false;
            if (pwt.kind === 'ide_agent') {
              if (finishPausedGeminiWatchIfTerminal(task, pwt, deps, pausedAtMs)) {
                changed = true;
                continue;
              }
              if (await finishPausedClaudeWatchIfTerminal(task, pwt, deps, pausedAtMs)) {
                changed = true;
                continue;
              }
              if (await finishPausedCodexWatchIfTerminal(task, pwt, deps, pausedAtMs)) {
                changed = true;
                continue;
              }
              resumed = await shouldResumeIdeAgentWatch(pwt, deps, pausedAtMs);
            } else if (pwt.kind === 'cursor') {
              if (await finishPausedCursorWatchIfTerminal(task, pwt, deps, pausedAtMs)) {
                changed = true;
                continue;
              }
              resumed = await shouldResumeCursorWatch(pwt, deps);
            }
            if (resumed) {
              resumeWatchTracking(task, pwt, deps.applyTaskStatusChange);
              changed = true;
            }
          }
          continue;
        }
        if (task.status !== 'waiting') continue;
        task.watch_tracking = normalizeWatchTracking(task.watch_tracking, task.cursor_tracking);
        if (!task.watch_tracking) continue;
        const wt = task.watch_tracking;
        if (wt.kind === 'cursor') {
          const resolvedPath = await resolveCursorTranscriptPath(wt);
          if (resolvedPath && resolvedPath !== wt.transcript_path) {
            wt.transcript_path = resolvedPath;
          }
          const hookMeta =
            typeof deps.getCursorConversationSnapshot === 'function'
              ? deps.getCursorConversationSnapshot(wt)
              : null;
          let hint = typeof deps.getCursorCompletionHint === 'function' ? deps.getCursorCompletionHint(wt) : null;
          if (shouldDeferCursorHookCompletionForMultitask(wt, hint, hookMeta)) {
            hint = null;
            activateCursorMultitaskSubagentWatch(wt, hookMeta);
          }
          // Continuation watcher baselines/arming accrue while the watch is active (sub-agent
          // spawns, terminal task files, store.db blob baseline) — poll every tick, not only when
          // a stop hint is pending.
          if (typeof deps.pollCursorCliContinuation === 'function') {
            try { deps.pollCursorCliContinuation(wt); } catch { /* best-effort */ }
          }
          // cursor-cli: a completed generation stop only clears once the continuation gate agrees
          // the turn is over (no open sub-agent, no queued system notification) — see
          // cursorCompletedHintContinuationGate / lib/cursor_cli_continuation.js.
          if (hint && !(await cursorCompletedHintContinuationGate(wt, hint, deps))) {
            hint = null;
          }
          wt.hook_completion_hint = !!hint;
          wt.hook_completion_hint_at = hint?.updated_at || null;
          wt.cursor_multitask_subagent = !!wt.cursor_multitask_subagent;
          const workspaceSlugs =
            wt.workspace_slugs instanceof Set
              ? wt.workspace_slugs
              : new Set(Array.isArray(wt.workspace_slugs) ? wt.workspace_slugs : []);
          const transcriptFn =
            wt.source === 'ssh'
              ? deps.shouldCompleteRemoteCursorWatch || deps.shouldCompleteCursorWatch
              : deps.shouldCompleteCursorWatch;
          let askQuestionClear = false;
          if (typeof deps.getCursorChatDbQuestionHint === 'function') {
            // cursor-cli: store.db is the sole question-open signal. The transcript AskQuestion row is
            // delayed until after the answer and must not drive pause (or cause needs-input bounce).
            askQuestionClear = !!deps.getCursorChatDbQuestionHint(wt);
          } else if (typeof transcriptFn === 'function') {
            askQuestionClear = !!(await transcriptFn(wt, { workspaceSlugs }));
          } else {
            askQuestionClear = !!(await cursorWatchShouldClearSince(wt, { workspaceSlugs }));
          }
          const transcriptCancelFn =
            wt.source === 'ssh'
              ? deps.shouldCancelRemoteCursorWatchFromTranscript || deps.shouldCancelCursorWatchFromTranscript
              : deps.shouldCancelCursorWatchFromTranscript;
          let transcriptCancelled = false;
          if (typeof transcriptCancelFn === 'function') {
            transcriptCancelled = !!(await transcriptCancelFn(wt, { workspaceSlugs }));
          }
          const multitaskSubagentClear = cursorMultitaskSubagentWatchShouldClear(wt, hookMeta);
          wt.multitask_subagent_clear_hint = multitaskSubagentClear;
          wt.multitask_subagent_clear_hint_at = multitaskSubagentClear ? new Date().toISOString() : null;
          wt.ask_question_hint = askQuestionClear;
          wt.ask_question_hint_at = askQuestionClear ? new Date().toISOString() : null;
          // cursor-CLI config-eval permission gate (lib/cursor_cli_permission.js). Returns a
          // visible (debounced) pending snapshot for CLI runs only — IDE watches get null and
          // keep their renderer/agent-exec permission path.
          const permissionHint =
            typeof deps.getCursorPermissionPendingHint === 'function'
              ? deps.getCursorPermissionPendingHint(wt)
              : null;
          wt.cli_permission_hint = !!permissionHint;
          wt.cli_permission_hint_at = permissionHint ? new Date().toISOString() : null;
          if (hint || askQuestionClear || multitaskSubagentClear || permissionHint || transcriptCancelled) {
            // Cursor hook stop = finished; a pending AskQuestion = stopped waiting on
            // you; an aborted/cancelled terminal status = cancelled (clears to monitor);
            // a pending permission gate (CLI) = stopped waiting on you for approval.
            const cursorCancelled =
              (hint && (hint.completion_status === 'aborted' || hint.completion_status === 'cancelled'))
              || transcriptCancelled;
            if (cursorCancelled) {
              markCancelledWatchClear(wt);
            } else if (askQuestionClear) {
              // AskQuestion means the agent is blocked on the user even when a hook
              // stop/sessionEnd hint also landed on the same turn.
              markHumanGateWatchClear(wt, 'question', null, new Date().toISOString());
            } else if (permissionHint && !hint) {
              // Permission gate is needs-input only when the turn has NOT also completed: a
              // gated tool blocks, so a real stop can't coexist — if a completion hint is
              // present, trust it as done and let a stale gate hint fall through.
              markHumanGateWatchClear(wt, 'permission', permissionHint, new Date().toISOString());
            }
            const clearInfo = watchClearInfo(wt);
            if (clearInfo) task.last_watch_clear = clearInfo;
            deps.applyTaskStatusChange(task, 'todo');
            task.watch_tracking = null;
            task.cursor_tracking = null;
            recordWatchFinished(task, wt);
            changed = true;
          } else {
            wt.last_error = null;
            changed = true;
          }
          continue;
        }
        if (wt.kind === 'browser_chat') {
          const findSnapshot = deps.findBrowserChatSnapshot;
          const snap =
            typeof findSnapshot === 'function' ? findSnapshot(wt.provider, wt.conversation_id) : null;
          // A claude deep-research task in flight suppresses the bare generating:false ack flicker
          // (see shouldCompleteBrowserChatWatch); the flag comes from the task-status stream signals.
          const deepResearchInFlight =
            typeof deps.isBrowserChatDeepResearchInFlight === 'function'
              ? deps.isBrowserChatDeepResearchInFlight(wt.provider, wt.conversation_id)
              : false;
          if (shouldCompleteBrowserChatWatch(wt, snap, { deepResearchInFlight })) {
            deps.applyTaskStatusChange(task, 'todo');
            task.watch_tracking = null;
            task.cursor_tracking = null;
            recordWatchFinished(task, wt);
          }
          changed = true;
          continue;
        }
        if (wt.kind === 'process') {
          const done = await shouldCompleteProcessWatch(wt);
          if (done) {
            deps.applyTaskStatusChange(task, 'todo');
            task.watch_tracking = null;
            task.cursor_tracking = null;
            recordWatchFinished(task, wt);
          }
          changed = true;
        }
        if (wt.kind === 'notification') {
          notificationQueue.push({ task, wt });
        }
        if (wt.kind === 'ide_agent') {
          const done = await shouldCompleteIdeAgentWatch(wt, deps);
          if (done) {
            const clearInfo = watchClearInfo(wt);
            if (clearInfo) task.last_watch_clear = clearInfo;
            deps.applyTaskStatusChange(task, 'todo');
            task.watch_tracking = null;
            task.cursor_tracking = null;
            recordWatchFinished(task, wt);
            if (typeof deps.onIdeAgentWatchComplete === 'function') {
              try { deps.onIdeAgentWatchComplete(wt); } catch {}
            }
          }
          changed = true;
        }
      }
    }

    if (notificationQueue.length) {
      notificationQueue.sort((a, b) => {
        const aTs = Date.parse(a.wt.linked_at || '') || 0;
        const bTs = Date.parse(b.wt.linked_at || '') || 0;
        return aTs - bTs;
      });
      const consumedByProvider = new Map();
      for (const item of notificationQueue) {
        const { task, wt } = item;
        const result = await inspectNotificationWatch(wt);
        changed = true;
        if (!result.completed || !result.consumedRecId) continue;
        const providerKey = wt.provider || '';
        let consumed = consumedByProvider.get(providerKey);
        if (!consumed) {
          consumed = new Set();
          consumedByProvider.set(providerKey, consumed);
        }
        if (consumed.has(result.consumedRecId)) {
          wt.since_rec_id = result.consumedRecId;
          continue;
        }
        consumed.add(result.consumedRecId);
        deps.applyTaskStatusChange(task, 'todo');
        task.watch_tracking = null;
        task.cursor_tracking = null;
        recordWatchFinished(task, wt);
      }
    }
    if (changed) {
      try {
        deps.save();
      } catch (err) {
        console.error('[watch_tracker] save failed:', err);
      }
    }
    if (started && transcriptWatcher) {
      try {
        transcriptWatcher.sync(state);
      } catch (err) {
        console.error('[watch_tracker] paused transcript watch sync failed:', err);
      }
    }
  }

  async function runTick() {
    if (tickInFlight) {
      tickQueued = true;
      return;
    }
    tickInFlight = true;
    try {
      await tick();
    } finally {
      tickInFlight = false;
      if (tickQueued) {
        tickQueued = false;
        await runTick();
      }
    }
  }

  function start() {
    if (timer) return Promise.resolve();
    started = true;
    timer = setInterval(() => {
      runTick().catch((err) => console.error('[watch_tracker] tick error:', err));
    }, pollMs);
    if (typeof timer.unref === 'function') timer.unref();
    return runTick().catch((err) => console.error('[watch_tracker] initial tick error:', err));
  }

  function stop() {
    started = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (transcriptWatcher) transcriptWatcher.close();
  }

  return { start, stop, tick: runTick };
}

function cursorToWatchTracking(runId, transcriptPath) {
  return { ...defaultCursorTracking(runId, transcriptPath), kind: 'cursor' };
}

function remoteCursorToWatchTracking(runId, transcriptPath, remote) {
  return { ...defaultRemoteCursorTracking(runId, transcriptPath, remote), kind: 'cursor' };
}

module.exports = {
  normalizeWatchTracking,
  createWatchPoller,
  finishedMarker,
  recordWatchFinished,
  shouldResumeIdeAgentWatch,
  shouldResumeCursorWatch,
  finishPausedCursorWatchIfTerminal,
  cursorCompletedHintContinuationGate,
  markHumanGateWatchClear,
  markCancelledWatchClear,
  watchClearInfo,
  resumeWatchTracking,
  isPermissionAttentionReason,
  shouldCompleteProcessWatch,
  shouldCompleteIdeAgentWatch,
  codexSubagentDoneHoldActive,
  defaultProcessTracking,
  defaultRemoteProcessTracking,
  defaultNotificationTracking,
  cursorToWatchTracking,
  remoteCursorToWatchTracking,
};
