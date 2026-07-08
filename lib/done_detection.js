'use strict';

/*
 * done_detection.js — shared "agent done" state machine.
 *
 * Stop is a turn boundary, not a done signal. A resume is never silent: it always
 * arrives as a UserPromptSubmit —
 *   - `<task-notification>` envelope        -> a background task completed (continuation)
 *   - exact-match of a registered cron prompt -> a cron fired (continuation)
 *   - anything else                          -> a genuine new user message
 *
 * State machine: WORKING -> SETTLING -> IDLE (-> ENDED on SessionEnd), with a HELD
 * detour while a backgrounded sub-agent is still running.
 *   - On Stop with a running SUB-AGENT (background_tasks {type:'subagent',status:'running'}):
 *     enter HELD — the parent turn Stopped but the cascade is still working. HELD never
 *     auto-clears; it waits for a later Stop that reports no running sub-agent (the true
 *     final Stop), which then follows the normal SETTLING path. This eliminates the
 *     sub-agent-early-clear flicker. The Stop body is the reliable signal — the
 *     SubagentStart/SubagentStop hooks fire asymmetrically (orphan Stops, 2x counts).
 *   - On Stop with a running background SHELL task (no sub-agent): enter SETTLING with the
 *     BOUNDED busy-hold window instead of the short debounce — TIERED by the session's latest
 *     TodoWrite state (resolveBusyHoldMs): unfinished todos keep the full busyHoldMs backstop
 *     (30min), a completed list holds todoDoneHoldMs (3min), no list holds noTodoHoldMs (5min).
 *     Claude re-invokes the session when such a task finishes, so short waiter tasks resume
 *     seamlessly inside the hold; a long-lived task (dev server) settles at the tier cap.
 *   - On Stop with no running tasks (crons-only or idle): re-sync ledgers (running background
 *     tasks, scheduled crons), enter SETTLING, start a debounce timer T.
 *   - Resume before T  -> stay busy (seamless, no warning).
 *   - T expires first  -> clear to IDLE. A later resume re-activates (WORKING) = a
 *     recoverable FLICKER (warned, never a failure).
 *   - Crons never block IDLE; they are surfaced as "scheduled". SubagentStop is
 *     ignored; MessageDisplay etc. are not state changes.
 *
 * Used by the live recorders (claude_code_session.js,
 * claude_code_desktop_signal_session.js) and the offline probe
 * (scripts/done_detection_probe.js).
 */

const DEFAULT_DEBOUNCE_MS = 15_000;
// Bounded busy-hold for Stops that leave a claude-managed background shell task running — must
// mirror claude_hook_store.DEFAULT_BACKGROUND_TASK_HOLD_MS (capture-side model == production).
// 30min since 2026-07-06: the cap is the crash/eternal-task backstop, not the clearing mechanism
// (the task-exit notification is). Recordings stamp their config, so old 120s-era captures keep
// grading against the value they recorded.
const DEFAULT_BUSY_HOLD_MS = 1_800_000;
// Todo-tiered busy-holds (2026-07-07 maintainer decision): the TodoWrite list in the session's
// own PostToolUse stream is the agent's STATED remaining work — a structured signal the 2026-07-03
// task-body audit never evaluated (that audit rejected sniffing the task entries themselves, which
// ARE structurally identical; the todo list is a different channel). Backtest over every claude
// bank+lab recording (196 sessions, 103 busy Stops): todo state predicted resumed-vs-final with
// ZERO misclassifications — every busy Stop with pending/in_progress todos resumed, the all-done
// Stops were the true finals. So a busy Stop keeps the full 30min backstop only while the agent
// says work remains; with a completed list it clears after TODO_DONE (never observed to resume);
// with no list at all (short tasks never write one) it clears after NO_TODO — 5min covers the
// worst observed no-list resume gap (214s) with margin, where 2–3min would have flickered once.
const DEFAULT_TODO_DONE_HOLD_MS = 180_000;
const DEFAULT_NO_TODO_HOLD_MS = 300_000;
const DEFAULT_END_WAIT_MS = 30_000;

// TodoWrite list -> tier state. Empty/absent list carries no information ('none'); any
// pending/in_progress item means the agent still has work ('unfinished'); a non-empty fully
// completed list is the agent declaring its plan finished ('all_done').
function todoStateFromTodos(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return 'none';
  const unfinished = todos.some((t) => String(t?.status || '').toLowerCase() !== 'completed');
  return unfinished ? 'unfinished' : 'all_done';
}

// The busy-hold window a Stop-with-running-shell-tasks gets, by todo tier. Shared by the
// production hook store and the capture-side machine (predicate parity).
function resolveBusyHoldMs(todoState, holds = {}) {
  const busyHoldMs = Number.isFinite(holds.busyHoldMs) ? holds.busyHoldMs : DEFAULT_BUSY_HOLD_MS;
  const todoDoneHoldMs = Number.isFinite(holds.todoDoneHoldMs) ? holds.todoDoneHoldMs : DEFAULT_TODO_DONE_HOLD_MS;
  const noTodoHoldMs = Number.isFinite(holds.noTodoHoldMs) ? holds.noTodoHoldMs : DEFAULT_NO_TODO_HOLD_MS;
  if (todoState === 'unfinished') return busyHoldMs;
  if (todoState === 'all_done') return todoDoneHoldMs;
  return noTodoHoldMs;
}

// Track the PARENT session's latest todo list from its hook stream. Sub-agents run their own
// TodoWrite lists; their hooks keep the parent session_id but point at the CHILD transcript_path
// (same shape as sub-agent permission hooks), so the first-seen main transcript path gates which
// TodoWrite events count. Production reads PostToolUse only (the captured set), so PreToolUse is
// deliberately ignored here too — parity over eagerness.
function createTodoTracker() {
  let state = 'none';
  let mainTranscript = '';
  return {
    observe(name, body) {
      const tp = typeof body?.transcript_path === 'string' ? body.transcript_path.trim() : '';
      if ((name === 'UserPromptSubmit' || name === 'SessionStart' || name === 'Stop') && tp && !mainTranscript) {
        mainTranscript = tp;
      }
      if (name !== 'PostToolUse') return;
      if (String(body?.tool_name || '') !== 'TodoWrite') return;
      if (tp && mainTranscript && tp !== mainTranscript) return; // a sub-agent's own list
      const todos = body?.tool_input?.todos;
      if (!Array.isArray(todos)) return;
      state = todoStateFromTodos(todos);
    },
    get state() {
      return state;
    },
  };
}

const STATE = {
  INIT: 'INIT',
  WORKING: 'WORKING',
  // Parent Stopped but a backgrounded sub-agent is still running — busy/active, never a
  // done. Released by a later Stop with no running sub-agent (or a resume → WORKING).
  HELD: 'HELD',
  SETTLING: 'SETTLING',
  IDLE: 'IDLE',
  ENDED: 'ENDED',
};

// ---------------------------------------------------------------------------
// Event classification
// ---------------------------------------------------------------------------

function runningTasks(body) {
  const tasks = Array.isArray(body.background_tasks) ? body.background_tasks : [];
  return tasks.filter((t) => String(t?.status || '').toLowerCase() === 'running');
}

// Backgrounded sub-agents surface in the Stop body as {type:'subagent',status:'running'}. This
// is the reliable cascade signal (see header) — a still-running sub-agent means the cascade is
// not done regardless of the parent's Stop.
function runningSubagents(body) {
  return runningTasks(body).filter((t) => String(t?.type || '').toLowerCase() === 'subagent');
}

function cronList(body) {
  return Array.isArray(body.session_crons) ? body.session_crons.filter(Boolean) : [];
}

function isTaskNotification(prompt) {
  const p = String(prompt || '').replace(/^\s+/, '');
  return p.startsWith('<task-notification>') && p.includes('<task-id>');
}

function taskNotificationId(prompt) {
  const m = String(prompt || '').match(/<task-id>([^<]+)<\/task-id>/);
  return m ? m[1].trim() : '';
}

function taskNotificationStatus(prompt) {
  const m = String(prompt || '').match(/<status>([^<]+)<\/status>/);
  return m ? m[1].trim() : '';
}

/**
 * Classify a UserPromptSubmit against the cron registry built from prior Stops.
 * @returns {{kind: 'task_resume'|'cron_resume'|'user_message', taskId?, status?, cronId?}}
 */
function classifyPrompt(prompt, cronRegistry) {
  if (isTaskNotification(prompt)) {
    return { kind: 'task_resume', taskId: taskNotificationId(prompt), status: taskNotificationStatus(prompt) };
  }
  const needle = String(prompt || '').trim();
  for (const cron of cronRegistry.values()) {
    if (needle && needle === String(cron.prompt || '').trim()) {
      return { kind: 'cron_resume', cronId: cron.id };
    }
  }
  return { kind: 'user_message' };
}

// One-shot cron-wakeup hold (claude ScheduleWakeup): a Stop whose session_crons carry a
// NON-recurring cron firing in the near future is the agent yielding to its own scheduler
// ("coming right back"), not a finished turn — the claude analog of codex's heartbeat
// automation, and the same maintainer decision (2026-07-06, wakeup hybrid):
//   - HOLD until max(next fire, stop) + grace: the cron prompt's UserPromptSubmit resumes
//     tracking seamlessly (no done→working flicker); if the wake never lands (cron cancelled,
//     app quit) the bounded deadline clears.
//   - HORIZON: only near-future fires hold (fire − stop ≤ 10min). A far-future one-shot is a
//     scheduled job → keep cron semantics (15s debounce, fire re-arms with a tolerated flicker).
//   - RECURRING crons NEVER hold — a standing schedule would pin "working" forever.
// The fire time comes from the Stop body's cron expression (minute-granularity: claude converts
// ScheduleWakeup delaySeconds into the next minute-boundary slot), so grace must cover the
// boundary rounding plus delivery lag — observed wake = fire slot ±ms, stop→fire up to ~92s.
// Must mirror codex_tracker CODEX_HEARTBEAT_HOLD_HORIZON_MS / CODEX_HEARTBEAT_FIRE_GRACE_MS.
const DEFAULT_CRON_WAKEUP_HOLD_HORIZON_MS = 10 * 60_000;
const DEFAULT_CRON_WAKEUP_FIRE_GRACE_MS = 120_000;

/**
 * The absolute ms deadline a Stop's one-shot near-future wakeup crons hold "working" until,
 * or 0 when nothing holds. Shared by the production claude hook store and this capture-side
 * machine so the two can never disagree (predicate parity).
 */
function cronWakeupHoldDeadlineMs(sessionCrons, stopMs, opts = {}) {
  const horizonMs = Number.isFinite(opts.horizonMs) ? opts.horizonMs : DEFAULT_CRON_WAKEUP_HOLD_HORIZON_MS;
  const graceMs = Number.isFinite(opts.graceMs) ? opts.graceMs : DEFAULT_CRON_WAKEUP_FIRE_GRACE_MS;
  // Injectable fire-time source (opts.fireResolver(cron, stopMs) → absolute ms, 0 = unknown).
  // Live/capture use the wall-clock cron expression (default); signal_replay injects a resolver
  // backed by the recording's claude_cron_fires stamps, because a wall-clock schedule evaluated
  // on the replay's virtual clock would hold by time-of-day luck.
  const fireResolver = typeof opts.fireResolver === 'function' ? opts.fireResolver : null;
  if (!Number.isFinite(stopMs) || stopMs <= 0) return 0;
  let deadline = 0;
  for (const cron of Array.isArray(sessionCrons) ? sessionCrons : []) {
    // Only a PROVEN one-shot holds; recurring or unknown recurrence keeps cron semantics.
    if (!cron || cron.recurring !== false) continue;
    let fireMs = 0;
    if (fireResolver) {
      fireMs = Number(fireResolver(cron, stopMs)) || 0;
    } else {
      const fireIso = nextCronFireIso(cron.schedule, stopMs);
      fireMs = fireIso ? Date.parse(fireIso) : 0;
    }
    if (!fireMs) continue;
    if (fireMs - stopMs > horizonMs) continue;
    deadline = Math.max(deadline, Math.max(fireMs, stopMs) + graceMs);
  }
  return deadline;
}

// Best-effort: next wall-clock fire for a "m H * * *" style schedule at-or-after a
// reference time. Returns ISO or null if not a simple daily expression.
function nextCronFireIso(schedule, refTms) {
  if (!schedule || refTms == null) return null;
  const parts = String(schedule).trim().split(/\s+/);
  if (parts.length < 2) return null;
  const min = Number(parts[0]);
  const hour = Number(parts[1]);
  if (!Number.isInteger(min) || !Number.isInteger(hour)) return null;
  const candidate = new Date(refTms);
  candidate.setUTCSeconds(0, 0);
  candidate.setHours(hour, min, 0, 0);
  if (candidate.getTime() < refTms) candidate.setDate(candidate.getDate() + 1);
  return candidate.toISOString();
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * Normalize raw hook events to the `{name, t_ms, body}` the machine consumes,
 * sorted by time. Accepts either recorder events ({type:'hook', hook_event_name})
 * or already-normalized rows.
 */
function normalizeHooks(events) {
  const hooks = [];
  for (const ev of events || []) {
    if (ev == null) continue;
    if (ev.type && ev.type !== 'hook') continue;
    const name = ev.name || ev.hook_event_name || ev.body?.hook_event_name || '';
    const t = Number(ev.t_ms ?? ev.hook_t_ms);
    if (!name || !Number.isFinite(t)) continue;
    hooks.push({ name, t_ms: t, body: ev.body || {}, seq: ev.seq });
  }
  hooks.sort((a, b) => a.t_ms - b.t_ms || (a.seq ?? 0) - (b.seq ?? 0));
  return hooks;
}

/**
 * Run the done-detection machine over hook events.
 * @param {Array} events recorder events or normalized hooks
 * @param {{debounceMs?, endWaitMs?, ignoreSessionEnd?}} [opts]
 */
function runStateMachine(events, opts = {}) {
  const debounceMs = Number.isFinite(opts.debounceMs) ? opts.debounceMs : DEFAULT_DEBOUNCE_MS;
  const busyHoldMs = Number.isFinite(opts.busyHoldMs) ? opts.busyHoldMs : DEFAULT_BUSY_HOLD_MS;
  const todoDoneHoldMs = Number.isFinite(opts.todoDoneHoldMs) ? opts.todoDoneHoldMs : DEFAULT_TODO_DONE_HOLD_MS;
  const noTodoHoldMs = Number.isFinite(opts.noTodoHoldMs) ? opts.noTodoHoldMs : DEFAULT_NO_TODO_HOLD_MS;
  const endWaitMs = Number.isFinite(opts.endWaitMs) ? opts.endWaitMs : DEFAULT_END_WAIT_MS;
  const cronWakeupOpts = {
    horizonMs: Number.isFinite(opts.cronWakeupHorizonMs) ? opts.cronWakeupHorizonMs : undefined,
    graceMs: Number.isFinite(opts.cronWakeupGraceMs) ? opts.cronWakeupGraceMs : undefined,
  };
  const ignoreSessionEnd = !!opts.ignoreSessionEnd;
  const hooks = normalizeHooks(events);

  const m = {
    state: STATE.INIT,
    lastStopTms: null,
    settleDeadline: null,
    outstandingTasks: new Map(), // id -> task
    activeCrons: new Map(),      // id -> cron currently scheduled (latest Stop)
    cronRegistry: new Map(),     // id -> cron ever seen (for matching fires)
    timeline: [],
    clears: [],
    warnings: [],
    drainedTasks: [],
    cronFires: [],
    debounceMs,
    busyHoldMs,
    todoDoneHoldMs,
    noTodoHoldMs,
    // Todo tier the most recent Stop was held under ('unfinished' | 'all_done' | 'none') — the
    // parent session's latest TodoWrite state at that Stop.
    todoStateAtLastStop: 'none',
    // The settle window applied by the most recent Stop (debounce or busy-hold) — recorded on
    // flicker warnings so "stop→resume Xs (> T=Ys)" reports the window that actually governed.
    lastStopWindowMs: debounceMs,
    endWaitMs,
    firstEventTms: hooks.length ? hooks[0].t_ms : null,
    lastEventTms: hooks.length ? hooks[hooks.length - 1].t_ms : null,
  };

  const note = (t_ms, from, to, label) => m.timeline.push({ t_ms, from, to, label });
  const todoTracker = createTodoTracker();

  const resolveSettleBefore = (untilTms) => {
    if (m.state === STATE.SETTLING && m.settleDeadline != null && untilTms >= m.settleDeadline) {
      const residual = [...m.outstandingTasks.values()];
      m.clears.push({
        t_ms: m.settleDeadline,
        stop_t_ms: m.lastStopTms,
        residual_tasks: residual.map((t) => ({ id: t.id, command: t.command, description: t.description })),
        scheduled_crons: [...m.activeCrons.values()].map((c) => ({ id: c.id, schedule: c.schedule, recurring: c.recurring })),
      });
      note(m.settleDeadline, STATE.SETTLING, STATE.IDLE, 'debounce_expired_clear');
      m.state = STATE.IDLE;
      m.settleDeadline = null;
    }
  };

  for (const h of hooks) {
    resolveSettleBefore(h.t_ms);

    if (h.name === 'SubagentStop') continue; // nested; never affects top-level done

    // TodoWrite state feeds the busy-hold tier of the NEXT Stop; the tracker also learns the main
    // transcript path from session-scoped events so sub-agent todo lists never count.
    todoTracker.observe(h.name, h.body);

    if (h.name === 'Stop') {
      m.outstandingTasks = new Map(runningTasks(h.body).map((t) => [String(t.id || ''), t]));
      const crons = cronList(h.body);
      m.activeCrons = new Map(crons.map((c) => [String(c.id || ''), c]));
      for (const c of crons) m.cronRegistry.set(String(c.id || ''), c);
      m.lastStopTms = h.t_ms;
      m.todoStateAtLastStop = todoTracker.state;
      const from = m.state;
      if (runningSubagents(h.body).length > 0) {
        // Parent Stopped while a backgrounded sub-agent is still running: HOLD (no debounce
        // clear). The true final Stop (no running sub-agent) resolves this to SETTLING → IDLE.
        m.state = STATE.HELD;
        m.settleDeadline = null;
        note(h.t_ms, from, STATE.HELD, 'stop_subagent_held');
      } else if (runningTasks(h.body).length > 0) {
        // Stopped with a running claude-managed background SHELL task: BOUNDED busy-hold, TIERED
        // by the session's TodoWrite state (see resolveBusyHoldMs). Unfinished todos = the agent
        // says work remains -> full backstop (these Stops always resume; the task normally
        // re-invokes the agent on completion as a task_resume). A completed list / no list = no
        // stated remaining work -> the short tiers, so an abandoned watcher task can't pin
        // "working" for the full cap. Mirrors claude_hook_store's completion_busy_hold(_ms). A
        // concurrent near-future wakeup cron can only EXTEND the window (max), never shorten it.
        const cronDeadline = cronWakeupHoldDeadlineMs(crons, h.t_ms, cronWakeupOpts);
        const todoState = todoTracker.state;
        const holdMs = resolveBusyHoldMs(todoState, { busyHoldMs, todoDoneHoldMs, noTodoHoldMs });
        m.state = STATE.SETTLING;
        m.settleDeadline = Math.max(h.t_ms + holdMs, cronDeadline);
        m.lastStopWindowMs = m.settleDeadline - h.t_ms;
        const label =
          todoState === 'all_done'
            ? 'stop_busy_hold_todos_done'
            : todoState === 'none'
              ? 'stop_busy_hold_no_todos'
              : 'stop_busy_hold';
        note(h.t_ms, from, STATE.SETTLING, label);
      } else {
        // Idle or crons-only Stop. A near-future ONE-SHOT wakeup cron (ScheduleWakeup) holds
        // until its fire + grace — the agent yielded to its own scheduler, the cron prompt
        // resumes tracking with no flicker. Recurring / far-future crons keep the short
        // debounce (fire re-arms; tolerated flicker). Mirrors cronWakeupHoldDeadlineMs use in
        // claude_hook_store getCompletionHintForTracking.
        const cronDeadline = cronWakeupHoldDeadlineMs(crons, h.t_ms, cronWakeupOpts);
        m.state = STATE.SETTLING;
        if (cronDeadline > h.t_ms + debounceMs) {
          m.settleDeadline = cronDeadline;
          m.lastStopWindowMs = cronDeadline - h.t_ms;
          note(h.t_ms, from, STATE.SETTLING, 'stop_cron_hold');
        } else {
          m.settleDeadline = h.t_ms + debounceMs;
          m.lastStopWindowMs = debounceMs;
          note(h.t_ms, from, STATE.SETTLING, 'stop');
        }
      }
      continue;
    }

    if (h.name === 'SessionEnd') {
      if (ignoreSessionEnd) continue;
      const from = m.state;
      m.state = STATE.ENDED;
      m.settleDeadline = null;
      m.outstandingTasks.clear();
      m.activeCrons.clear();
      note(h.t_ms, from, STATE.ENDED, `session_end:${h.body?.reason || ''}`);
      continue;
    }

    if (h.name === 'UserPromptSubmit') {
      const cls = classifyPrompt(h.body?.prompt, m.cronRegistry);
      const from = m.state;

      if (from === STATE.INIT) {
        m.state = STATE.WORKING;
        note(h.t_ms, from, STATE.WORKING, `prompt:${cls.kind}`);
      } else {
        const stopT = m.lastStopTms;
        const deltaMs = stopT != null ? h.t_ms - stopT : null;
        const cleared = from === STATE.IDLE; // debounce already fired -> flicker

        if (cleared) {
          const warn = {
            type: cls.kind === 'cron_resume' ? 'cron_reactivation' : 'flicker',
            resume_kind: cls.kind,
            stop_t_ms: stopT,
            resume_t_ms: h.t_ms,
            delta_ms: deltaMs,
            debounce_ms: m.lastStopWindowMs,
            exceeded_debounce: deltaMs != null && deltaMs > m.lastStopWindowMs,
          };
          if (cls.cronId) warn.cron_id = cls.cronId;
          if (cls.taskId) warn.task_id = cls.taskId;
          m.warnings.push(warn);
          note(h.t_ms, from, STATE.WORKING, `reactivate:${cls.kind}`);
        } else {
          note(h.t_ms, from, STATE.WORKING, `resume:${cls.kind}`);
        }
        m.state = STATE.WORKING;
        m.settleDeadline = null;
      }

      if (cls.kind === 'task_resume' && cls.taskId) {
        if (m.outstandingTasks.has(cls.taskId)) m.outstandingTasks.delete(cls.taskId);
        m.drainedTasks.push({ id: cls.taskId, status: cls.status, t_ms: h.t_ms });
      }
      if (cls.kind === 'cron_resume' && cls.cronId) {
        const cron = m.cronRegistry.get(cls.cronId);
        m.cronFires.push({ id: cls.cronId, t_ms: h.t_ms, afterClear: from === STATE.IDLE });
        if (cron && cron.recurring === false) m.activeCrons.delete(cls.cronId);
      }
      continue;
    }

    // MessageDisplay / PreToolUse / PostToolUse / PostToolBatch etc. — ignored.
  }

  // Resolve any trailing debounce, then record where the "session" closed. Disabled by
  // pendingSettleDeadlineMs, which needs the raw (unresolved) end-of-capture state.
  if (opts.resolveTrailingSettle !== false) resolveSettleBefore(Number.MAX_SAFE_INTEGER);
  m.sessionCloseTms = (m.lastStopTms != null ? m.lastStopTms : m.lastEventTms || 0) + endWaitMs;

  m.orphanCrons = [...m.activeCrons.values()].map((c) => ({
    id: c.id,
    schedule: c.schedule,
    recurring: c.recurring,
    prompt: String(c.prompt || '').slice(0, 120),
    next_fire_iso: nextCronFireIso(c.schedule, m.lastStopTms),
  }));

  return m;
}

// ---------------------------------------------------------------------------
// Verdict + report helpers
// ---------------------------------------------------------------------------

function buildDoneVerdict(m) {
  // Settled = busy cleared (IDLE) or session closed (ENDED). WORKING or HELD at end of the
  // capture just means the agent (or a sub-agent) was still generating — a live state, not a
  // fault. With --timer-done the capture runs until cascade-wide quiet, so the true final Stop
  // is always recorded and HELD resolves to IDLE before the end.
  const settled = m.state === STATE.IDLE || m.state === STATE.ENDED;
  const activeAtEnd = m.state === STATE.WORKING || m.state === STATE.HELD;
  // "Stuck" (the Strategy-1 failure this design removes) = a busy SETTLING state that
  // never resolved. The debounce force-resolves SETTLING, so this is an invariant
  // violation if it ever fires. HELD is NOT stuck — it is a legitimate wait on a sub-agent.
  const stuck = m.state === STATE.SETTLING;

  const flickers = m.warnings.filter((w) => w.type === 'flicker');
  const cronReactivations = m.warnings.filter((w) => w.type === 'cron_reactivation');

  const failReasons = [];
  if (stuck) failReasons.push('ended in SETTLING without clearing (stuck — invariant violation)');

  return {
    pass: failReasons.length === 0,
    fail_reasons: failReasons,
    final_state: m.state,
    settled,
    active_at_end: activeAtEnd,
    stuck,
    clears: m.clears.length,
    flickers: flickers.length,
    cron_reactivations: cronReactivations.length,
    orphan_crons: m.orphanCrons.length,
  };
}

/** Convenience: run + verdict in one call over recorder events. */
function analyzeEvents(events, opts = {}) {
  const machine = runStateMachine(events, opts);
  const verdict = buildDoneVerdict(machine);
  return { machine, verdict };
}

/**
 * The absolute t_ms at which a still-pending settle window (busy-hold or debounce) will clear,
 * or null when nothing is pending. Capture harnesses use this to keep recording until the clear
 * is OBSERVABLE in the capture: the 90s quiet window can expire while a 120s busy-hold is still
 * pending, and closing there would strand the recording without its done clear (fine for the
 * done-tracking verdict, which extrapolates the deadline — but such a recording can never
 * replay to done in the bank). Run over the RAW events with resolveTrailing disabled.
 */
function pendingSettleDeadlineMs(events, opts = {}) {
  const machine = runStateMachine(events, { ...opts, resolveTrailingSettle: false });
  return machine.state === STATE.SETTLING && machine.settleDeadline != null ? machine.settleDeadline : null;
}

/**
 * Decision used to GRADE a "done"-outcome run when done-detection is the driver
 * (superseding the legacy replay-clear + background-false-clear check).
 * A flicker / cron-reactivation is recoverable and never a failure here — only
 * never-settling (stuck) or never reaching a settled state fails.
 * @returns {string|null} failure reason, or null if the done outcome is clean.
 */
function doneOutcomeFailure(verdict) {
  if (!verdict) return 'done-tracking unavailable';
  if (verdict.stuck) return 'done-tracking never settled (stuck): busy state never cleared';
  if (!verdict.settled) return 'done-tracking did not reach a settled (idle/ended) state';
  return null;
}

/** Compact, serializable summary suitable for a session-report.json section. */
function summarizeDoneTracking(machine, verdict) {
  return {
    config: {
      debounce_ms: machine.debounceMs,
      busy_hold_ms: machine.busyHoldMs,
      todo_done_hold_ms: machine.todoDoneHoldMs,
      no_todo_hold_ms: machine.noTodoHoldMs,
      end_wait_ms: machine.endWaitMs,
    },
    verdict,
    transitions: machine.timeline.map((t) => ({ t_ms: t.t_ms, from: t.from, to: t.to, label: t.label })),
    clears: machine.clears,
    warnings: machine.warnings,
    drained_tasks: machine.drainedTasks,
    cron_fires: machine.cronFires,
    orphan_crons: machine.orphanCrons,
  };
}

/** Human-readable warning lines for console output (stop→resume deltas vs T). */
function doneTrackingWarningLines(machine) {
  const lines = [];
  for (const w of machine.warnings) {
    const delta = w.delta_ms != null ? `${(w.delta_ms / 1000).toFixed(2)}s` : '?';
    const tSec = (w.debounce_ms / 1000).toFixed(0);
    if (w.type === 'cron_reactivation') {
      lines.push(`  ⚠ done-tracking CRON REACTIVATION (cron ${w.cron_id}): cleared agent reactivated — stop→fire ${delta} (> T=${tSec}s)`);
    } else {
      lines.push(`  ⚠ done-tracking FLICKER (${w.resume_kind}): cleared then re-activated — stop→resume ${delta} (> T=${tSec}s)`);
    }
  }
  for (const c of machine.orphanCrons) {
    lines.push(`  ⚠ done-tracking ORPHAN CRON ${c.id} still scheduled at close (next_fire≈${c.next_fire_iso || '?'}) — false-resume risk`);
  }
  return lines;
}

module.exports = {
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_BUSY_HOLD_MS,
  DEFAULT_TODO_DONE_HOLD_MS,
  DEFAULT_NO_TODO_HOLD_MS,
  DEFAULT_END_WAIT_MS,
  DEFAULT_CRON_WAKEUP_HOLD_HORIZON_MS,
  DEFAULT_CRON_WAKEUP_FIRE_GRACE_MS,
  STATE,
  todoStateFromTodos,
  resolveBusyHoldMs,
  createTodoTracker,
  classifyPrompt,
  isTaskNotification,
  cronWakeupHoldDeadlineMs,
  nextCronFireIso,
  normalizeHooks,
  runStateMachine,
  buildDoneVerdict,
  analyzeEvents,
  pendingSettleDeadlineMs,
  doneOutcomeFailure,
  summarizeDoneTracking,
  doneTrackingWarningLines,
};
