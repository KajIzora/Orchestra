'use strict';

/**
 * Layer-0 signal registry: declarative per-platform metadata describing **where each
 * agent's signals live and how to read them**. One source of truth that the recorder
 * (which raw-tap / capture mode to use), the replay engine (provider id -> deps builder),
 * and the generated signal-map doc all read. Adding a platform starts with an entry here.
 *
 * This is metadata, not logic — the actual tracking decision lives in watch_tracker.js
 * (+ cursor_renderer_watch.js) and the replay deps builders mirror that. The registry
 * keeps the human-facing "how do we track X" description from silently drifting.
 */

/**
 * @typedef {Object} SignalSource
 * @property {string} outcome      generating | resume | done | cancelled | permission | question
 *                                 ('generating' = the first active-generation signal that populates
 *                                 the Orchestra picker; 'resume' = the needs-input -> working flip
 *                                 that ends a permission/question gate)
 * @property {string} via          hook | transcript | renderer | audit | db | log
 * @property {string} detail       short human description of the signal
 */

/**
 * @typedef {Object} SshEntry
 * @property {boolean} supported       whether source:'ssh' watches are valid
 * @property {string} [location]       remote transcript/audit path when it differs from local
 * @property {string} [hookDelivery]   how hook events reach Orchestra on remote runs
 * @property {string|null} [hookInstall] install-remote API / mechanism
 * @property {string} [transcriptRead] how the poller/recorder reads transcripts over SSH
 * @property {string[]} [unavailable] local-only signal sources that do not apply on ssh
 * @property {string[]} [extraPolled] additional sources polled over SSH (not hook POST)
 * @property {string[]} [differences] behavioral deltas vs local (poll interval, resume, etc.)
 * @property {string} [replay]         replay fidelity note for remote recordings
 * @property {string} [note]           ssh-specific caveats
 */

/**
 * @typedef {Object} KnownGap
 * @property {string} id        short kebab-case identifier
 * @property {string} summary   one-line description of the gap
 * @property {string} detail    repro + why current signals can't cleanly close it
 * @property {string} [candidateFix] the approach(es) considered and their tradeoffs
 * @property {string} status    e.g. 'not-implemented — maintainer decision pending'
 */

/**
 * @typedef {Object} SpecialCase
 * @property {string} id        short kebab-case identifier (stable — external docs cite these)
 * @property {string} summary   one-line description of the pattern and the decided handling
 * @property {string} detail    how the signals actually behave, what holds/releases, expected shapes
 *                              (incl. lab/grading consequences), and any REJECTED alternatives
 * @property {string} [status]  decision/validation state (e.g. 'live-validated 2026-07-06')
 */

/**
 * @typedef {Object} RegistryEntry
 * @property {'supported'|'research'} status support status for signal-map and Phase 2 planning
 * @property {string} provider       watch_tracking.provider value
 * @property {string} kind           watch_tracking.kind ('ide_agent' | 'cursor')
 * @property {string|null} hookProvider  raw-tap / hook-store name, or null if no hooks
 * @property {'hooks'|'audit'} captureMode  how the recorder captures the primary stream
 * @property {boolean} remote        SSH-watchable
 * @property {string} location       where the transcript/audit lives (human)
 * @property {string[]} extraSources non-hook signal locations (e.g. renderer.log)
 * @property {string[]} liveOnlySources sources used by live Orchestra but not first-class replay channels
 * @property {string[]} recordedChannels signal-bank channels written by the recorder
 * @property {string[]} replayChannels signal-bank channels consumed by replay
 * @property {{captured: string[], available: string[]}|undefined} hookCatalog known hook events
 * @property {SignalSource[]} sources how each outcome is detected
 * @property {SpecialCase[]} [specialCases] unique per-platform signal patterns and how tracking handles
 *   them (background tasks, self-scheduled wakeups, sub-agent holds, suspend/resume quirks, …).
 *   These are WORKING, decided behaviors — not open gaps. Entries typically graduate here from
 *   knownGaps once fixed or decided by-design; ids are kept stable across the move so external docs
 *   keep resolving. Expected to grow as new platform quirks are characterized.
 * @property {KnownGap[]} [knownGaps] documented tracking gaps not yet closed (decision/impl pending),
 *   plus testing-side caveats an auditor must not re-file
 * @property {SshEntry} [ssh]        remote (--source ssh) tracking: delivery, reads, deltas
 * @property {string[]} replayModes  modes meaningful for this provider
 * @property {string} [note]         caveats worth surfacing in the doc
 */

/** Shared Antigravity hook catalog (agy-app + agy-cli). */
const AGY_HOOK_CATALOG = {
  captured: ['PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'Stop'],
  available: [],
};

/** @type {Object<string, RegistryEntry>} */
const REGISTRY = {
  claude: {
    status: 'supported',
    provider: 'claude',
    kind: 'ide_agent',
    hookProvider: 'claude',
    captureMode: 'hooks',
    remote: true,
    location: '~/.claude/projects/<slug>/<session>.jsonl',
    extraSources: [],
    liveOnlySources: [
      'local session JSONL mtime poll (~400ms fs.watchFile while needs-input) — triggers immediate watch poller tick; remote SSH watches use the 2s poll only',
    ],
    recordedChannels: ['hook_events', 'transcript_phases'],
    replayChannels: ['hook_events', 'transcript_phases'],
    hookCatalog: {
      // PostToolUse is captured (installed live), but ONLY as an activity ping for the gate-pause
      // resume: the gated tool's PostToolUse fires when a permission prompt is answered, giving the
      // paused watch a gate-precise re-arm instead of resuming on the in-flight tool's stale
      // "generating" (the needs-input<->working bounce). The claude hook store treats it as benign
      // activity (never a completion/permission event). See watch_tracker shouldResumeIdeAgentWatch.
      captured: ['UserPromptSubmit', 'SessionStart', 'Stop', 'PermissionRequest', 'Notification', 'PostToolUse'],
      available: [
        'Setup',
        'InstructionsLoaded',
        'UserPromptExpansion',
        'MessageDisplay',
        'PreToolUse',
        'PostToolUseFailure',
        'PostToolBatch',
        'PermissionDenied',
        'SubagentStart',
        'SubagentStop',
        'TaskCreated',
        'TaskCompleted',
        'StopFailure',
        'TeammateIdle',
        'ConfigChange',
        'CwdChanged',
        'FileChanged',
        'WorktreeCreate',
        'WorktreeRemove',
        'PreCompact',
        'PostCompact',
        'SessionEnd',
        'Elicitation',
        'ElicitationResult',
      ],
    },
    // Surfaces sharing this entry (same provider id `claude`, same hook store + watch logic) all
    // emit the SAME hook catalog — including PermissionRequest + the tool hooks. Verified 2026-06-29:
    // a `claude-code-desktop --scenario permission` run emitted UserPromptSubmit, PreToolUse,
    // PostToolUse, PostToolBatch, PermissionRequest, MessageDisplay, and Stop (signal-lab run
    // ccds-permission-2026-06-29T11-35-50-032Z).
    //   - claude-code-desktop (Claude Desktop app), claude-code (CLI), and claude-code-plugin (the
    //     Claude Code extension driven inside Cursor) all emit the full catalog (UserPromptSubmit,
    //     Stop, SessionEnd, MessageDisplay, PreToolUse/PostToolUse, PermissionRequest, SubagentStop, …).
    //   All surfaces emit the same UserPromptSubmit resume heralds (<task-notification> for
    //   background tasks, the cron's prompt verbatim for cron fires) and the same Stop body
    //   (background_tasks + session_crons), so the done-detection is identical across them.
    surfaces: {
      'claude-code-desktop': { hookEvents: 'full catalog (see hookCatalog)', note: 'Desktop app matches the CLI surface — emits PermissionRequest + tool hooks, not just UserPromptSubmit/Stop (verified live 2026-06-29).' },
      'claude-code-cli': { hookEvents: 'full catalog (see hookCatalog)', note: 'CLI emits SessionEnd, MessageDisplay, tool hooks, SubagentStop, etc.' },
      'claude-code-plugin': { hookEvents: 'full catalog (see hookCatalog)', note: 'The Claude Code plugin (the Claude Code extension driven inside Cursor, opened via the command palette) uses the SAME signals as claude-code — identical hook catalog + transcript + done/gate/re-arm logic; only the capture DRIVER differs (Cursor AX for gates + command-palette navigation). signal-lab surface: claude-code-plugin (scripts/sessions/claude_code_plugin_signal_session.js).' },
    },
    // Backend state captured on each Stop snapshot (claude_hook_store) and surfaced for a future
    // "running / scheduled" view. Does NOT change the tracking flip — it is attribution only.
    backendState: [
      { field: 'background_tasks', detail: 'running supervised shell tasks at the Stop (id/type/status/description/command). A Stop with any running SHELL task is "busy" → held for the BOUNDED busy-hold, TIERED since 2026-07-07 by the session\'s latest TodoWrite state (the agent\'s stated remaining work, read from the production PostToolUse stream): unfinished todos → the full backstop (backgroundTaskHoldMs, 30min since 2026-07-06; env CLAUDE_BACKGROUND_TASK_HOLD_MS), a non-empty ALL-COMPLETED list → todoDoneHoldMs (3min; env CLAUDE_TODO_DONE_HOLD_MS), no list ever written → noTodoHoldMs (5min; env CLAUDE_NO_TODO_HOLD_MS). The task-exit notification is the real completion signal — it re-invokes the session, so every finite task (waiters, multi-minute builds) resumes inside the hold with no flicker; the caps are the CRASH/ETERNAL-TASK/ABANDONED-WATCHER BACKSTOPS, not the clearing mechanism. The resolved window is stamped on the snapshot at the Stop (completion_busy_hold_ms + todo_state). Resolution telemetry: [claude-busy-hold] server-log lines (resumed vs cap_expired, with todo_state) + busy_hold_cap_cleared_at stamped on the tracking. A running {type:"subagent"} entry is a backgrounded Task/Agent still working: that Stop HOLDS tracking outright (no cap) until a later Stop reports no running sub-agent.' },
      { field: 'session_crons', detail: 'scheduled crons registered at the Stop (id/schedule/recurring/prompt; incl. ScheduleWakeup self-reminders). A Stop with pending crons is "busy" → debounced; crons no longer block done — EXCEPT a near-future ONE-SHOT wakeup cron (recurring:false, fire ≤10min out — the ScheduleWakeup shape: delaySeconds is converted to the next minute-boundary "m H * * *" slot), which HOLDS working until max(fire, stop)+120s grace (cronWakeupHoldDeadlineMs, shared with done_detection; 2026-07-06 wakeup-hybrid decision, the claude mirror of codex\'s heartbeat hold). The cron prompt\'s UserPromptSubmit resumes inside the hold with no flicker (observed stop→fire 92s); no wake by the deadline (cron cancelled / app quit) → bounded release. Recurring or far-future crons keep plain cron semantics (15s debounce; fire re-arms = tolerated flicker).' },
    ],
    // Done flips on idle OR debounce, and a resume can flip back (flicker):
    //   - idle Stop (no running background_tasks AND no pending session_crons) → done immediately.
    //   - busy Stop with a running background SHELL task → held for the BOUNDED busy-hold,
    //     TIERED by the session's TodoWrite state (2026-07-07; resolveBusyHoldMs in
    //     done_detection): unfinished todos → 30min backstop (backgroundTaskHoldMs, since
    //     2026-07-06; was 120s), all-completed list → 3min (todoDoneHoldMs), no list → 5min
    //     (noTodoHoldMs). Claude re-invokes the session when the task finishes, so EVERY finite
    //     task — sleep-and-check-back waiters (observed gaps 50–96s, 214s/232s) and multi-minute
    //     builds/tests alike — resumes inside the hold with NO flicker and clears at its true
    //     finish. The caps are the crash/eternal-task/abandoned-watcher BACKSTOPS (dev server
    //     that never exits, claude quit/crash mid-task, watcher loops left behind after the
    //     agent already finished — no signal will ever come), not the clearing mechanism.
    //     Backtest 2026-07-07 (196 sessions, 103 busy Stops): todo state predicted
    //     resumed-vs-final with ZERO misclassifications. Crons-only busy Stops keep the 15s
    //     debounce (a scheduled future wake-up is not running work) — with ONE carve-out: a
    //     near-future ONE-SHOT wakeup cron (ScheduleWakeup; recurring:false, fire ≤10min) holds
    //     until max(fire, stop)+120s grace, so the agent's own "coming right back" scheduler
    //     never shows an intermediate done (2026-07-06; mirrors codex's heartbeat hold).
    //     Recurring / far-future crons never hold. A resume within the window
    //     keeps tracking (no flicker); a resume after it re-arms tracking (done→tracking
    //     flicker). Resume = ANY UserPromptSubmit (task-notification, cron-fired prompt, or human
    //     message) — tracking follows generation.
    //   - Stop with a running SUB-AGENT (background_tasks {type:'subagent',status:'running'}) →
    //     HELD indefinitely, never a done. The Stop body is the reliable cascade signal: the true
    //     final Stop always reports no running sub-agent. (The SubagentStart/SubagentStop hooks
    //     fire asymmetrically — orphan Stops, counts up to 2× Starts, verified live 2026-06-30
    //     Start:1/Stop:2 · Start:4/Stop:8 — so counting them can NOT close this; they stay under
    //     hookCatalog.available.) This closes the sub-agent transient early-clear that used to
    //     flicker the watch (the claude analogue of codex's subagent-outlives-parent knownGap),
    //     with no latency penalty on the true final Stop.
    flickerBehavior: {
      debounce_ms: 15000,
      busy_hold_ms: 1800000,
      todo_done_hold_ms: 180000,
      no_todo_hold_ms: 300000,
      idle_clear: 'immediate',
      busy_clear: 'running shell task → at the task-exit notification (resume), else the todo-tiered backstop (unfinished todos 30min / all-done list 3min / no list 5min); crons-only → after the 15s debounce, EXCEPT a near-future one-shot wakeup cron (ScheduleWakeup) → held to max(fire, stop)+120s grace (cron_wakeup_hold)',
      cron_wakeup_hold: 'one-shot recurring:false cron with fire ≤10min of the Stop → hold until fire+120s grace; the cron-fired UserPromptSubmit resumes seamlessly (no flicker), a missed wake releases at the deadline. Recurring/far-future crons never hold.',
      subagent_running_stop: 'HELD — no clear while the Stop body reports a running subagent; releases on the next Stop with none (fixes the sub-agent early-clear flicker, zero added latency)',
      resume_within_window: 'stays tracking (seamless)',
      resume_after_window: 'done shown then re-tracks (flicker — tolerated)',
      reactivation_trigger: 'any UserPromptSubmit (cause stored as backend state, not gated on)',
    },
    // Unique claude signal patterns and how tracking handles them — WORKING behavior, not gaps.
    // (Graduated from knownGaps 2026-07-06; ids kept stable for external docs.)
    specialCases: [
      {
        id: 'busy-shell-bounded-hold',
        summary:
          'Background SHELL task running at the final Stop → "working" holds until the task-exit notification resumes the session, bounded by a TODO-TIERED backstop cap (2026-07-07): unfinished todos → 30min (backgroundTaskHoldMs), non-empty all-completed todo list → 3min (todoDoneHoldMs), no todo list → 5min (noTodoHoldMs). The caps exist only for the no-signal cases: an eternal task (dev server), an abandoned watcher loop, or a crashed/quit claude, where no notification will ever come.',
        status:
          'todo tiers added 2026-07-07 (maintainer decision, from the 206Z/705Z long-run analysis): the flat 30min cap (raised from 120s 2026-07-06) made a finished agent with leftover watcher tasks show working for 30min. The TodoWrite list in the session\'s own PostToolUse stream is the agent\'s STATED remaining work — a structured channel the 2026-07-03 task-body audit never evaluated. Backtest over the full claude bank+lab archive (196 sessions, 103 busy Stops): ZERO misclassifications — every busy Stop with unfinished todos resumed, the all-done Stops were the true finals; no-list resume gaps maxed at 214s, so 5min covers with margin (2–3min would have flickered once). Env-tunable (CLAUDE_BACKGROUND_TASK_HOLD_MS / CLAUDE_TODO_DONE_HOLD_MS / CLAUDE_NO_TODO_HOLD_MS); resolution telemetry ([claude-busy-hold] resumed/cap_expired + todo_state, busy_hold_cap_cleared_at on the tracking) gathers production data to re-tune the tiers.',
        detail:
          'The task-exit notification (a task_resume UserPromptSubmit) is the real completion signal: every finite task resumes the session inside its tier with NO flicker and clears at its true finish (observed waiter gaps 50–96s and 214s/232s — all under unfinished-todos Stops, far inside the 30min tier). The tier is resolved AT the Stop from the session\'s latest TodoWrite (todoStateFromTodos/resolveBusyHoldMs in done_detection, shared with claude_hook_store — predicate parity; sub-agent TodoWrite events are excluded by the child-transcript guard, and only the parent-transcript PostToolUse stream counts). Signature at a cap expiry: done clears at lastStop+tier while background_tasks still lists the running shell — marked busy_hold_cap_cleared_at. FAILURE DIRECTIONS are asymmetric by design: a stale unfinished list at the true end degrades to today\'s 30min-late done (no regression); an all-done list followed by unexpected further work costs one re-armed flicker. Sub-agent entries are exempt (indefinite hold, see subagent-early-clear); crons-only busy Stops keep the 15s debounce. TESTING consequence: a 30min-tier (unfinished-todos) hold cannot observe its cap clear inside a lab run — the capture extension is bounded (BUSY_HOLD_CAPTURE_EXTEND_MAX_MS 180s, busy_hold.extension_skipped stamped) and done grading defers to done-tracking extrapolation; the 3min all-done tier IS observable inside the extension. Recordings stamp their tier config (busy_hold.hold_ms = resolved final-stop tier, backstop_hold_ms + todo_done_hold_ms + no_todo_hold_ms, and done_tracking.config); replay honors the stamps, and a pre-tier recording without them has both tiers pinned to its flat hold_ms so its simulated clear cannot move. The sanitizer keeps the todo status enum and redacts todo prose (sanitizeTodoWriteToolInput). REJECTED — do NOT retry: (a) removing the caps entirely (hold-until-signal) — a crash/quit mid-task leaves a PERMANENTLY stuck "working" row, since neither surface delivers a bail-out signal Orchestra ingests (SessionEnd is not in the captured set; Desktop never emits it); (b) content-sniffing task descriptions/commands to guess whether a task will exit — the 2026-07-03 signal audit (claude-code findings §8.1) proved the final Stop bodies of the eternal-task and waiter cases are structurally IDENTICAL; the todo list resolves this from a DIFFERENT channel (stated intent), not from the task entries; (c) prose-sniffing last_assistant_message wait-intent — separated 50/50 on the same data but is model-phrasing-dependent; superseded by the structured todo enum before shipping.',
      },
      {
        id: 'cron-wakeup-hold',
        summary:
          'Self-scheduled wakeup (ScheduleWakeup → a near-future ONE-SHOT cron) at the Stop → "working" holds until max(fire, stop)+120s grace, so the agent\'s own "coming right back" scheduler never shows an intermediate done. Recurring or far-future crons keep plain cron semantics (15s debounce; fire re-arms = tolerated flicker).',
        status: '2026-07-06 wakeup-hybrid decision (the claude mirror of codex\'s heartbeat hold); shared constant cronWakeupHoldDeadlineMs with done_detection',
        detail:
          'Detection: a session_crons entry with recurring:false whose next fire is ≤10min out (ScheduleWakeup converts delaySeconds to the next minute-boundary "m H * * *" slot). Hold window: max(fire, stop)+120s grace — anchored so a fire time that already passed mid-turn still gets the post-Stop delivery grace. Release: the cron prompt\'s UserPromptSubmit resumes inside the hold with no flicker (observed stop→fire 92s); no wake by the deadline (cron cancelled / app quit) → bounded release to done. Rationale: a one-shot near-future wake is a continuation of the CURRENT task ("check back in 2 minutes"), not a standing schedule — unlike recurring/far-future crons, which are scheduled jobs and must not hold a finished turn. Crons otherwise never block done; they are stored as backend state (see backendState.session_crons).',
      },
      {
        id: 'subagent-early-clear',
        summary:
          'Backgrounded Task/Agent sub-agent running at a parent Stop → the Stop body\'s background_tasks {type:"subagent",status:"running"} entry HOLDS tracking (no cap) until a later Stop reports no running sub-agent (the true final Stop). The claude analogue of codex\'s subagent-outlives-parent-false-clear.',
        status: 'fixed on claude-code-fixes; live-validated on both surfaces (CLI robust-sub-agent HELD×3 flickers=0; desktop robust-sub-agent — the old −94s false clear — HELD×3 flickers=0)',
        detail:
          'The reliable cascade signal is the STOP BODY, not the SubagentStart/SubagentStop hooks. Sub-agents hold WITHOUT a cap — unlike shell tasks — because a sub-agent is bounded agent work whose termination is always signaled (the next Stop reports it gone); the shell-task ambiguity does not exist here. REJECTED heuristic — do NOT retry: counting SubagentStart vs SubagentStop to detect cascade quiet. Falsified live repeatedly: the hooks fire asymmetrically (orphan Stops with no matching Start; Stop counts up to 2× Start — observed Start:1/Stop:2, Start:4/Stop:8 across the 2026-06-30 and 2026-07-02 corpora), so any counting scheme mis-tracks. The Stop body is authoritative: every captured true final Stop reports an empty running-sub-agent list.',
      },
    ],
    knownGaps: [
      {
        id: 'desktop-parallel-arm-model-slack',
        summary:
          'claude-code-desktop parallel REPLAY-MODEL limitation: the replay engine arms a pre-bound parallel sub-recording near sim start, so leg 2\'s picker-row delta always reads ≈ −(inter-leg send spacing) (~−11s live: 7s AX pacing sleep + new-chat navigation + generation wait). GT is exact; the arm model is the coarse side.',
        status: 'expected shape — leg prompt signals are declared gt_precision:"approximate" (warn 5s / fail 30s); a ~−11s WARN on agent_2_sent is normal, not a signal miss',
        detail:
          'Verified that per-leg watch_link.linked_at does NOT move the modeled arm (tested directly). A genuinely unbound leg fails the per-leg bind check ("could not bind every parallel leg…"), so widening the prompt budget cannot mask a real binding failure. Do not tighten the budget back below the live inter-leg spacing: the 2026-07-03 desktop parallel run produced a spurious diagnostic fail at the old 10s budget on an otherwise-correct run.',
      },
      {
        id: 'framework-gt-scoping-artifacts',
        summary:
          'FRAMEWORK-side (not product) round-2 artifacts on claude surfaces — classify, do not re-file as Orchestra gaps: (a) orphan trailing SubagentStop hooks inflating --timer-done GT; (b) the naive replay done-bound refusing done_tracking-authoritative clean passes at the promote gate; (c) desktop capture-shape residuals R1 (transcript-flush lag ~10–12s after the Stop hook) and R2 (single-done recording + mid-cascade idle-Stop churn).',
        status: 'addressed 2026-07-05 in the framework: orphan SubagentStop excluded from the timer-done meaningful-activity anchor (claude only — codex SubagentStop is a real worker-end signal); promote/bank replay defers done grading to the done_tracking authority for recordings stamped done_tracking-authoritative',
        detail:
          'Orchestra was CORRECT in every one of these shapes: it rightly ignores a lone orphan SubagentStop (no re-arm — only UserPromptSubmit resumes), rightly clears at the idle Stop, and the live verdict (done_tracking: ENDED/settled/flickers) passed. The artifacts lived in GT scoping (--timer-done treating the orphan hook as last meaningful activity, pushing GT-done +15–28s) and in the promote gate grading done via the legacy ±10s replay delta instead of the done_tracking channel that drives the live verdict. Keep this entry so future audit rounds recognize the shapes instead of re-filing them.',
      },
    ],
    sources: [
      {
        outcome: 'generating',
        via: 'hook',
        detail:
          'UserPromptSubmit (prompt submitted) arms/links the watch and the agent reads as generating (confirmed by classifyClaudeActiveGenerationFromText over the transcript) → the run is added to the Orchestra picker. Same first signal across Desktop (UserPromptSubmit only) and CLI/plugin.',
      },
      {
        outcome: 'done',
        via: 'hook',
        detail:
          'Stop hook: an idle Stop (no running background_tasks, no pending session_crons) clears to done immediately; a Stop with a running background SHELL task is held for the BOUNDED busy-hold, TIERED by the session\'s TodoWrite state since 2026-07-07 (unfinished todos → 30min backstop backgroundTaskHoldMs; non-empty all-completed list → 3min todoDoneHoldMs; no list → 5min noTodoHoldMs — the task-exit notification re-invokes the session, so finite tasks clear at their true finish with no flicker; only a no-signal eternal task/abandoned watcher/crash settles at its tier cap, marked busy_hold_cap_cleared_at); a crons-only busy Stop clears after the 15s debounce (stopDebounceMs) — unless it carries a near-future ONE-SHOT wakeup cron (ScheduleWakeup; recurring:false, fire ≤10min), which HOLDS until max(fire, stop)+120s grace so the agent\'s own scheduler never shows an intermediate done (cronWakeupHoldDeadlineMs, 2026-07-06; the cron-fired UserPromptSubmit resumes seamlessly, a missed wake releases at the deadline). A Stop whose body reports a running {type:"subagent"} background task is HELD — never cleared — until a later Stop reports no running sub-agent (the true final Stop), so a backgrounded Task/Agent outliving the parent turn shows working, not done. A resume (any UserPromptSubmit) within the window keeps tracking; after it, tracking re-arms (flicker). session_crons otherwise never block done — they are stored as backend state. Transcript end_turn alone does NOT clear.',
      },
      {
        outcome: 'permission',
        via: 'hook',
        detail: 'PermissionRequest / permission-prompt Notification clears watch to needs-input (gate=permission)',
      },
      {
        outcome: 'question',
        via: 'hook',
        detail: 'AskUserQuestion clears watch to needs-input as PermissionRequest (gate=permission, not question)',
      },
      {
        outcome: 'resume',
        via: 'hook',
        detail:
          'after a permission/question gate: the gated tool\'s PostToolUse hook (now captured) re-arms the watch — it fires when the prompt is answered (the tool runs), a GATE-PRECISE resume. While the gate is still pending the transcript active-generation resume is SUPPRESSED (the in-flight tool that triggered the gate reads as "generating"), so the watch holds needs-input until PostToolUse or the terminal Stop — no needs-input<->working bounce.',
      },
      {
        outcome: 'resume',
        via: 'transcript',
        detail:
          'user tool_result in the transcript marks the gate ANSWERED — it drops the stale permission/question completion-hint on the pause side (claude emits no permission-resolved hook). The re-arm itself is the PostToolUse hook above; this transcript signal stops the pause side from re-asserting needs-input.',
      },
      { outcome: 'cancelled', via: 'transcript', detail: '[Request interrupted by user] row' },
    ],
    replayModes: ['both', 'hooks-only', 'transcript-only'],
    ssh: {
      supported: true,
      hookDelivery:
        'Remote hook script POSTs to Orchestra. Default install route opens a reverse SSH tunnel and writes a remote remoteApiBase pointing at http://127.0.0.1:<remotePort> (48725 dev / 48726 stable); the $SSH_CLIENT → control-Mac LAN-IP POST is a fallback (and the route the live agent_watch_harness uses). Same hook catalog as local. On transcript-only completion without a Stop POST (e.g. curl --max-time timeout), server synthesizes a Stop into the hook store (with remote_host).',
      hookInstall: 'POST /api/projects/:id/claude-hooks/install-remote → opens reverse hook tunnel, then ~/.claude/settings.json merge + task-app-claude-hook.sh',
      transcriptRead:
        'Bounded SSH read for shouldCompleteRemoteClaudeWatch (remoteClaudeWatchCompletionSince): one exec emits byte-size + tail -c 512 KiB(+1 probe byte, for exact line-boundary handling); a full cat runs ONLY when a mid-file tail found a terminal result (first-match-wins confirmation on the clearing poll — the 2s steady-state polls stay bounded). SSH tail -c for resume (remoteClaudeWatchActiveGenerationSince), permission-hint stale check, and picker enrichment. Recorder tails 512 KiB per phase (fetch_ms).',
      unavailable: [
        'local session JSONL mtime poll (~400ms fs.watchFile while needs-input) — remote uses the 2s watch poller only',
      ],
      differences: [
        'watch poller uses shouldCompleteRemoteClaudeWatch (remoteClaudeWatchCompletionSince) instead of local file read — bounded tail-first, confirming cat only on the poll that would clear',
        'paused resume: remoteClaudeWatchActiveGenerationSince over SSH tail',
        'paused cancel while needs-input: remoteClaudeTranscriptCancelSince over SSH tail -c 512 KiB',
        'permission-hint stale drop: remote tail read (isClaudePermissionCompletionHintStale)',
        'picker rows tagged source:ssh + host + projects_root; transcript tail enriched over SSH',
        'picker discovery fallback (fixes arm-never-appears with the reverse hook tunnel down at prompt time): a remote host with ZERO hook-snapshot rows falls back to ssh transcript discovery (discoverRemoteClaudeRuns — find + tail of ~/.claude/projects), deduped against snapshot rows by transcript/session, workspace-gated, and stamped host/remote_host/state_location for host-gating',
      ],
      replay:
        'shouldCompleteRemoteClaudeWatch runs the same recorded transcript predicate as local; only the real SSH read is skipped. fetch_ms on each transcript phase models remote round-trip cost in modeled_e2e_ms.',
      note:
        'Clock-skew caveat: transcript-internal timestamps are on the remote host; compare against linked_at on the control Mac — keep both on NTP.',
    },
    note:
      'Needs-input → tracking: transcript tool_result is the fastest resume signal (signal-tail captures show no hook between answer and tool_result). Live server also polls local transcript mtime during pause (~400ms) and treats any post-pause hook as a resume fallback. UI refresh while paused is 2s. Stale permission hints are dropped once transcript shows a user tool_result after the hook. For done: an idle Stop clears immediately; a busy Stop (running background_tasks or pending session_crons) is held for the 15s debounce (stopDebounceMs) then clears — a resume within the window keeps tracking, after it tracking re-arms (flicker). session_crons no longer block done; background_tasks + session_crons are stored on the snapshot as backend state for a future running/scheduled view (see surfaces/backendState/flickerBehavior). The UI still shows tracking → done; the extra state is backend-only. Same logic across Claude Desktop (UserPromptSubmit+Stop only, no SessionEnd) and the CLI/plugin (full catalog). The `claude-code-plugin` surface (the Claude Code extension driven inside Cursor via the command palette) uses the SAME signals as `claude-code` — identical hooks, transcript, and done/gate/re-arm logic; only the capture driver differs (Cursor AX for gates).',
  },
  // The Cursor IDE (Agents window) surface. Split from the former combined `cursor` entry — the CLI
  // is cursor_cli below. Live Orchestra watch_tracking still uses the production `cursor` provider key
  // (getRegistryEntry redirects 'cursor' here); signal-bank/replay use `cursor_ide` to keep IDE and CLI
  // recordings in distinct bank paths.
  cursor_ide: {
    status: 'supported',
    provider: 'cursor_ide',
    kind: 'cursor',
    hookProvider: 'cursor',
    captureMode: 'hooks',
    remote: true,
    location: '~/.cursor/projects/<slug>/agent-transcripts/<run>/<run>.jsonl',
    extraSources: [
      '~/Library/Application Support/Cursor/logs/**/renderer*.log (wakelock — main-agent permissions + question gate + active composerId per window)',
      '~/Library/Application Support/Cursor/logs/**/exthost/anysphere.cursor-agent-exec/Cursor Agent Exec.log (main-agent shell permission gate)',
      '~/Library/Application Support/Cursor/User/globalStorage/state.vscdb → ItemTable composer.composerHeaders (SUB-AGENT permission gate: a child composer\'s hasBlockingPendingActions flag, attributed to the parent via subagentInfo.rootParentConversationId — read by lib/cursor_subagent_gate_probe.js; DEBOUNCED ~20-60s, see the subagent-gate note)',
    ],
    liveOnlySources: [],
    recordedChannels: ['hook_events', 'transcript_phases', 'renderer_events'],
    replayChannels: ['hook_events', 'transcript_phases', 'renderer_events'],
    hookCatalog: {
      // Forwarded to the live app (these are what ensureLocalCursorHooksInstalled installs).
      // preToolUse/postToolUse/postToolUseFailure were promoted from `available` to drive
      // cursor-CLI config-eval permission inference (lib/cursor_cli_permission.js); the IDE
      // also fires them but the server gates that path to CLI hooks by cursor_version.
      captured: [
        'beforeSubmitPrompt',
        'stop',
        'sessionStart',
        'sessionEnd',
        'subagentStart',
        'subagentStop',
        'preToolUse',
        'postToolUse',
        'postToolUseFailure',
      ],
      available: [
        'beforeShellExecution',
        'beforeMCPExecution',
        'afterShellExecution',
        'afterMCPExecution',
        'beforeReadFile',
        'afterFileEdit',
        'beforeTabFileRead',
        'afterTabFileEdit',
        'afterAgentResponse',
        'afterAgentThought',
        'preCompact',
      ],
    },
    sources: [
      { outcome: 'generating', via: 'hook', detail: 'beforeSubmitPrompt hook (prompt submitted) starts the watch → the run is added to the Orchestra picker; renderer.log active composerId attributes window→conversation.' },
      { outcome: 'done', via: 'hook', detail: 'stop / sessionEnd hook (status=completed), GATED by the cursor continuation check (lib/cursor_cli_continuation.js, shared with the CLI): a completed stop HOLDS while any transcript in the parent\'s agent-transcripts/<conv>/subagents/ underdir (created after linked_at) does not yet end with turn_ended — the IDE\'s Task sub-agents write there, and subagentStop hooks are UNRELIABLE (observed never firing while a child ran 90s past the parent stop). sessionEnd and aborted stops are never held; runs without sub-agent/continuation machinery clear instantly.' },
      { outcome: 'cancelled', via: 'hook', detail: 'stop / sessionEnd hook (status=aborted/cancelled)' },
      { outcome: 'permission', via: 'renderer', detail: 'renderer.log wakelock (user-approval-requested) — main-agent shell permissions and question gates; does NOT fire for sub-agent shell permissions' },
      { outcome: 'permission', via: 'agent_exec', detail: 'Cursor Agent Exec.log "Shell permissions: requesting shell approval" — MAIN-agent shell permission signal. Conversation resolved via co-located renderer.log active composerId (agent-loop wakelock). NOTE: despite the earlier "universal" claim, this did NOT fire for a SUB-AGENT\'s shell/write gate in the validated sub-agent-permission scenario (2026-07-03) — see the composer_headers source below.' },
      { outcome: 'permission', via: 'composer_headers', detail: 'state.vscdb ItemTable composer.composerHeaders — a SUB-AGENT composer\'s hasBlockingPendingActions=true, attributed to the parent watch via subagentInfo.rootParentConversationId. This is the ONLY signal that fires for a sub-agent shell/write gate (renderer wakelock is main-composer-only; the agent-exec log stayed silent). DEBOUNCED: the ~3.8MB blob flushes on a >15s debounce so the gate lands ~20-60s late. lib/cursor_subagent_gate_probe.js createComposerHeadersGateProbe reads it (copy db+wal to tmp, mtime-gated + read-throttled) and emits permission_requested / permission_cleared(clear_reason=approved) parent-attributed — the SAME event shape the renderer probe emits, so it rides recordedChannels.renderer_events with no new channel. Wired into cursor_live_probe (recorder) AND server.js pollRemoteHookLogs (production).' },
      { outcome: 'question', via: 'transcript', detail: 'pending AskQuestion in the transcript — only sometimes written; real captures often surface the question via renderer.log as gate=permission instead' },
      { outcome: 'resume', via: 'renderer', detail: 'renderer.log permission_cleared (clear_reason=approved) resumes the paused watch (resumeWatchTracking) — the explicit gate-answered signal; a fresh stop hint blocks a stale resume.' },
      {
        outcome: 'resume',
        via: 'hook',
        detail:
          'done→working re-arm: a fresh generating beforeSubmitPrompt/sessionStart for a conversation whose watch already FINISHED re-links that same task to working (applyCursorHookResume in server.js, matched by conversation_id or transcript_path; the cursor branch in the replay hook loop mirrors it exactly). This is the same-watch resume that happy-path-again\'s done_to_working signal grades — a new picker row does NOT count.',
      },
    ],
    replayModes: ['both', 'hooks-only', 'transcript-only', 'renderer-only'],
    ssh: {
      supported: true,
      location:
        '<remote-host>:~/.cursor/projects/<slug>/agent-transcripts/<run>/<run>.jsonl (Cursor IDE runs on the control Mac; transcript file lives on the SSH workspace host)',
      hookDelivery:
        'Primary: local Cursor IDE hook POSTs (same as local — IDE is on the control Mac). Secondary: server polls ~/.cursor/task-app-hook-events.jsonl on each configured cursor_remote every ~1s for events written on the remote host (tagged source:ssh).',
      hookInstall: 'POST /api/projects/:id/cursor-hooks/install-remote → remote hooks.json + task-app-cursor-hook.sh',
      transcriptRead:
        'SSH cat or find+tail under cursor_remote.projects_root (readCursorTranscriptText / discoverRemoteCursorRuns). resolveCursorTranscriptPath SSH-finds missing paths. Recorder tails 512 KiB per phase (fetch_ms).',
      unavailable: [
        'discoverLocalPendingAskQuestionRuns workspace scan — ssh watches rely on the linked transcript only',
        'cursor multitask sub-agent watch (cursor_multitask_subagent) — disabled when source:ssh',
      ],
      differences: [
        'renderer.log stays LOCAL on the control Mac and is the SOLE main-agent gate channel over ssh. Cursor Agent Exec.log MOVES REMOTE for a Remote-SSH workspace (the workspace ext-host runs in ~/.cursor-server on the remote — Step-0 probe 2026-07-07: 23 exec.log files under remote .cursor-server, none local for the remote window), so the local cursor_probe exec.log dedup/corroboration arm is DEAD over ssh and an exec.log-ONLY gate would be missed. state.vscdb (sub-agent composerHeaders gate) stays local.',
        'watch poller uses shouldCompleteRemoteCursorWatch (same predicate, SSH transcript read)',
        'paused resume: shouldCompleteRemoteCursorWatch on SSH transcript (no renderer-only path on remote transcript)',
        'child (Task) sub-agent transcripts live in the REMOTE subagents/ underdir: the production continuation gate scans them over ssh (createRemoteContinuationOps underdir scan — engages when the watch carries source:ssh + host + the remote transcript_path), and since 2026-07-07 (TG-CID-1 fix) the recorder mirrors that read (_pollSubagentsRemote → sibling_tasks source) so cursor_continuation is populated over ssh and the sub-agent hold is graded, not hollow-passed.',
      ],
      replay:
        'shouldCompleteRemoteCursorWatch uses recorded transcript; renderer_events replay locally. fetch_ms models SSH transcript read cost.',
      note:
        'Two distinct ssh paths share this surface. (1) Orchestra\'s LIVE remote-cursor-workspace watch — the location/transcriptRead/differences above (server reads the remote transcript over ssh; renderer stays local; exec.log is remote+unread — see differences). (2) The signal-lab `--source ssh` HARNESS for cursor-ide — the Cursor GUI + AX driver stay LOCAL (watch-only, no remote launch) and the remote agent\'s hooks reach Orchestra via the reverse tunnel, so done/clear is driven by the remote stop hook. Capture sources over ssh: the mixed `cursor_probe` runs identically (its local arms — hook API, renderer.log, AX — are local-by-nature; its exec.log arm is blind for a remote workspace, see differences), the transcript is remote-read, and the child subagents/ underdir is remote-read via the sibling_tasks source (TG-CID-1 fix 2026-07-07).',
    },
    // Unique cursor-ide signal patterns and how tracking handles them — WORKING behavior, not gaps.
    specialCases: [
      {
        id: 'subagent-outlives-parent-false-clear',
        summary:
          'Task sub-agent running past the parent `stop` hook → the completed stop is HELD by the cursor continuation gate while any subagents/-underdir transcript (created after linked_at) has not yet ended with turn_ended; subagentStop hooks are unreliable (observed never firing while a child ran 90s past the parent stop) so the transcript is the authority.',
        status: 'fixed-2026-07-02; live-validated (parent stop 32.5s, child ran to 143.0s, cleared +5.5s after true done — signal-lab/cursor-ide/2026-07-02T11-06-06-144Z)',
        detail:
          'Shared gate with the CLI (lib/cursor_cli_continuation.js); replay parity via recording.cursor_continuation. EXPECTED SHAPE: the held clear lands ~+5–8s after the child\'s last transcript write (close-grace + settle + poll tick) — a warn-level late done inside the 10s timer-done budget. sessionEnd and aborted stops are never held; runs without sub-agent/continuation machinery clear instantly.',
      },
      {
        id: 'subagent-permission-composerheaders-debounce',
        summary:
          'A SUB-AGENT shell/write permission gate has no renderer wakelock and no agent-exec log line — its only signal is the debounced state.vscdb composer.composerHeaders flag, so needs_input lands ~20–60s late BY DESIGN.',
        status: 'fixed-2026-07-03 (capture+production); live-validated 2026-07-04 (4/4 gates via composer_headers, gate_ok=true — signal-lab/cursor-ide/2026-07-04T00-15-02)',
        detail:
          'When a Task sub-agent (not the main composer) hits a shell/write gate, Cursor fires NO renderer user-approval-requested wakelock and NO Cursor Agent Exec.log line. The ONLY trace is state.vscdb ItemTable composer.composerHeaders: the child composer\'s hasBlockingPendingActions=true + subagentInfo.rootParentConversationId → parent. lib/cursor_subagent_gate_probe.js emits parent-attributed permission_requested/cleared from it, wired into cursor_live_probe + server.js. DESIGNED LATENCY: the ~3.8MB blob is in a multi-GB DB and flushes on a heavy >15s debounce, so needs_input lands ~20–60s after the gate. The harness holds a sub-agent gate up to SUBAGENT_FLIP_TIMEOUT_MS=90s (vs 15s for a parent gate) so the flush lands, and buildRecording widens the sub-agent needs_input/continue fail_ms to SUBAGENT_GATE_FAIL_MS (~105s) so the debounce grades as a WARN, not a FAIL (the busy-shell-bounded-hold pattern). cursor-ide only, isSubAgentScenario-gated; plain permission stays strict. Approval: the gate is NOT keyboard-reachable, so it is clicked via scripts/ax_click (--press Allow --click); detection distinguishes it from a parent gate by button shape ("Allow" vs "Run⏎", lib/cursor_ax_signals hasSubAgentPermissionGate/permissionApprovalMethod).',
      },
    ],
    knownGaps: [
      {
        id: 'cursor-hook-engine-wedge',
        summary:
          'Cursor (the IDE app itself) can silently stop executing ALL hooks.json commands — Orchestra goes blind while agents keep running.',
        detail:
          'SIGNATURE: agent transcripts keep growing but ZERO hook POSTs arrive at any Orchestra instance (no beforeSubmitPrompt, no stop — nothing), so no watch arms or clears. Observed twice on 2026-07-02 (~11:10Z and ~22:02Z), both immediately after a programmatic rewrite/restore cycle of ~/.cursor/hooks.json (the signal-session maximal-hook install); only restarting Cursor re-armed the hook engine. This is a Cursor app bug, not an Orchestra defect, but it is a real production blind spot: a wedged IDE looks identical to an idle one. MITIGATION: signal-lab cursor-ide runs use --no-hooks (the production hooks.json already registers the forwarder on all 20 events; avoids the rewrite trigger). Restarting the IDE also kills any Claude session running in its plugin — warn the operator first. CANDIDATE FIX (product): a server-side staleness detector — transcript mtime advancing for a linked conversation with no hook POSTs for N seconds → surface a "hook feed stale" warning on the watch instead of staying silently green/working.',
        status: 'open — external (Cursor app bug); mitigated in the harness via --no-hooks, no product-side detector yet',
      },
      {
        id: 'cursor-second-stop-hook-unreliable',
        summary:
          'Cursor reliably delivers the FIRST/single stop hook of a session (done Δ0ms), but a SECOND stop hook in the same session — a follow-up turn\'s seed stop, or the first-finisher of two concurrent legs — is dropped or delivered ~90–170s late.',
        detail:
          'Round-2 (2026-07-04): every single-turn done/gate/cancel/background scenario graded done Δ0ms, but happy-path-again failed 3/3 (the seed turn\'s stop hook never arrived before the follow-up resumed — Orchestra correctly never manufactured the done_to_working re-arm because the watch never finished) and parallel failed 2/2 (the first-finishing leg\'s stop landed ~170s/~94s late while the later leg\'s stop was on time; Orchestra correctly clears a leg only on that leg\'s stop). This is a PARTIAL sibling of cursor-hook-engine-wedge: the feed is alive (prompts + the final stop arrive) but the mid-session stop is superseded/deferred by Cursor. Orchestra behavior is correct in both shapes — the defect is upstream. MITIGATIONS: harness — the happy-path-again driver gates the follow-up send on the seed stop/clear (not AX-idle) so the race is not self-inflicted; product candidates (not implemented) — a concurrent-leg / seed-turn quiescence backstop that clears a leg on its own conversation-scoped transcript quiet when its stop hook is overdue, analogous to the continuation gate\'s transcript-tail release.',
        status: 'open — external (Cursor hook engine); harness mitigation in the happy-path-again driver; no product-side backstop yet',
      },
      {
        id: 'no-hooks-grading-depends-on-live-forwarder',
        summary:
          'signal-lab --no-hooks grading (the cursor-hook-engine-wedge mitigation) still depends on the PRODUCTION hooks.json forwarder feeding a LIVE Orchestra server — if either is down, every scenario reads cleared=false and the failure is environmental, not a product gap.',
        detail:
          'Under --no-hooks the recorder does not install its own hook capture (recordings carry hook_events:0 by construction); the watch arms/clears via the production hooks/task-app-cursor-hook.sh forwarder posting to the live server, and the grade is derived from the captured watch/orchestra state. 2026-07-05 case study: sub-agent-parent-early-done and robust-sub-agent graded cleared=false across three runs — root causes were (1) the dev server had died in a host crash (picker "fetch failed"), then (2) a RECURRENCE of cursor-hook-engine-wedge at 15:19:20Z (hook audit log stops; NO hooks.json rewrite preceded it — the wedge coincided with the host crash killing in-flight AppleScript/expect drivers, a new trigger signature vs the rewrite-triggered 2026-07-02 wedges). The same day\'s pre-wedge happy-path-again run graded green end-to-end under --no-hooks (seed stop hook observed via the forwarder, full 5-signal ladder, promoted), proving the mode itself grades fine when the forwarder + server are healthy. GUIDANCE: before grading any cursor-ide run, health-check BOTH the dev server (/api/state) and the hook engine (newest ~/.cursor/hooks/logs/hook-*.json mtime should be recent); a wedged engine needs a Cursor restart (coordinate with the operator — it kills plugin sessions). Do not file cleared=false shapes from an unhealthy window as product gaps.',
        status: 'documented — harness-mode operational dependency; wedge re-observed 2026-07-05 without the rewrite trigger',
      },
    ],
  note: 'Permission gate sources by agent level: MAIN-agent shell permission → renderer.log user-approval-requested wakelock AND/OR Cursor Agent Exec.log (both fire, deduped by pendingByConversation); question gate → renderer.log (+ transcript AskQuestion). SUB-AGENT shell/write permission → NEITHER of those fires; the only signal is the debounced state.vscdb composer.composerHeaders hasBlockingPendingActions flag (lib/cursor_subagent_gate_probe.js, parent-attributed via subagentInfo — see the subagent-permission-composerheaders-debounce knownGap). renderer.log is still needed to resolve window→composerId for the exec probe. signal-bank Cursor IDE recordings use provider `cursor_ide` so replay and bank paths distinguish the IDE from cursor-agent CLI; live Orchestra watch_tracking still uses the production `cursor` key.',
  },
  cursor_cli: {
    status: 'supported',
    provider: 'cursor_cli',
    kind: 'cursor',
    hookProvider: 'cursor',
    captureMode: 'hooks',
    remote: true,
    location: '~/.cursor/projects/<slug>/agent-transcripts/<run>/<run>.jsonl',
    extraSources: [
      'cursor-agent CLI stdout (the TUI capture log) — the ONLY place a permission gate is observable; no renderer.log / "Cursor Agent Exec.log" exist for the CLI',
    ],
    liveOnlySources: [],
    recordedChannels: ['hook_events', 'transcript_phases', 'chat_db_phases', 'renderer_events'],
    replayChannels: ['hook_events', 'transcript_phases', 'chat_db_phases', 'renderer_events'],
    hookCatalog: {
      // Observed set the cursor-agent CLI actually emits (verified 2026-06-16). It is a
      // subset of the cursor IDE catalog: the CLI never fires sessionEnd, subagentStart/
      // Stop, before/afterMCPExecution, before/afterTab*, or preCompact.
      //
      // RELIABILITY CAVEAT (observed 2026-06-26, cursor-agent CalVer 2026.06.24): the per-tool
      // hooks here (preToolUse/postToolUse/beforeShellExecution/afterShellExecution/beforeReadFile/
      // afterFileEdit) fire UNRELIABLY in interactive cursor-agent sessions — runs that executed
      // shell tools (and showed 4 permission prompts) emitted ONLY the conversation-lifecycle hooks
      // (sessionStart, beforeSubmitPrompt, afterAgentThought, stop) with zero tool-level hooks.
      // Because config-eval permission inference (the `permission` source below) depends entirely on
      // preToolUse, the live permission gate can silently fail to surface when the tool hooks don't
      // fire. Confirmed via scripts/cursor_live_log.js. Not investigated further — treat the per-tool
      // hooks as best-effort, not guaranteed.
      captured: [
        'sessionStart',
        'beforeSubmitPrompt',
        'preToolUse',
        'postToolUse',
        'postToolUseFailure',
        'beforeShellExecution',
        'afterShellExecution',
        'beforeReadFile',
        'afterFileEdit',
        'afterAgentThought',
        'afterAgentResponse',
        'stop',
      ],
      available: [],
    },
    sources: [
      { outcome: 'generating', via: 'hook', detail: 'beforeSubmitPrompt hook (prompt submitted) starts the watch → the run is added to the Orchestra picker.' },
      {
        outcome: 'done',
        via: 'hook',
        detail:
          'stop hook with status=completed, GATED by the continuation check (lib/cursor_cli_continuation.js): stop fires once per GENERATION, but a turn can span several generations — a finishing Task sub-agent or a completed background task queues a <system_notification> that cursor injects as a synthetic user record, starting a new generation with its own stop. A completed CLI stop clears only when (1) no tied sibling sub-agent transcript (agent-transcripts/<subagent_id>/ next to the parent) is still open, (2) no Task tool window is awaiting its sub-agent transcript (the dir materializes up to ~5s after the parent stop), (3) no fresh post-stop tool-hook activity, and (4) no new <system_notification> user blob lands in the chat store.db within a ~2.5s settle (observed lag after every non-final stop: 0.8–1.9s). Turns that never used continuation machinery skip the settle — plain runs clear instantly. The transcript turn_ended record CANNOT discriminate: cursor appends it after every generation and retracts it (file rewrite) when a continuation injects.',
      },
      {
        outcome: 'cancelled',
        via: 'hook',
        detail:
          'stop hook with status=aborted (a second stop with status=error also fires). A mid-turn Ctrl-C emits these within ~0.2s and the REPL stays alive — distinct from status=completed, so cancelled IS distinguishable. (Hard SIGINT instead kills the process with NO stop hook.)',
      },
      {
        outcome: 'cancelled',
        via: 'transcript',
        detail:
          'turn_ended with status=aborted and error="User aborted/interrupted manually." — fallback when the stop hook is delayed or missing (~250ms vs ~3s in captures).',
      },
      {
        outcome: 'permission',
        via: 'chat_db',
        detail:
          'PRIMARY (recorder/replay GT + Orchestra derivation, since 2026-07-04). The chat store.db (~/.cursor/chats/<hash>/<conversation_id>/store.db) head blob carries the pending TOOL CALL the instant a permission gate renders (providerOptions.cursor.pendingToolCallStartedAtMs), the same early channel as the question signal — but for a gateable tool (Shell/Read/Write/WebFetch/Mcp) rather than AskQuestion. lib/cursor_cli_subagent_gate.js pendingGatesFromBlobJson maps each store.db tool-call block into a synthetic preToolUse body and reuses the SAME config-eval (lib/cursor_cli_permission.js extractToolCall+evaluateToolCall) to keep only decision==="prompt". rendererEventsFromStoreDbPermission (cursor_cli_signal_session.js) turns the rising edge into permission_requested and the falling edge into permission_cleared:approved, tagged source:"store_db", and the replay drives the SAME production applyCursorRendererPermissionEvents that the IDE renderer/composerHeaders probes feed (rides renderer_events). This is deliberately NON-CIRCULAR: GT gates come from the TUI capture log (gateCheckpointsFromEvents), the graded Orchestra state comes from the independent store.db — earlier the two were both derived from the capture-log gates, giving fake 0ms deltas. Store.db LEADS the TUI by ~0.7–3.8s (physically correct: the blob is written before the box paints). SUB-AGENTS (Task tool fires ZERO hooks): the child\'s sibling store.db (subagentStoreDbPath by subagent_id) is polled independently (_pollSubagentChatDbBlobs, which must run BEFORE the parent change-gate early-return since the parent idles while the child gates), its pending gates attributed to the parent conversation with subagent:true. GRANULARITY: store.db head-pending episodes batch multiple TUI gates into one head (e.g. rm+Write in one blob) and a parent\'s trailing Read has a store.db episode but no TUI box, so GT (per-gate) and Orchestra (store.db episodes) differ in count — graded by gateEpisodeMode span-coverage (isCursorCliStoreDbPermissionScenario in signal_replay.js), not 1:1. PERMISSION SCENARIOS ONLY (isPermissionScenario-gated in buildRecording): a question run\'s incidental file-op gates would otherwise emit spurious permission needs-input the question GT never records.',
      },
      {
        outcome: 'permission',
        via: 'hook',
        detail:
          'FALLBACK / PRODUCTION-PARENT (config-eval + arm/resume, lib/cursor_cli_permission.js). No single permission hook exists (preToolUse/beforeShellExecution fire for every tool, gated or not), but the gate is DERIVED: merge ~/.cursor/cli-config.json + project .cursor/cli.json, evaluate each preToolUse (deny→Run-Everything→allow→prompt), arm permission_pending on a "prompt", resume on the matching postToolUse / next tool / stop. A debounce (~2s) + per-session force-latch make it flicker-free; --force/--yolo is invisible in hooks so a hidden-force session\'s first long-running tool can false-positive once. CLI-only (gated off the IDE by cursor_version CalVer-vs-SemVer). Now strictly a FALLBACK on the live server: local CLI is owned by the store.db probe, and since 2026-07-05 warm ssh CLI is owned by the REMOTE store.db probe (createSshCursorCliHeadGateReader) too — this config-eval hint only serves cold/degraded ssh (remote store.db unreadable) plus the degraded recorder path (rendererEventsFromGateEvents fallback when no store.db config is available). CAVEATS: (1) preToolUse fires UNRELIABLY in interactive sessions (observed 2026-06-26) — when it does not fire the gate is never armed; the store.db signal above does NOT depend on hooks and is immune. (2) It only ever sees the PARENT — sub-agent Task calls fire no hooks, so config-eval is blind to sub-agent gates (the store.db path covers them). PENDING DESIGN FORK: production still uses this config-eval hint, so the store.db-authoritative replay is testing applyCursorRendererPermissionEvents, a path production does not yet feed for the CLI — see the store-db-permission-production-fork knownGap.',
      },
      {
        outcome: 'question',
        via: 'chat_db',
        detail:
          'chat store.db (~/.cursor/chats/<hash>/<conversation_id>/store.db) — the conversation head blob is a pending AskQuestion tool-call carrying providerOptions.cursor.pendingToolCallStartedAtMs, written the INSTANT the gate renders (before the transcript). lib/cursor_chat_db.js reads it read-only (copy+readonly while the WAL is present, immutable=1 when checkpointed), gated on linked_at, and the live watch tracker ORs it into askQuestionClear. Over ssh the recorder reads the remote store.db (_pollChatDbBlobsRemote: copy db+wal+shm to a remote temp, read read-only). This is the primary, early question signal.',
      },
      {
        outcome: 'question',
        via: 'transcript',
        detail:
          'transcript tool_use named AskQuestion — FALLBACK only. Delayed (written after the answer, not while the gate is held) and not 100% reliable (missing in some runs), so it cannot drive a needs-input gate on its own; the chat_db signal above is primary.',
      },
      {
        outcome: 'resume',
        via: 'hook',
        detail:
          'config-eval arm/resume (lib/cursor_cli_permission.js): after a "prompt" arms permission_pending, the matching postToolUse / next tool call / stop hook resumes the watch (mirrors the Codex/Gemini arm-resume).',
      },
      {
        outcome: 'resume',
        via: 'transcript',
        detail:
          'question resume: the transcript AskQuestion tool_use row (written only after the user answers) is the positive resume for a chat_db question pause (cursorTranscriptAskQuestionRecordedSince). A paused question watch whose answer→finish happened between resume ticks is finished terminally by finishPausedCursorWatchIfTerminal (a post-pause completed stop that passes the continuation gate → done; aborted → cancelled) — without it the watch deadlocked at needs-input forever.',
      },
      {
        outcome: 'resume',
        via: 'hook',
        detail:
          'done→working re-arm (shared cursor-kind path with the IDE): a fresh generating beforeSubmitPrompt for a conversation whose watch already FINISHED re-links that task to working (applyCursorHookResume in server.js; mirrored by the cursor branch in the replay hook loop). Grades as done_to_working on same-thread follow-up scenarios.',
      },
    ],
    replayModes: ['both', 'hooks-only', 'transcript-only'],
    ssh: {
      supported: true,
      hookDelivery:
        'Remote cursor-agent hook POSTs (same ~/.cursor hooks as IDE). cursor_version CalVer distinguishes CLI from IDE SemVer. Config-eval permission gate reads ~/.cursor/cli-config.json + project .cursor/cli.json over SSH (loadCursorCliConfigRemote).',
      hookInstall: 'POST /api/projects/:id/cursor-hooks/install-remote (shared cursor hook script)',
      transcriptRead: 'SSH cat/tail under remote ~/.cursor/projects/…/agent-transcripts/…',
      unavailable: [
        'renderer.log wakelock and Cursor Agent Exec.log — CLI has no IDE logs; permission is hook-derived only',
      ],
      extraPolled: [
        'chat store.db question signal (lib/cursor_chat_db.js) read over ssh — cursor-agent runs headless on the remote so its store.db is remote; _pollChatDbBlobsRemote copies db+wal+shm to a remote temp and reads the head pending-AskQuestion blob (CursorCliRecorder)',
        'store.db PERMISSION heads (parent + sibling sub-agents) read over ssh — PRODUCTION (2026-07-05): a watchSource:"ssh" store.db probe over createSshCursorCliHeadGateReader (remoteChatDbHeadHexes snapshot transport, ~2.5s cache, cold miss = no gate). RECORDER/REPLAY (2026-07-07, round-2 TG-cursor-2): the recorder captures the parent + sibling store.db blobs over ssh (_pollChatDbBlobsRemote → _pollSubagentChatDbBlobsRemote, subagent-tagged chat_db_blob events) AND buildRecording resolves the REMOTE cursor config (loadCursorCliConfigRemote) so rendererEventsFromStoreDbPermission reconstructs parent + sub-agent needs_input from those blobs — the replay now grades the SAME store.db path production reads. (Before round 2, recorder.permissionConfig was gated to !remoteCtx, so ssh graded the capture-log fallback only: batched parent-gate bursts false-failed under strict 1:1 and sub-agent gates had no channel → 0/4.)',
        'continuation surfaces (sibling/underdir sub-agent transcripts, terminal task files, <system_notification> blobs) read over ssh (2026-07-05): production via createRemoteContinuationOps (background cache, cold-cache safe hold), recorder via _pollSiblingTasksRemote',
      ],
      differences: [
        'permission gate: store.db probe is authoritative while the remote head reader is warm; lib/cursor_cli_permission.js config-eval (remote cli-config merged over SSH, sources tagged ssh:<host>) remains the cold/degraded fallback',
        'no sub-agent hook surface — Task appears as ordinary tool calls in one conversation_id',
        'remote hook delivery is DUAL-PATH (reverse-tunnel POST + polled remote log) with cross-path dedup (lib/cursor_hook_ingest.js); both feed the same consumer set',
        'continuation gate reads its surfaces on an async remote cache — cold cache holds via the bounded 30s task-handoff window; armed post-stop settle widened to ~12s (round-2 TG-cursor-1: 8s under-provisioned the 14-18s child-completion notification lag on the live watcher). GRADING NOTE (round-2): when the child-completion <system_notification> arrives ON-TIME (within close-grace, the common case) the continuation gate holds the parent early stop through the trailing generation and timer-done GT lands there too (delta ~4s, pass); a genuinely LATE notification (arrives after close-grace) makes the replay clear at close-grace while GT latches the late trailing generation — a residual variable-latency Transport Gap, since the parent idles during the child so timer-done cannot re-anchor to the child work',
        'TUI capture log (scripts/cursor_cli_session.js) is recorder ground truth when validating remote runs',
      ],
      replay: 'Same hook+transcript replay as local; fetch_ms on remote transcript phases.',
    },
    // Unique cursor-cli signal patterns and how tracking handles them — WORKING behavior, not gaps.
    specialCases: [
      {
        id: 'continuation-gated-done',
        summary:
          'stop is per-GENERATION, not per-turn — done is the completed stop GATED by the continuation check; background shell tasks are ARM-ONLY evidence (no busy-hold): a running server is ignored and the watch clears after the ~2.5s settle (~12s ssh), by design.',
        status: 'by design (background round 2026-07-05/06: all six background scenarios PASS with the server genuinely bound; done Δ0 to ~+4s settle warns)',
        detail:
          'A turn can span several generations: a finishing Task sub-agent or completed background task queues a <system_notification> that cursor injects as a synthetic user record, starting a new generation with its own stop — so the gate (lib/cursor_cli_continuation.js) holds a completed stop on open sibling sub-agent transcripts, pending Task handoff (≤30s), fresh post-stop tool activity, or a queued notification blob, with a ~2.5s settle when continuation machinery was used. BACKGROUND TASKS: terminal task files (<slug>/terminals/<task_id>.txt) only ARM the settle (st.armed) — there is deliberately NO claude-style busy-hold, because cursor-agent itself supervises the shell ("Will resume when background shell exits") and its resume starts a new generation whose hooks re-arm the watch (done→working, the tolerated flicker). Consequence for the background family: a still-running supervised server at the final stop is IGNORED — done clears at the settle, matching the scenario contract; the wait-then-verify patterns (wakeup/checkin) hold correctly because the agent waits in-turn. TIE-NEEDLE VERSION FRAGILITY: the parent↔child tie matches the child transcript\'s first user text against the parent\'s Task args and cursor-agent version bumps change the prompt envelope — stripSubagentPromptEnvelope removes every complete leading <tag>…</tag> block (parity-tested, shared live+recorder); treat any cursor-agent version bump as a trigger to re-run sub-agent-parent-early-done. ERROR-STATUS STOPS (2026-07-07, ssh round-2 residual): a trailing generation can end with stop status=error (observed on the headless-ssh notification-spawned trailing gen, 2/2) — an error stop now produces a completion hint and clears the watch as DONE through the SAME continuation gate as a completed stop (held while children are open / settle pending; never the cancel path). Without it a watch whose trailing generation errored never cleared at all.',
      },
      {
        id: 'subagent-stale-open-hold',
        summary:
          'A sub-agent that DIES MID-TOOL never writes turn_ended — its open transcript held the parent UNBOUNDED until 2026-07-06; now an open child transcript that HAS BEEN SEEN GROWING and then shows ZERO growth for SUBAGENT_STALE_RELEASE_MS (180s) stops holding. A child never seen growing (the cursor-ide flush-at-close shape) is NOT stale-eligible and holds to its close or the 10-min wall cap.',
        status:
          'implemented local + ssh + replay 2026-07-06 (growth tracked per sub: local stat size, ssh scan size, replay via the recording\'s sibling_subagent_activity trail → last_activity_t_ms; recordings without the trail keep the conservative pre-fix behavior). GROWTH-OBSERVED requirement added 2026-07-07 (SSH round 3, cursor-ide finding 2): the 180s release fired mid-child on a live cursor-ide child whose transcript flushes only at spawn/close (flat ~398s while demonstrably working, no re-arm path on that platform) — staleness now requires the transcript to have grown at least once since registration, so flush-at-close children fail SAFE (hold) instead of early-done. The robust-supervised scenario remains a DESIGNED-LATENCY shape, not a ±10s fix: the children were only ~27s stale at true quiet, so any release keyed on child transcript growth necessarily lands last-write+180s. Classify, do not re-file; not promotable.',
        detail:
          'Growth is the only usable discriminator: there is NO terminal record at all in the failure (nothing to parse), and a live child running a long silent tool ALSO has a flat transcript — so a short threshold would false-release real work. 180s ≫ every observed legitimate silent gap (intra-continuation ≤6.5s, task handoff ≤30s, close-grace 5s) and ≪ the 10-min wall cap. Only fully-stale sets release (one live open sub next to a stale one still holds); a stale-released child that later revives re-arms the watch through its continuation notification (tolerated done→working flicker, the claude past-cap-check-in family). GROWTH-OBSERVED trade-off: a child that dies before its SECOND transcript write is no longer released at 180s and instead rides the 10-min wall cap — accepted, because a false done (a silently-working child released mid-flight with no re-arm) is the worse failure than a bounded over-hold, and the died-mid-tool wedge children demonstrably grew before dying. The prompt-side companion fix bounds the robust-supervised template ("verify AT MOST ONCE, no restart loops") so the Cursor agent stops inducing the respawn loop that created the leftovers, and killPortListeners now runs bounded respawn sweeps for the ones that still appear.',
      },
    ],
    knownGaps: [
      {
        id: 'store-db-permission-production-fork',
        summary:
          'RESOLVED in code (Design A "full move", 2026-07-04), end-to-end live flip pending. The live server now surfaces cursor-cli permission (parent + Task sub-agent) from the chat store.db via lib/cursor_cli_permission_probe.js → applyCursorRendererPermissionEvents — the SAME path the replay grades — and the hook config-eval tracker is gated off for local CLI so it can no longer block the store.db resume. Unit + regression tested and boots clean; the full production task-board flip (real cursor-agent gate → dev board needs_input) is the one remaining validation, deferred to avoid disrupting other in-flight machine work.',
        detail:
          'Since 2026-07-04 the recorder reconstructs Orchestra needs_input from the independent store.db (rendererEventsFromStoreDbPermission → renderer_events → applyCursorRendererPermissionEvents, the SAME production function the IDE renderer/composerHeaders probes feed), which fixed the circular 0ms-delta grading and gave sub-agent coverage (Task fires no hooks). Live-validated both plain permission and sub-agent-permission (per-gate hold, all gates held until the store.db needs_input or 15s; needs_input store.db LEADS the TUI by ~0.7–3.8s; continue deltas ~+2.3 to +6.7s, within the 7s cursor-cli threshold — WATCH: continue = store.db tool-resolution time vs GT = approval, so a slow tool could push past 7s and may need the continue fail_ms widened). ' +
          'The production server (server.js) still uses TWO older paths for cursor-cli permission: getCursorPermissionPendingHint (cursorCliPermissionTracker config-eval on hooks, PARENT-only) and applyLocalCursorRendererPendingPermissions (renderer/exec probes, IDE-only — silent for the headless CLI). Neither reads the store.db for permission, so (a) sub-agent CLI gates never flip the real task board to needs_input, and (b) the graded replay path (applyCursorRendererPermissionEvents fed by store.db) is not the path production runs for the CLI. ' +
          'RESOLUTION (Design A "full move", implemented 2026-07-04): lib/cursor_cli_permission_probe.js createCursorCliStoreDbPermissionProbe is a live per-watch store.db poller — for each active LOCAL cursor watch it reads the HEAD-pending gate of the parent store.db AND each Task sub-agent\'s sibling store.db (readHeadPendingGates in lib/cursor_cli_subagent_gate.js; head-only because store.db blobs are immutable so an all-blobs scan would surface stale gates forever), config-evals via the shared evaluator, and emits parent-attributed permission_requested/cleared through applyCursorRendererPermissionEvents — the exact path the replay grades. Wired into server.js pollRemoteHookLogs (gathers local cursor watches from storage state; config resolved via a per-conversation hook-body cache since the watch carries no workspace roots; sub-agent ids from listSubagentTranscriptPathsForWatch). Its isPermissionPendingForWatch is OR-ed into isCursorRendererPermissionPending as the resume guard. The old config-eval tracker is GATED OFF for local CLI (getCursorPermissionPendingHint + isCursorCliPermissionPending return null/false when localCursorCliStoreDbPath(conv) exists) so a stuck hook-tracker can no longer block the store.db resume. SSH (2026-07-05): the documented ssh continuation of this fork is closed too — a SECOND probe instance (watchSource:"ssh") reads the REMOTE parent + sibling sub-agent store.db heads through createSshCursorCliHeadGateReader (background-refreshed ~2.5s cache over the remoteChatDbHeadHexes snapshot transport, decoded locally with the same config-eval; COLD MISS = no gate, never a false gate) and emits through the same applyCursorRendererPermissionEvents; sub-agent ids come from the continuation watcher\'s remote sibling discovery. While the remote reader is WARM the config-eval hint/resume guard is suppressed (sshCursorStoreDbProbeOwns, mirroring the local gating, with ~30s decay back to the config-eval fallback if ssh transport dies). Unit-tested (tests/cursor_cli_permission_probe.test.js), regression-clean (watch_tracker/cursor_tracker 141 pass), and boots clean on an isolated instance. RECORDER/REPLAY ssh parity (round-2 TG-cursor-2, 2026-07-07): round-1 found the "ssh fork closed" claim held for PRODUCTION reads but NOT for the recorder/replay grading — recorder.permissionConfig was gated to !remoteCtx, so the replay graded the capture-log fallback (span-coverage disabled, sub-agent gates 0/4). CLOSED: buildRecording now resolves the remote config (loadCursorCliConfigRemote) and grades the captured store.db blobs over ssh (rendererEventsFromStoreDbPermission), so the replay grades the same store.db path production runs. REMAINING: the end-to-end production task-board flip (real cursor-agent gate → dev board needs_input, parent + sub-agent, local AND ssh) — deferred to avoid disrupting concurrent in-flight machine work; run it when the machine is quiet.',
        status: 'implemented (Design A full move: lib/cursor_cli_permission_probe.js + server.js wiring, tracker gated off for local CLI; ssh variant probe added 2026-07-05); end-to-end live task-board flip pending',
      },
    ],
    note:
      'cursor-agent CLI shares ~/.cursor hooks + transcripts with the IDE but is a separate surface (distinguished by cursor_version: CLI is CalVer 2026.06.15-…, IDE is SemVer 3.x.y). done is hook-driven (stop.status=completed) but continuation-GATED (lib/cursor_cli_continuation.js — see the done source): a stop is per-generation, not per-turn, and sub-agent/background continuations inject synthetic user records that start further generations; the gate holds the clear on open sibling sub-agent transcripts / pending Task handoff / queued <system_notification> store.db blobs / fresh post-stop tool activity, with a ~2.5s settle only when continuation machinery was used. TIE-NEEDLE VERSION FRAGILITY (regressed once, hardened 2026-07-05): the parent↔child tie matches the child transcript\'s first user text against the parent\'s Task args, and cursor-agent VERSION BUMPS change the prompt envelope around that text — 2026.07.01-41b2de7 added a leading <timestamp>…</timestamp> block before <user_query>, which defeated a <user_query>-only strip, emptied cursor_continuation.subagents, starved the gate, and re-opened the sub-agent-parent-early-done early clear (−85.6s/−71.9s, round-2 regression B2). The strip is now the generic stripSubagentPromptEnvelope (lib/cursor_cli_continuation.js, shared by the live gate AND the recorder, parity-tested): it removes EVERY complete leading <tag>…</tag> block plus the <user_query> opener, so a future envelope tag cannot silently break the tie again — but treat any cursor-agent version bump as a trigger to re-run sub-agent-parent-early-done (the only scenario whose ONLY hold is this tie). cancelled is hook-primary (stop.status=aborted) with a transcript fallback (turn_ended manual abort). Permission (recorder/replay, since 2026-07-04) is graded from the chat store.db: the head blob carries the pending gateable tool call (Shell/Read/Write/WebFetch/Mcp) the instant the gate renders — the same early channel as the question signal — config-evaled via lib/cursor_cli_permission.js to keep only decision==="prompt", turned into permission_requested/cleared:approved (source:"store_db") by rendererEventsFromStoreDbPermission, and driven through the SAME production applyCursorRendererPermissionEvents as the IDE probes (rides renderer_events). This is deliberately NON-CIRCULAR — GT gates come from the independent TUI capture log, the graded Orchestra state from the store.db — and covers SUB-AGENT gates (Task fires no hooks) via the child\'s sibling store.db. The live server surfaces the SAME store.db permission signal (parent + sub-agent) via lib/cursor_cli_permission_probe.js → applyCursorRendererPermissionEvents (Design A full move, 2026-07-04), with the older config-eval + arm/resume derivation (lib/cursor_cli_permission.js on per-tool hooks) gated off for local CLI and kept only as the ssh/degraded FALLBACK — see the store-db-permission-production-fork knownGap (end-to-end board-flip validation still pending). The TUI capture log remains recorder GT. Question is detected from the chat store.db pending AskQuestion blob (lib/cursor_chat_db.js) — the conversation head carries pendingToolCallStartedAtMs the instant the gate renders, read read-only and gated on linked_at, ORed into the live askQuestionClear path; the transcript AskQuestion (written only after the answer) is a delayed fallback. over ssh the recorder reads the remote store.db (the agent runs headless on the remote), so the early question signal is captured remotely too. No sub-agent hooks: a Task/sub-agent appears as ordinary tool calls within the one conversation_id — but it DOES write its own sibling transcript (agent-transcripts/<subagent_id>/), the continuation gate\'s open-sub-agent hold; background shell tasks write <slug>/terminals/<task_id>.txt. Since 2026-07-05 the continuation gate also covers ssh watches: the remote surfaces (sibling/underdir sub-agent transcripts incl. the SAME tie needle, terminal task files, store.db <system_notification> blobs) are read over ssh on a background-refreshed cache (createRemoteContinuationOps, ~2.5s), never blocking the watch tick; a COLD cache fails SAFE via the bounded task-handoff hold (30s cap) rather than instant-releasing, and the armed post-stop settle is widened (~12s, round-2 TG-cursor-1 — 8s under-provisioned the observed 14-18s child-completion notification lag) to cover remote observation lag. This closes the sub-agent-parent-early-done early-clear class when the notification arrives on-time (within close-grace, common); a genuinely LATE notification (past close-grace) remains a residual variable-latency Transport Gap — the replay clears at close-grace while GT latches the late trailing generation, and because the parent idles during the child, timer-done cannot re-anchor GT to the child work. The remote hook-log POLL path also feeds the full consumer set (permission tracker, continuation tool-activity, resume/spawn/completion) with cross-path dedup against the tunnel POST (lib/cursor_hook_ingest.js), so a tunnel-down ssh run no longer loses permission/re-arm/done application.',
  },
  codex: {
    status: 'supported',
    provider: 'codex',
    kind: 'ide_agent',
    hookProvider: 'codex',
    captureMode: 'hooks',
    remote: true,
    location: '~/.codex/sessions/**/<session>.jsonl',
    extraSources: [],
    liveOnlySources: [],
    recordedChannels: ['hook_events', 'transcript_phases'],
    replayChannels: ['hook_events', 'transcript_phases'],
    hookCatalog: {
      captured: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop'],
      available: ['PreCompact', 'PostCompact'],
    },
    sources: [
      { outcome: 'generating', via: 'hook', detail: 'SessionStart / UserPromptSubmit hook starts the watch → the run is added to the Orchestra picker.' },
      {
        outcome: 'done',
        via: 'hook',
        detail:
          'Stop hook / task_complete transcript event (NB: this hook also fires when the turn ended on a question — see note). When a spawned worker is still working at the parent\'s Stop, the done-clear is HELD. Workers are known from sub-agent hooks (body.agent_id under the parent session_id) AND from the spawn_agent PostToolUse tool_response.agent_id — the latter covers hook-silent workers, whose tool calls can fire no hooks at all. A held done releases on the FIRST of: the worker\'s SubagentStop hook; the <subagent_notification> completion message in the parent rollout; task_complete/turn_aborted in the worker\'s OWN rollout (rollout-<ts>-<agent_id>.jsonl — also the liveness channel: recent records / an in-flight function_call hold the worker open); or the quiet backstop (CODEX_SUBAGENT_QUIET_MS 30s; in-flight caps at CODEX_SUBAGENT_INFLIGHT_STUCK_MS 120s). The release moment (not the stale Stop-hint arrival) is stamped as the done time.',
      },
      { outcome: 'permission', via: 'hook', detail: 'PermissionRequest hook / pending permission in transcript; a later generating PostToolUse after the pause resumes tracking (including sub-agent permissions whose hook keeps the parent session_id but points at the child transcript_path)' },
      { outcome: 'question', via: 'transcript', detail: 'pending request_user_input in transcript; combined detection prefers this over the turn-complete hook' },
      { outcome: 'resume', via: 'transcript', detail: 'after a gate: a later generating PostToolUse / transcript active-generation resumes tracking (codexWatchActiveGenerationSince live; classifyCodexActiveGenerationFromText in replay). Sub-agent permissions resume the parent watch via the child transcript_path under the parent session_id.' },
      { outcome: 'cancelled', via: 'transcript', detail: 'turn_aborted transcript event (no cancel hook)' },
    ],
    // Unique codex signal patterns and how tracking handles them — WORKING behavior, not gaps.
    specialCases: [
      {
        id: 'no-background-busy-hold',
        summary:
          'Codex has NO background-shell busy-hold BY DESIGN: a still-running server/process at task_complete is ignored and done clears immediately (Δ≈0). The only holds are the sub-agent worker hold and the heartbeat-wakeup hold — codex has no runtime-supervised background mechanism to key one on.',
        status: 'by design; confirmed across the full background family, CLI + desktop (2026-07-05/06 sweeps: every bound-server scenario cleared at task_complete, false_clear=false, no post-clear flicker)',
        detail:
          'Codex\'s only shell analog is the persistent exec session (a foreground command the runtime keeps alive) — it produces no Stop-body task ledger, no lifecycle hooks, and no exit notification, so there is nothing to hold on and nothing to release on; "done at task_complete, server ignored" is the scenario contract. SANDBOX INTERACTION (classify, don\'t re-file): detached `nohup … & disown` / `(…) &` subshells are killed when the exec sandbox tears down — observed shapes: the agent falls back to a foreground server (clean pass), the agent stalls its turn without recovering (background-task-supervised-2: no task_complete ever, Orchestra correctly HOLDS working — a model/sandbox stall, not an Orchestra gap; that scenario has no reproducible clean pass under the current sandbox), or a kill of a foreign process raises an incidental real PermissionRequest (graded as extra needs_input/continue).',
      },
      {
        id: 'subagent-outlives-parent-false-clear',
        summary:
          'Spawned worker still working at the parent Stop → the done is HELD and released at the first worker end signal (SubagentStop hook, <subagent_notification> in the parent rollout, or task_complete in the worker\'s own rollout), with the hooks/rollout-quiet backstop only when none arrives. Residual (narrow, theoretical): a worker killed hard before ANY end signal, with a stale rollout, still clears via the backstop — inherently late against a quiescence-measured ground truth.',
        detail:
          'Original repro: "spawn a sub agent and reply when it is up and running" — the coordinator Stops right after launching, the watch cleared to done, and the sub-agent (its hooks carry body.agent_id + the parent session_id; NO Stop hook; SubagentStop was believed never to fire, but current engines DO post it — Orchestra simply rejected it at ingest until 2026-07-03) kept working for ~100s (signal-lab/codex/2026-07-01T00-20-18-029Z, done Δ-102657ms + explicit false clear). ' +
          'The end signal that DOES exist in production channels (missed by the earlier analysis): when a sub-agent completes, codex injects a <subagent_notification> message (agent_path = agent_id, from the spawn_agent output) into the PARENT rollout transcript — in the repro run 0.33s after the sub-agent\'s real finish, even though the parent turn had already ended. ' +
          'Fix (implemented): (1) hook store tracks per-session worker activity from body.agent_id AND registers spawned workers from the spawn_agent PostToolUse tool_response.agent_id (covers hook-silent workers); (2) the push-path Stop-clear and the poller\'s done paths (hint + transcript) HOLD while any known worker is neither closed by a SubagentStop hook (stopped_ms; accepted into VALID_EVENTS 2026-07-03 — engines DO post it), nor notified-complete (codexTranscriptSubagentState on the parent rollout), nor terminal in its own rollout (codexAgentRolloutFacts: task_complete/turn_aborted closes; recent records / in-flight calls hold open), nor quiet-closed (CODEX_SUBAGENT_QUIET_MS 30s; in-flight up to CODEX_SUBAGENT_INFLIGHT_STUCK_MS 120s); (3) codexTranscriptShouldClearWatch holds a task_complete-done while a spawned worker lacks its notification and accepts the last notification as fresh done evidence after a mid-run resume; (4) a held-then-released done stamps the RELEASE moment, not the stale Stop-hint time. Parent-waits runs (basic/sequential/parallel/robust sub-agent) release on the next poll tick via already-present end signals, so their done latency grows by ≤ one poll interval, not a settle window. Live-proven both surfaces: codex CLI early-done done Δ207ms (was Δ-102657ms false clear); codex-desktop early-done Δ0 with a hook-silent worker outliving the parent ~100s (signal-lab/codex-desktop/2026-07-03T05-54-53-995Z).',
        candidateFix:
          'Residual signature (classify, do not re-file): done clears exactly last-worker-activity + 30s (or + 120s with an in-flight call) with NO SubagentStop hook, NO <subagent_notification> in the parent rollout, and the worker rollout stale without task_complete/turn_aborted — i.e. the worker died/hung before ANY end signal. A ±10s timer-done grade correctly flags this late clear; that is the framework revealing a real signal absence, not a bug. Do NOT widen the backstop or the grade to hide it. Do NOT re-diagnose long post-Stop activity as this residual without checking session attribution first — the 2026-07-01 background-sub-agent-robust FAIL blamed on this gap was actually foreign-session contamination (autohunt sessions in the capture; rebuilt with correct binding it passes done Δ0). The residual remains THEORETICAL: never reproduced clean.',
        status: 'implemented (SubagentStop + notification + worker-rollout close; quiet backstop last) — residual narrow + theoretical: worker killed before any end signal',
      },
      {
        id: 'heartbeat-yield-false-clear',
        // (kept id from the knownGaps era; the entry now documents the WORKING hybrid hold)
        summary:
          'FIXED (2026-07-06, HYBRID semantics): the model can schedule a self-wakeup heartbeat automation (rollout function_call automation_update/codex_app, hooks tool codex_appautomation_update; kind:"heartbeat", ACTIVE, RRULE+DTSTART) and END its turn — codex has no "yielding, not done" signal, so the task_complete/Stop falsely cleared the watch for the whole wake gap (codex-desktop background-wakeup: −188s/−209s round-1, −50s on the 16-14 live run that defeated the first fix).',
        status:
          'hybrid landed 2026-07-06 (v2 frequency-aware): near-future heartbeat → HOLD anchored at the YIELD; far-future OR missed-long-period → cron semantics (clear + wake re-arm). All FOUR failing/observed recordings replay clean (round-1 Δ−250ms/Δ−2007ms; the 16-14 early-created live run Δ0ms; the 16-41 DAILY-backup live run Δ0ms — both are regression fixtures, mirrored as unit tests). Remaining live target: one clean codex-desktop background-wakeup pass on the hybrid.',
        detail:
          'This is the one background case with REAL tool-specific knowledge: the automation carries its own fire time, so the hold is bounded by the schedule, not a guessed timeout. HYBRID RULE (codexHeartbeatHoldsDone): (a) NEAR-FUTURE fire → hold until max(fireAt, YIELD) + 120s grace. The window is anchored at the yield Stop/task_complete, NOT at creation: codex defers heartbeat delivery until the turn ends (observed wakes at yield+38–56s even when DTSTART passed mid-turn), and the 16-14 live run proved the creation anchor wrong — its model scheduled the heartbeat 146s before yielding, so created+grace had already lapsed at the Stop and the watch cleared instantly. The hook store stamps hold_started_ms at the yield Stop; the transcript scan anchors at the task_complete ts. (b) FAR-FUTURE fire (fireAt − yield > 10min horizon) OR a MISSED LONG-PERIOD occurrence → NO hold: a wake that far out is a scheduled job, not "coming right back" — claude session_crons semantics; the watch clears at the yield and the wake\'s UserPromptSubmit re-arms done→working (applyCodexHookResume — also the safety net for any hold miss). FREQUENCY-AWARE missed fires (the 16-41 live run): codex delivers a missed MINUTELY heartbeat as soon as the turn ends (genuine yield → hold anchor+grace), but a missed DAILY/WEEKLY occurrence fires at the NEXT period (tomorrow) — that run scheduled a DAILY backup check, finished everything IN-TURN, and the leftover automation must not hold its real done. RRULE parsing covers both DTSTART forms: the UTC "DTSTART:...Z" and the TZID-local "DTSTART;TZID=America/Los_Angeles:..." (parsed as machine-local; codexHeartbeatScheduleFromRrule also extracts FREQ → period_ms). HOLD PATHS: transcript in codexTranscriptShouldClearWatch (local + ssh via remoteCodexWatchShouldClearSince + replay), hook push via hasPendingHeartbeat (holdDoneForHeartbeat in applyCodexHookCompletion) + poller hint gate (isCodexHeartbeatDoneHoldActive). RELEASES: the wake (fresh records after the stale task_complete void it — the wake turn\'s own task_complete is the real done), a PRE-YIELD delete/pause (plan changed; a mid-wake delete of the fired automation is cleanup, not a release), or yield+grace with no wake (app quit — bounded). WAKE GUARD: while the wake turn runs (heartbeat consumed, no Stop since) a STALE transcript snapshot must not clear via the fallback (isCodexHeartbeatWakeActive; the desktop transcript freezes at the pre-wake complete). CLOCK NOTE: DTSTART is on the recording clock; yield/now are on the caller clock — max(fireAt, yield) makes fireAt an extension only when coherently ahead (live), degrading to yield+grace under replay skew. Scope: codex CLI wakeup runs observed so far wait in-turn (no heartbeat, 2/2) — the fix covers the CLI anyway if a model ever takes the scheduler path there.',
      },
    ],
    replayModes: ['both', 'hooks-only', 'transcript-only'],
    ssh: {
      supported: true,
      hookDelivery:
        'Remote hook script POSTs to Orchestra. Default install route opens a reverse SSH tunnel and writes a remote remoteApiBase pointing at http://127.0.0.1:<remotePort> (48725 dev / 48726 stable); the $SSH_CLIENT → control-Mac LAN-IP POST is a fallback (and the route the live agent_watch_harness uses). Same hook catalog as local. Stop hook drives done/permission; transcript fallbacks via SSH read; transcript-only Stop synthesis stamps remote_host.',
      hookInstall: 'POST /api/projects/:id/codex-hooks/install-remote → opens reverse hook tunnel, then ~/.codex/config.toml merge + task-app-codex-hook.sh',
      transcriptRead:
        'SSH cat full session JSONL for remoteCodexWatchShouldClearSince; SSH tail -c for resume (remoteCodexWatchActiveGenerationSince), picker enrichment, and worker rollouts (remoteCodexAgentRolloutFacts: one exec finds the remote rollout-…-<agent_id>.jsonl and tails it). Recorder tails 512 KiB per phase (fetch_ms).',
      differences: [
        'watch poller uses shouldCompleteRemoteCodexWatch (remoteCodexWatchShouldClearSince)',
        'paused resume: remoteCodexWatchActiveGenerationSince over SSH tail',
        'picker matches hook snapshots by remote_host + ssh workspace path',
        'sub-agent permissions: hook keeps parent session_id with child transcript_path — same as local. TUNNEL DEPENDENCY: the child gate\'s PermissionRequest hook is the ONLY prompt-time signal for a sub-agent gate, and it reaches Orchestra only through the reverse hook tunnel — with the tunnel down the gate is invisible until a transcript-visible end signal, so sub-agent-permission over ssh REQUIRES a live tunnel (documented-only; no transcript fallback exists for the pending child gate).',
        'worker-rollout done-hold (hook-silent spawn_agent workers): remote rollout read over ssh through a background-refreshed per-(host,agent_id) cache — cold cache = null (falls back to the 30s quiet backstop, the pre-2026-07-05 ssh behavior), warm cache = precise hold/release; the 2s watch tick never blocks on a cold ssh exec',
        'notified-ids channel (parent-rollout <subagent_notification>) stays LOCAL-only: over ssh it would need a second full-file cat per held tick (the done-read raw text is not shared out); release comes from SubagentStop (tunnel), the remote worker rollout, or the quiet backstop',
      ],
      replay:
        'shouldCompleteRemoteCodexWatch mirrors local transcript predicate on recorded text; fetch_ms models SSH cost.',
      note: 'agy-app / claude-cowork have no remote variant. With the reverse-tunnel install route the remote posts to 127.0.0.1:<remotePort>, so no LAN bind is needed; HOST=0.0.0.0 is only required for the $SSH_CLIENT/LAN-IP fallback route (e.g. the live harness). codex-desktop is watch-only ssh (retrofit 2026-07-04): local Codex.app GUI + remote workspace; live validation pending — see SSH_SOURCE_DISPOSITIONS.codex_desktop.',
    },
    note: 'Codex emits a turn-complete hook even when the turn ends on a question — in isolation (hooks-only) it misreads as done, so combined detection prefers the transcript\'s request_user_input. Question and cancel are transcript-only (no question/cancel hook). Permission resume is hook-driven: after a PermissionRequest clears to needs-input, a later generating PostToolUse with the same session/transcript identity flips the watch back to tracking. For sub-agent permissions, Codex hook payloads keep the parent session_id while the transcript_path points at the child transcript; session matching is what lets the parent watch resume before the child finishes. Surfaces: the CLI (codex), the Codex desktop app (codex-desktop), and the `codex-plugin` (the Codex extension driven inside Cursor\'s Codex sidebar) all use the SAME signals — identical hooks + rollout transcript + done/gate/resume logic (bank_provider `codex`); only the DRIVER differs (codex-plugin drives Cursor AX + a command-palette new-thread, and reaches a sub-agent gate by clicking the "N background agent" panel then the "<name> is awaiting instruction" entry, vs codex-desktop\'s Cmd+Shift+L sidebar nav).',
  },
  'agy-app': {
    status: 'supported',
    provider: 'gemini',
    kind: 'ide_agent',
    hookProvider: 'gemini',
    captureMode: 'hooks',
    remote: false,
    location: '~/.gemini/antigravity/brain/**/.system_generated/logs/transcript.jsonl',
    extraSources: ['~/.gemini/antigravity/conversations/<conversation>.db (+ .db-wal)'],
    liveOnlySources: [
      'Antigravity app conversation DB: local cancel + permission signals (command gate step_type=21 — awaiting=status=9 + step_payload, granted=permissions blob; file gates step_type=5/8 via status=9; WAL "context canceled" markers), normalized into the Gemini hook store',
      'Antigravity app language_server.log: local cancel fallback, normalized into the Gemini hook store',
    ],
    recordedChannels: ['hook_events', 'transcript_phases'],
    replayChannels: ['hook_events', 'transcript_phases'],
    hookCatalog: AGY_HOOK_CATALOG,
    sources: [
      { outcome: 'generating', via: 'hook', detail: 'first agy hook (PreInvocation / PreToolUse / a generating Stop) marks the agent generating (getGeminiActiveGenerationHint) → the run is added to the Orchestra picker (enrichGeminiHookPickerRuns).' },
      { outcome: 'done', via: 'hook', detail: 'agy Stop with terminationReason=NO_TOOL_CALL + fullyIdle (completion_hint). Fallback: agy transcript-idle quiescence after a partial Stop — measured cascade-wide (parent + every sub-agent), and a delegating parent is handled correctly: invoke_subagent is NOT held as an in-flight tool (its spawn PreToolUse has no matching PostToolUse), so it cannot jam the backup; the spawned sub-agents are tracked via cascade quiescence instead.' },
      { outcome: 'permission', via: 'hook', detail: 'agy PreToolUse for a gated tool (run_command / write_to_file / replace_file_content) → permission_pending' },
      {
        outcome: 'permission',
        via: 'db',
        detail:
          'Antigravity app conversation DB rows. Command gates (step_type=21) are detected by status=9 + step_payload while AWAITING — the permissions blob is not written until the gate is answered, so the granted-only blob read misses a held command request; the blob still drives the granted side. File-edit (step_type=5) / file-read (step_type=8) gates use status=9. Live server normalizes all into permission_pending hints (not captured as db rows by the recorder; the signal:session tail reconstructs synthetic hook bodies for replay). SUB-AGENT GATE ATTRIBUTION: a gate raised inside a spawned sub-agent is written to the CHILD conversation\'s DB, so the normalized permission signal carries the child conversationId; Orchestra attributes it to the parent watch through the cascade sub-agent set (getPermissionPendingHintForTracking / getQuestionPendingHintForTracking match a snapshot whose session is a known sub-agent — snapshotMatchesTrackingOrSubAgent), the same subAgentIds discovery the done-path cascade gate uses. The signal:session harness answers such a gate by polling the parent + every INVOKE_SUBAGENT child DB and navigating into the blocked sub-agent conversation before approving (sub-agent-permission / sub-agent-question scenarios)',
      },
      { outcome: 'question', via: 'hook', detail: 'agy PreToolUse for the ask_question tool → question_pending' },
      { outcome: 'cancelled', via: 'hook', detail: 'agy Stop with terminationReason=USER_CANCELED (cancel_hint), or transcript cancellation' },
      {
        outcome: 'cancelled',
        via: 'db',
        detail:
          'Antigravity app conversation DB/WAL bytes containing "context canceled" markers; live server normalizes these into cancel hints (not captured as db bytes by the recorder; the signal:session tail reconstructs synthetic hook bodies for replay)',
      },
      {
        outcome: 'resume',
        via: 'hook',
        detail:
          'after a gate: getGeminiGateResolutionHint (the gate was answered) resumes tracking — the explicit gate-answered signal — else the next agy hook (getGeminiActiveGenerationHint); guarded so it will not fire while the gate is still pending (a mid-gate PostToolUse for a DIFFERENT tool step no longer clears the pending permission — step-precise clear in deriveAgySnapshotFlags — and a WAL byte-scan phantom permission_granted is dropped while the authoritative steps row is still awaiting: filterStaleWalPermissionRequests). DB-derived (step_type=21 / write_to_file) gates resolve via the normalized app-DB hint.',
      },
      {
        outcome: 'resume',
        via: 'hook',
        detail:
          'done→working re-arm: after a DONE clear, a fresh generation START (PreInvocation/PreToolUse — never a trailing Post* wrapper close) under the tracked conversation or one of its known sub-agents re-arms the finished watch to working (applyGeminiHookResume live; the gemini branch in the replay hook loop mirrors it). Covers a same-thread follow-up turn and a sub-agent resuming after a mid-cascade lull cleared the watch. Needs-input finishes are excluded (their resume is the gate-precise path above).',
      },
    ],
    knownGaps: [
      {
        id: 'subagent-outlives-parent-false-clear',
        summary:
          'Shares the agy-cli entry: a sub-agent with NO observable signal at clear time (no hooks yet, no readable INVOKE_SUBAGENT row) can still cause an early cascade clear; the done→working re-arm now bounds the error to the quiet window instead of lasting the rest of the cascade.',
        detail:
          'Same gemini watch layer as agy-cli — the cascade gate on every done path, the tree-wide in-flight tool hold, and the fresh-generation done→working re-arm all apply to the app. Residuals: (1) a clear during a genuine long mid-task lull (observed ~120s with no hooks and no in-flight marker) still fires ~6s in; the re-arm then recovers the watch on the cascade\'s next PreInvocation/PreToolUse, so the mis-reported window is bounded by the lull remainder instead of the rest of the run. (2) a child that never declares terminal AT ALL (no fullyIdle payload on any envelope — most never-Stopping children still declare it on some final envelope, which settles them at ~+6s) settles only after the 15s tree grace + 6s quiescence (~21s late clear), graded via the no_child_terminal_signal stipulation. The DB step-status channel (see the agy-cli knownGap) is confirmed on the app (identical status enum; mid-turn all-terminal window observed up to 5.5s — why all-terminal must never settle on its own): a lull that leaves any step non-terminal now holds the watch busy, narrowing residual (1) to lulls whose DB also reads all-terminal. (3) agy orders the invocation-wrapper close (PostInvocation) AFTER the terminal fullyIdle Stop — neutral for false_clear grading and excluded from the re-arm trigger set. STATUS-7 OVER-HOLD (round-2 NEW gap, fixed 2026-07-05): in multi-sub-agent runs the parent emits an undocumented step_type=9/status=7 delegation marker that never resolves to terminal, so the "any non-terminal step holds busy" rule held the watch busy UNBOUNDEDLY after every child finished (parallel-sub-agent / background-sub-agent / robust-sub-agent run-1 never-clears; also the expected shape behind the supervised timeouts). Fixed by splitting BLOCKING non-terminal (2/8/9 — always hold) from the delegation marker, which is NOT held at all (a 30s freshness re-add was removed 2026-07-08 as corpus-proven pure over-hold — same shared gemini store, so this applies to the app too) — see the agy-cli specialCases db-step-status-channel entry and lib/antigravity_db_status.js.',
        candidateFix:
          'See the agy-cli knownGaps entry (same tradeoffs). For the app additionally: surface INVOKE_SUBAGENT children from the app brain transcripts at watch time (localAgySnapshotTranscriptPath already reconstructs the path from the conversation id).',
        status: 'mostly-implemented — cascade gates + in-flight hold + done→working re-arm; lull-window clear and never-Stopping-child latency deferred (maintainer decision pending)',
      },
    ],
    // Unique agy-app signal patterns and how tracking handles them — WORKING behavior, not gaps.
    specialCases: [
      {
        id: 'wakeup-suspend-false-cancel',
        summary:
          'The app\'s wakeup/scheduling mechanism SUSPENDS the current turn with terminationReason=USER_CANCELED and resumes ~0.1–0.5s later — handled by a cancel-confirmation window so the suspend never surfaces as a terminal cancel. (Load-correlated shape: 0/4 solo, 2/2 under concurrent load.) The app\'s OTHER wait shape — the in-turn wait — never ends the turn at all: the sleeping/background command is a live blocking status-2 DB step and the busy-hold covers the whole gap.',
        status: 'fixed 2026-07-06; replay-validated — the round-2 false-cancel recording (agy-app background-checkin 00-31-08-827Z) now grades outcome=done Δ−488ms, and the canceled bank baselines still pass (cancel Δ+2.1s/+2.3s, inside the 5s budget)',
        detail:
          'Two-part fix, both provider-wide (gemini store, so agy-cli inherits it): (1) CANCEL CONFIRMATION WINDOW — a USER_CANCELED Stop is surfaced as a cancel only after it survives AGY_CANCEL_CONFIRM_MS (1.5s) without a fresh generation start under the same conversation (getCancelHintForTracking defers; the server push path applies the same age gate, so cancels resolve via the watch poller ~1.5–3.5s after the Stop). The suspend\'s self-resume clears cancel_hint inside the window, so the false cancel never exists; a real user cancel has no instant self-resume and just gains ~1.5s of report latency. (2) CANCELLED→WORKING RE-ARM — recordWatchFinished now RETAINS completed_watch_tracking on a cancelled clear (marked clear_cancelled; resumeWatchTracking strips the marker), so a cancel that does latch (a resume slower than the window, or a user resuming a cancelled thread) re-arms on the next fresh generation instead of being unreachable. HARNESS parity: the recorder cancel-watches apply the same terminal-confirmation idea (agy-app WAL detector dismisses a hint followed by WAL growth; agy-cli log detector dismisses a cancel line followed by log growth) so an intentional mid-run task stop or wakeup suspend no longer SKIPs a live run.',
      },
      {
        id: 'supervised-server-expected-hold',
        summary:
          'A supervised background server (never exits) leaves a persistent blocking status-2 step → the DB busy-hold keeps "working" until the 5-min blocking backstop (30min→5min 2026-07-08); single-agent AND through sub-agents (a CHILD\'s status-2 holds the parent via the cascade union gate). Expected-hold scenario shape — classify, do not re-file.',
        status: 'by design (SAFE side of DB rule 1); bounded by the shared blocking backstop (30min 2026-07-06 → 5min 2026-07-08) — see the agy-cli specialCases db-step-status-channel entry for the rules',
        detail:
          'App-specific wrinkles: the supervisor RE-LAUNCHES a killed supervised server while the conversation stays open (whack-a-mole for cleanup — kill the supervisor/conversation, not just the port), and the fullyIdle Stop is NOT emitted while the supervised task lives, so only the quiescence backup or the backstop can ever clear. Scenario consequence: background-task-supervised/-3 and background-sub-agent-supervised time out at the lab\'s idle-wait ("did not go idle in time") whenever the server genuinely binds — the port-ledger fix made this deterministic; pre-ledger "passes" were maskings (squatted port → server died instantly → no status-2). status-7 (the delegation marker) plays no role in this shape — the hold is the children\'s/own status-2.',
      },
      {
        id: 'duplicate-terminal-stops-ordering',
        summary:
          'The app emits DUPLICATE terminal Stops (~45–300ms apart) and orders the invocation-wrapper PostInvocation close AFTER the terminal fullyIdle Stop — consumers must treat a trailing Post* close as neutral and never re-arm or re-complete on the duplicate.',
        status: 'by design (app hook ordering); encoded in false_clear NEUTRAL_EVENTS + the re-arm trigger set (fresh generation starts only, never trailing Post* wrappers)',
        detail:
          'This ordering is why the done→working re-arm is hook-driven off a FRESH generation start (PreInvocation/PreToolUse) rather than structural at the done, and why replay mirrors that exactly. A consumer that re-armed on the trailing PostInvocation would flicker every single turn; one that re-completed on the duplicate Stop would double-stamp done.',
      },
    ],
    replayModes: ['both', 'hooks-only', 'transcript-only'],
    ssh: {
      supported: false,
      note: 'Local Electron app only — harness has no --source ssh variant (agent_watch_harness.js skips agy-app under --source ssh).',
    },
    note:
      'Orchestra watch_tracking.provider is `gemini` (same as agy-cli). Antigravity app (Electron): real agy hooks (PreInvocation / PostInvocation / PreToolUse / PostToolUse / Stop) plus live-only app DB/WAL and language_server.log signals normalized into the gemini hook store. Transcript fns are fallbacks. DB-derived permission/cancel never reach the HTTP raw tap — the signal:session tail re-derives them for replay. HOOK ORDERING NOTE: the app emits DUPLICATE terminal Stops (~45-300ms apart) and orders the invocation-wrapper PostInvocation close AFTER the terminal fullyIdle Stop — consumers must treat a trailing Post* close as neutral (false_clear NEUTRAL_EVENTS) and must not re-arm or re-complete on the duplicate (the replay re-arms hook-driven on the follow-up\'s fresh generation, not structurally at the done, for exactly this reason).',
  },
  'agy-cli': {
    status: 'supported',
    provider: 'gemini',
    kind: 'ide_agent',
    hookProvider: 'gemini',
    captureMode: 'hooks',
    remote: true,
    location: '~/.gemini/antigravity-cli/brain/**/.system_generated/logs/transcript.jsonl',
    extraSources: [
      '~/.gemini/antigravity-cli/scratch/hook-debug.log (agy hooks written to disk)',
      'Antigravity CLI logs: ~/.gemini/antigravity-cli/log/cli-*.log',
    ],
    liveOnlySources: [
      'Antigravity CLI logs: local/remote cancel markers, normalized into the Gemini hook store (the permission gate lines in the same logs are now a recorded channel — see sources/recordedChannels)',
    ],
    recordedChannels: [
      'hook_events (incl. cli-*.log gate lines as the permission channel: agy_cli_log_permission_channel)',
      'transcript_phases',
      'remote log-derived synthetic hook_events only when tapped by the server',
    ],
    replayChannels: ['hook_events', 'transcript_phases'],
    hookCatalog: AGY_HOOK_CATALOG,
    sources: [
      { outcome: 'generating', via: 'hook', detail: 'first agy hook (PreInvocation / PreToolUse / a generating Stop) marks the agent generating (getGeminiActiveGenerationHint) → the run is added to the Orchestra picker (enrichGeminiHookPickerRuns).' },
      { outcome: 'done', via: 'hook', detail: 'agy Stop with terminationReason=NO_TOOL_CALL + fullyIdle (completion_hint), gated on cascade quiescence: while any known sub-agent conversation is active/recently-active (cascadeHasRecentActivity), the parent\'s terminal Stop does NOT clear the watch — the cascade must settle first. Fallback: agy transcript-idle quiescence after a partial Stop — measured cascade-wide (parent + every sub-agent), and a delegating parent is handled correctly: invoke_subagent is NOT held as an in-flight tool (its spawn PreToolUse has no matching PostToolUse), so it cannot jam the backup; the spawned sub-agents are tracked via cascade quiescence instead.' },
      { outcome: 'permission', via: 'hook', detail: 'agy PreToolUse for a gated tool (run_command / write_to_file / replace_file_content) → permission_pending' },
      {
        outcome: 'permission',
        via: 'log',
        detail:
          'cli-*.log "Surfacing tool confirmation: … at step N" gate line (grant: "Responding … stepIdx=N") → permission_pending, read additively with the PreToolUse hook + the DB poll (readLocal/RemoteAgyCliPermissionSignals). Append-only, repaint-proof, step-indexed, and it covers read_file gates, so it catches a fast-answered gate the DB poll drops (its status=9 row is overwritten with the grant within one poll). PRIMARY source for the signal-bank recording (local + ssh); the DB poll is kept as a cross-check (log ⊇ db) — see note.',
      },
      {
        outcome: 'permission',
        via: 'log',
        detail:
          'DELEGATED sub-agent gate: a child\'s tool permission is NOT logged as "Surfacing tool confirmation" (that path is the parent conversation\'s own tools). It goes through subagent_manager.go — request "addFromDiff: added to queue: <child-conv> step N", grant "TriggerSubagentApprovalFast: sending approval for … (<child-conv>) step N" — carrying the CHILD conversation id (parseCliPermissionSignals tags it subagent:true). The child-scoped permission_pending snapshot routes to the parent watch via the cascade subAgentIds path (getPermissionPendingHintForTracking / getGateResolutionHintForTracking → snapshotMatchesTrackingOrSubAgent), so the parent flips needs-input for every child gate. sub-agent-permission grades the resulting burst as an episode (gateEpisodeMode span coverage) because the terminal GT is a de-duped view of a noisy TUI repaint — see docs/SignalSessionRunbook/SignalTesting.MD Special Run Cases. Child status=9 in its conversation DB corroborates but the log line is primary.',
      },
      { outcome: 'question', via: 'hook', detail: 'agy PreToolUse for the ask_question tool → question_pending' },
      { outcome: 'resume', via: 'hook', detail: 'after a gate: getGeminiGateResolutionHint (the gate was answered) resumes tracking — the explicit gate-answered signal — else the next agy hook (getGeminiActiveGenerationHint); guarded so it will not fire while the gate is still pending.' },
      { outcome: 'cancelled', via: 'hook', detail: 'agy Stop with terminationReason=USER_CANCELED (cancel_hint), or transcript cancellation' },
    ],
    // Unique agy/gemini signal patterns and how tracking handles them — WORKING behavior, not gaps.
    // (Extracted 2026-07-06 from the subagent-outlives-parent-false-clear knownGap so behavior docs
    // don't read as open gaps; that knownGap keeps only the genuinely open residuals.)
    specialCases: [
      {
        id: 'db-step-status-channel',
        summary:
          'Each conversation\'s own SQLite DB (steps.status — written by the agy process, independent of hook delivery) refines cascade busy/settle on every done path via THREE SAFE RULES; an all-terminal vector is deliberately NOT a done signal. Blocking status-2/8/9 = real work → hold; status-7 delegation marker does NOT hold at all (its 30s freshness re-add was removed 2026-07-08 — corpus-proven pure over-hold); the blocking hold is bounded by a 5-min backstop (30min 2026-07-06 → 5min 2026-07-08).',
        status: 'implemented (lib/antigravity_db_status.js); confirmed identical status enum on agy-app; remote-read over ssh (readRemoteAgyCliDbStepStatusSignals / createRemoteAgyDbStatusTracker)',
        detail:
          'Measured semantics: 3=terminal, 8=streaming, 2=tool executing, 9=awaiting user, 7=sub-agent-delegation/background-spawn marker on step_type=9 parent steps. THE THREE RULES: (1) any BLOCKING non-terminal step (2/8/9) holds the conversation busy-until-now (positively bridging hook-silent tool gaps, no grace guessing); a status-7 DELEGATION marker does NOT hold at all — it routinely never resolves to terminal even after every child finishes, so treating it as blocking held watches busy UNBOUNDEDLY (agy-app round-2 never-clear gap; fixed 2026-07-05 by splitting it out of the blocking set via blockingNonTerminalCount). A follow-on 30s FRESHNESS re-add (AGY_DB_DELEGATION_STALE_MS, "keep holding a fresh marker to cover spawn→child-discovery") was REMOVED 2026-07-08: across the full agy-cli + agy-app run corpus a status-7 marker was NEVER the sole holder before a run\'s true completion — its only load-bearing moments were AFTER done, over-holding the clear by up to 30s (custom / robust-sub-agent / permission runs; e.g. 2026-07-08T11-40 custom cleared +30s). The spawn→child-discovery window it guarded is already held by the parent\'s own working grace (it emits the invoke_subagent PreToolUse and keeps writing while it delegates) + any blocking step + the children once discovered; removal clears those runs at the +15s working-grace tail instead of +30s, with no false clear introduced anywhere in the corpus. The blocking-step hold shares the inflightMaxMs backstop (30min 2026-07-06 → 5min 2026-07-08): a blocking vector UNCHANGED for ≥inflightMaxMs stops holding and normal working/grace accounting settles — parent or child alike; a vector that keeps changing (real progressing work) holds indefinitely. The 30min→5min re-tune is a FLAT-cap maintainer decision (2026-07-08): agy has no stated-intent channel (no claude TodoWrite equivalent) and the two indistinguishable shapes — a long foreground tool the agent is waiting on vs a done turn that left a supervised server running — are byte-identical at the Stop (same fullyIdle:false NO_TOOL_CALL Stop, same frozen status-2, no task list on the agy Stop; the eternal-task-vs-waiter wall). Backtest over the full agy-cli bank+lab archive (121 recordings with the DB channel, 94 with legitimate frozen status-2 windows): the longest LEGIT in-flight freeze was 4.0min (all multi-minute freezes were the `custom` long-build family; p99=50s, non-custom < 47s), so 5min false-cleared 0/94 legit runs while cutting the abandoned-server over-hold 6× (30min→5min). TRADE-OFF: a foreground tool that outlives the cap clears to done at the cap and RE-ARMS to working when it returns (done_detection recoverable flicker, "warned never a failure") — a premature-done flicker traded for faster abandoned-server clears; a >5min foreground build/test/deep-research is the case that flickers. REJECTED alternatives are the same as the original wall — do NOT retry command/server-name sniffing or prose-sniffing the last planner message (agy-cli findings §8.1). Env-tunable via AGY_INFLIGHT_MAX_MS. (2) all-terminal stable past the tree grace releases a stale IN-FLIGHT tool marker only — the lost-PostToolUse cap (same inflightMaxMs) — never undercutting working/grace accounting (a status-7 marker counts as effectively-terminal here — it never holds — else it would block the release forever). (3) a fullyIdle terminal declaration settles the conversation AT its own timestamp — the invocation-wrapper close agy emits AFTER the terminal Stop (PostInvocation/PostToolUse, generating=true) is neutral bracket noise and must NOT re-open the 15s working grace. DB-INDEPENDENT since 2026-07-08 (was gated on the DB co-reading all-terminal within ±3s): a GENUINE resume is a fresh Pre* generation (agy_last_fresh_generation_at > fullyIdleMs) which BOTH fails this guard AND re-arms the watch done→working, and across the agy-cli+agy-app cascade corpus a root fullyIdle was never followed by a genuine resume (0/50); a present DB co-reading all-terminal still corroborates (pins the settle no earlier than its last change). This is what lets DB-less / degraded hosts trust the terminal Stop, cutting the trailing-wrapper +15–20s over-hold the DB-gated rule could not on those hosts (via agy_last_fresh_generation_at — set only on a real Pre* work start, distinct from agy_last_hook_activity_at which the trailing wrapper also bumps). REJECTED — do NOT retry: settle-at-last-DB-write (all-terminal as a done signal) — the model\'s between-step thinking gap leaves the vector all-terminal ~2.5s on fast CLI turns, 5.5s on the app, unbounded on slow turns; it FALSE-CLEARED live runs by −39s/−79s. Live server reads the DBs directly (cached, mtime-gated); replay reads the recording\'s captured db_status_events shifted onto the virtual clock — same tracker contract; recordings without the channel keep the pre-fix behavior. DEGRADATION: hosts without DB access (older captures; a remote missing python3/sqlite) fall back to pure hook inference — the ~21s no-terminal-child backup window + the in-flight cap.',
      },
      {
        id: 'supervised-server-expected-hold',
        summary:
          'A supervised background server (never exits) leaves a persistent blocking status-2 step → the DB busy-hold keeps "working" until the 5-min blocking backstop (30min→5min 2026-07-08); single-agent AND through sub-agents (a CHILD\'s status-2 holds the parent via the cascade union gate). Expected-hold scenario shape — classify, do not re-file.',
        status: 'by design (the SAFE side of DB rule 1); bounded by the blocking backstop (30min 2026-07-06 → 5min 2026-07-08); reproduced deterministically in the 2026-07-05/06 background sweeps once the port ledger guaranteed the server binds',
        detail:
          'A silent long-running tool and a never-exiting supervised server are indistinguishable in the DB — status-2 IS real work as far as the DB can say (unlike status-7, a marker that is never real work). Holding is deliberate: the risk of a false clear (mis-reporting a working agent as done) outweighs a bounded over-hold. Pre-fix the DB hold was uncapped — an eternal supervised server held FOREVER in production (only the hook-side in-flight path had the cap). Scenario consequence: background-task-supervised/-3 and background-sub-agent-supervised held "working" past the lab idle-wait ("did not go idle in time") whenever the server genuinely binds — historically bounded at 30min, far past the 10-min lab window; not promotable. The 2026-07-08 30min→5min re-tune (inflightMaxMs) now clears these at ~5min, inside a 10-min lab window, so their idle-wait outcome and promotability MUST be re-validated (the abandoned server clears at the cap, then re-arms only if the agent actually resumes — which it does not in these scenarios, so no flicker here). Pre-ledger "passes" were maskings (squatted 8765 → instant bind failure → no status-2). Do NOT "fix" with a DB-quiet settle — that is exactly the rejected settle-at-last-DB-write rule (see db-step-status-channel).',
      },
      {
        id: 'cascade-terminal-settle',
        summary:
          'The terminal fullyIdle=true + NO_TOOL_CALL payload can arrive on ANY envelope (Stop, PreToolUse, PostToolUse, PostInvocation, PreInvocation) — normalized to a Stop at ingest, so a "never-Stopping" child that declares completion on a no-op bracket still settles immediately.',
        status: 'implemented (isAgyTerminalIdleMarker); zero mid-run counterexamples across 143 stored recordings',
        detail:
          'Most "never-Stopping" children still declare completion somewhere: the terminal payload rides whatever envelope closes their run — one live child\'s ONLY declaration was a no-op terminal PreInvocation bracket. Mid-run envelopes never carry the payload, so ingest-time normalization is safe. Effect: the cascade clears at parent-Stop + quiescence (~+6s) instead of the ~+21s no-terminal-child backup window. Children that truly never declare terminal on any envelope keep the honest ~21s window, graded via the evidence-gated no_child_terminal_signal stipulation.',
      },
      {
        id: 'wakeup-suspend-false-cancel',
        summary:
          'Provider-wide (gemini store): the wakeup/scheduling suspend (turn ends terminationReason=USER_CANCELED, self-resumes ~0.1–0.5s later) is absorbed by the cancel-confirmation window + cancelled→working re-arm — see the agy-app specialCases entry of the same id for the full mechanics; agy-cli inherits both parts, and its recorder cancel-watch applies the same terminal-confirmation idea (a cancel log line followed by log growth is dismissed).',
        status: 'fixed 2026-07-06 provider-wide',
        detail:
          'agy-cli wakeup runs observed so far wait IN-TURN (the sleeping command is a blocking status-2 step; the DB busy-hold covers the gap), so the suspend shape is rarer here than on the app — but the confirmation window applies identically if it fires.',
      },
    ],
    knownGaps: [
      {
        id: 'subagent-outlives-parent-false-clear',
        summary:
          'A sub-agent whose FIRST hook arrives only after the parent\'s terminal Stop causes a FALSE CLEAR: at the moment of the parent Stop the cascade looks quiet, so the watch clears while the child is (about to be) working. All OBSERVED false clears are closed; the open residuals are the NO-SIGNAL child (invisible until discovered) and DB-unreadable environments.',
        detail:
          'The closed part: every gemini done path — the PRIMARY parent terminal Stop (getGeminiCompletionHint), the idle-quiescence backup, and the transcript-done channel — is gated on cascadeHasRecentActivity (buildGeminiPollerDeps), so a parent Stop while a known sub-agent is active/recently-active does NOT clear. A sub-agent whose latest tool call has not returned (unmatched PreToolUse — a blocking sleep/build/test emits no hooks while it runs, even across the child\'s own partial Stop) counts as BUSY until its PostToolUse lands (conversationBusyUntil in-flight hold, capped at DEFAULT_INFLIGHT_MAX_MS), the same deferral the parent\'s idle backup always had. Verified on the sub-agent-parent-early-done captures: (a) parent partial Stop @8.5s, child partial Stop @31s with an in-flight tool silent until @49.7s, cascade truly quiet @92s — clears @98s instead of the old @14.5s false clear; (b) parent partial Stop @12.3s, child works to @94.9s and NEVER emits a Stop — clears @116.8s, no false clear. The behavior rules that back this live in specialCases: db-step-status-channel (busy hold / in-flight release / terminal-trusted settle (fullyIdle, DB-independent)) and cascade-terminal-settle (any-envelope terminal marker). ' +
          'OPEN RESIDUALS: (1) NO-SIGNAL child — no hooks emitted yet AND no readable INVOKE_SUBAGENT row at clear time (delayed first hook): a child not yet discovered as a cascade member is invisible, so the parent can idle-clear in the gap. Live manifestation: the background-sub-agent-robust Phase A→B gap false-clear (intermittent, timing-gated — reproduced 1/2 in the 2026-07-06 sweep: a long inter-phase lull false-cleared −38.9s; tight pacing passed clean). The DB channel narrows this (the child\'s DB appears at spawn) but discovery must still happen first. This is the gemini analogue of codex\'s subagent-outlives-parent-false-clear. (2) DB-unreadable environments (older captures; a remote missing python3/sqlite) fall back to pure hook inference — the ~21s no-terminal-child backup window (graded via the no_child_terminal_signal stipulation) and the in-flight cap. Hook-only release heuristics for the lost-Post shape were tried and REJECTED against captures: a later-step PostToolUse or a newer PreInvocation both false-cleared real runs (agy completes steps and opens invocations out of order across a still-running blocking tool).',
        candidateFix:
          'For the NO-SIGNAL child: tighten cascade child-discovery so a parent about to spawn a new batch doesn\'t idle-tick-clear in the inter-phase gap (hold the clear for a settle window after the parent Stop whenever the parent transcript lists sub-agent conversations never observed to Stop). Rejected variants: treating a child\'s completed send_message as settling (an interim/progress send_message from a still-working child would re-introduce a false clear — the worse failure mode). TRADEOFF (why deferred): each shortcut either risks a smaller false clear or adds its window to every delegating run whose children DID finish first — the same latency-vs-false-clear tradeoff codex deferred on.',
        status: 'mostly closed (cascade gate + in-flight hold + DB channel + terminal-settle, see specialCases); OPEN: the NO-SIGNAL child Phase A→B false-clear (intermittent, robust-scenario shape) and DB-unreadable degradation',
      },
      {
        id: 'ssh-zero-signal-final-stream-early-done',
        summary:
          'BOUNDED CAVEAT (ssh, question-shaped turns): done can clear ~19s early when the agent\'s FINAL reply is a long silent stream — after the last gate answer, agy streams the closing story producing NO signal on ANY channel (no hooks, no DB row change, no cli-log line; observed 22s of total silence) until the terminal Stop, so Orchestra\'s DB-all-terminal + settle legitimately reads quiet and clears.',
        detail:
          'GAP-AGY-SSH-QUESTION-DONE-STREAM (SSH round 3 R3-2, question run 2: clear @47.1s on DB-settle, terminal Stop @66.1s, every channel silent 44–66s). This is the documented "DB all-terminal ≠ done / unbounded thinking gap" platform characteristic (see db-step-status-channel: the model\'s silent gap leaves the vector all-terminal for arbitrarily long) surfacing over ssh on the answered-question shape — NOT a transport read failure: every channel read correctly; there was nothing to read. The early-done window is bounded by the final stream\'s length; the terminal Stop then arrives as a trailing signal (absorbed by the ssh false-clear terminal-bracket exemption when self-corroborated).',
        candidateFix:
          'Deliberately NOT fixed by widening the settle/done budget: the silent-stream length is unbounded (a budget wide enough to cover it would delay every legitimate agy ssh done), and no channel exists to corroborate "still streaming" (the stream produces no observable side effects until the Stop). Would need a new provider-side signal (e.g. a streaming heartbeat in the cli log) to close properly. Documented as a bounded caveat; question-ssh stays unpromoted on this shape.',
        status: 'open — documented bounded caveat (platform characteristic over ssh); do not stretch the done budget to force it',
      },
    ],
    replayModes: ['both', 'hooks-only', 'transcript-only'],
    ssh: {
      supported: true,
      location: '<remote-host>:~/.gemini/antigravity-cli/brain/**/.system_generated/logs/transcript.jsonl',
      hookDelivery:
        'Remote agy CLI hook POSTs (ensureRemoteGeminiHooks → ~/.gemini/config/hooks.json). Server also polls remote ~/.gemini/antigravity-cli/scratch/hook-debug.log every ~1s (readRemoteGeminiHookDebugEvents) and ingests into the gemini hook store.',
      hookInstall: 'POST /api/projects/:id/gemini-hooks/install-remote',
      transcriptRead:
        'SSH cat for remoteGeminiTaskCompletedSince / remoteGeminiTaskCancelledSince; SSH tail for picker enrichment (enrichGeminiHookPickerRuns with hookOnlyRemote:false on list). Poller uses shouldCompleteRemoteGeminiWatch + shouldCompleteRemoteGeminiTranscriptCancelWatch.',
      extraPolled: [
        'remote agy CLI log permission gate lines (readRemoteAgyCliPermissionSignals) → synthetic gemini hook bodies — the PRIMARY permission source over ssh (repaint-proof + step-indexed; the recorder\'s permission channel)',
        'remote agy CLI log cancel signals (readRemoteAgyCliCancelSignals)',
        'remote agy CLI conversation DB permission rows (readRemoteAgyCliDbPermissionSignals) → cross-check only (log ⊇ db); additive in the live server',
        'remote agy conversation DB step-status vectors (readRemoteAgyCliDbStepStatusSignals → createRemoteAgyDbStatusTracker per-host cache): the DB busy/settle channel is REMOTE-READ now — the three safe rules (blocking busy hold / stale in-flight release / terminal-trusted settle (fullyIdle, DB-independent), with status-7 delegation markers never holding) apply to ssh watches exactly as locally, scoped to the active ssh watches + their cascade sub_agents (never a whole-remote-dir scan). Sqlite runs ON the remote (python sqlite3 read-only), so WAL merging is native. HONEST DEGRADATION: a remote without python3/sqlite (or an ssh failure) reads {present:false} = pure hook inference — the ~6s mid-lull idle-completion clear and the 5-min lost-Post in-flight cap (inflightMaxMs, 30min→5min 2026-07-08) re-appear on such hosts, same as any DB-unreadable environment (see knownGaps residual 1).',
      ],
      differences: [
        'remote picker can use hookOnlyRemote:true for fast hook-only rows; list API uses hookOnlyRemote:false for transcript enrichment',
        'refreshGeminiSubAgentCacheForHost runs after remote hook-debug / permission DB polls',
        'DB step-status snapshots come from the per-host remote cache (buildGeminiPollerDeps dbStatusForWatch routes wt.source===ssh to it; local watches keep the local cached-sqlite tracker), refreshed from the ~1s pollRemoteHookLogs loop',
        'legacy discoverRemoteGeminiRuns (~/.gemini/tmp) is deprecated — agy-cli uses antigravity-cli brain transcripts',
        'CANCEL-vs-DONE ORDERING (round 3 fix, GAP-AGY-SSH-CANCEL): the ssh transcript-done backup must PERSIST AGY_SSH_TRANSCRIPT_DONE_CONFIRM_MS (8s) before clearing, and every SECONDARY done channel holds while a USER_CANCELED Stop is inside its confirmation window (hasUnconfirmedCancelForTracking) — the reverse-tunnel batch flush otherwise let Channel-B terminal reads clear done ~0.5–1.5s after a real cancel while the classification was still in flight. Primary Stop-hint done is untouched; local watches skip the persistence window.',
        'over ssh the additive dual-channel gate read produces a benign duplicate needs-input pulse per gate (absorbed live, episode-graded in replay — R3-2 grading fix 2)',
      ],
      replay:
        'Remote transcript predicates use the same recorded text as local (buildGeminiPollerDeps transcriptCancelRemote / transcriptDoneRemote); fetch_ms models SSH read cost. Polled log/DB synthetics appear in hook_events when tapped during capture. db_status_events are captured over ssh too (the session\'s probe reads the remote DBs), so ssh recordings replay the DB channel through the same replay tracker as local ones.',
    },
    note:
      'Orchestra watch_tracking.provider is `gemini` (same as agy-app). Antigravity CLI: headless agy hooks written to hook-debug.log and POSTed to Orchestra; CLI log markers for cancel on local and remote. Permission gates are read from the cli-*.log "Surfacing tool confirmation: … at step N" lines (readLocal/RemoteAgyCliPermissionSignals) — the robust, step-indexed source that is the recorder\'s permission channel (agy_cli_log_permission_channel) and is read additively in the live server alongside the PreToolUse hook + the DB poll. The DB poll (readLocal/RemoteAgyCliDbPermissionSignals) is lossy (its status=9 row is overwritten with the grant within one poll, dropping a fast-answered gate) and noisy (WAL+row phantom duplicates), so it is NOT fed into the recording — it is kept only as a cross-check that the signal:session asserts the log line never regresses below (log ⊇ db). A DELEGATED sub-agent\'s gates use a DIFFERENT log format (subagent_manager.go "added to queue" / "sending approval for … (<child>)", NOT "Surfacing tool confirmation") and carry the child conversation id; the reader parses both and the child gate routes to the parent watch via cascade subAgentIds (see the sub-agent permission source above). Same shape local and over ssh. No app conversation DB. signal-bank recordings still use provider `gemini` in metadata.',
  },
  claude_cowork: {
    status: 'supported',
    provider: 'claude_cowork',
    kind: 'ide_agent',
    hookProvider: null,
    captureMode: 'audit',
    remote: false,
    location: '~/Library/Application Support/Claude/local-agent-mode-sessions/<id>/audit.jsonl',
    extraSources: ['~/Library/Logs/Claude main log (cancel fallback)'],
    liveOnlySources: [],
    recordedChannels: ['transcript_phases (audit.jsonl)', 'main_logs'],
    replayChannels: ['transcript_phases (audit.jsonl)', 'main_logs'],
    sources: [
      { outcome: 'generating', via: 'audit', detail: 'AX "Stop response" button (or the first audit user record) marks the agent generating → the run appears in the Orchestra picker.' },
      { outcome: 'done', via: 'audit', detail: 'completed result (or rate-limit rejection)' },
      { outcome: 'permission', via: 'audit', detail: 'AskUserQuestion permission request' },
      { outcome: 'resume', via: 'audit', detail: 'after a gate: audit active-generation resumes tracking (classifyCoworkActiveGenerationFromText) — inferred from renewed generation (no explicit gate-answered signal).' },
      { outcome: 'cancelled', via: 'audit', detail: 'cancelled result / main-log cancel' },
    ],
    // Unique cowork signal patterns and how tracking handles them — WORKING behavior, not gaps.
    specialCases: [
      {
        id: 'per-call-sandbox-isolation',
        summary:
          'Every Cowork bash call runs in its own bwrap --new-session --unshare-net sandbox with NO cross-call persistence — a backgrounded server is dead (and network-unreachable) by the next call, so Cowork structurally CANNOT leave a process outliving a tool call. Background scenarios always take shape (b): bound in-call, died with the sandbox.',
        status: 'platform limitation, documented + graded correctly (2026-07-06 sweep: 8/8 scenarios, no Testing/Orchestra gaps; 7/8 promoted as platform-behavior baselines)',
        detail:
          'Consequences: there is no busy-hold to model (the audit result record is written when the turn completes, and no process can still be running); a cross-call curl to a "background" server always fails (models sometimes falsely CLAIM it is still running — a model-prose artifact that does not affect the result-driven grade); the nominal background stress cases (early-done, supervised-outlives-turn) are non-exercisable, so clean passes promote under the platform-behavior-baseline bar. The Agent tool is synchronous, so parent-early-done is likewise non-exercisable.',
      },
      {
        id: 'scheduled-tasks-wait-offload',
        summary:
          'Asked to "schedule a wakeup and wait", the Cowork model offloads the wait to the scheduled-tasks system and ENDS its turn claiming to be waiting — the audit result is a genuine turn end, so Orchestra\'s done is CORRECT; the shape is model variability, not a false clear.',
        status: 'observed 2026-07-06 (background-wakeup); non-promotable (model-dependent), classify as Model-variability',
        detail:
          'Contrast with the in-turn wait (background-checkin: the model slept inside the turn, Orchestra held working through every sleep, done Δ0). The offload shape does not reproduce the codex-desktop heartbeat false-clear (no scheduler re-invocation was observed re-arming the session) nor the agy-app suspend false-cancel (no USER_CANCELED). If Cowork ever gains a re-invoking scheduler, revisit with the codex heartbeat-hybrid semantics.',
      },
    ],
    replayModes: ['both', 'transcript-only'],
    ssh: {
      supported: false,
      note:
        'Local macOS only — audit.jsonl and ~/Library/Logs/Claude/main.log are not on a remote host. normalizeWatchTracking rejects provider=claude_cowork with source:ssh; harness has no --source ssh variant.',
    },
    note: 'Local only; no hooks — driven entirely by audit.jsonl. ("transcript-only" mode replays the audit.)',
  },
  'browser-chatgpt': {
    status: 'supported',
    provider: 'browser-chatgpt',
    kind: 'browser_chat',
    hookProvider: null,
    captureMode: 'snapshot',
    remote: false,
    location: 'extensions/chat-watch + /api/browser-chats/*',
    extraSources: [
      'content-script DOM snapshots',
      'chrome.webRequest backend-api/conversation* completion/error (activity + DR backstop clock; NOT the standard-turn clear)',
      'chrome.webRequest backend-api/stop_conversation request start (cancel)',
      'main-world stream-body sniffer: SSE stream_handoff/resume_conversation_token carries conversation_id (S1) + [DONE] (S3) + handoff flag + body_ms',
      'main-world WebSocket/EventSource sniffer (realtime handoff channels; structural-only)',
      'debug probe logs for request lifecycle',
    ],
    liveOnlySources: [],
    recordedChannels: ['browser_chat_events', 'probe_logs', 'extra_signals', 'stream_signals'],
    replayChannels: ['browser_chat_events'],
    hookCatalog: null,
    sources: [
      { outcome: 'generating', via: 'snapshot', detail: 'Stop/activity DOM heuristics → the watch shows working (picker row). DOM generating is also the GT START anchor (first generating snapshot). DEEP RESEARCH (final, v0.5.19): the DR UI renders in a NESTED cross-origin sandboxed iframe chain (page → connector_openai_deep_research.web-sandbox.oaiusercontent.com shell → inner frame) that the parent content script cannot read into; the in-frame observer (content-dr-frame.js, all_frames + match_origin_as_fallback) reads the phase buttons INSIDE it and relays via window.top.postMessage → content-chatgpt.js → background (the direct chrome.runtime port never delivers from the opaque-origin frame — live-confirmed). Phases: Start button visible = PENDING (the ~60s countdown auto-starts, so pending reads as working — including hidden); Stop-research button visible = RUNNING (5s heartbeats). Both set deep_research_active + generating on snapshots. The card iframe ELEMENT itself is DIAGNOSTIC ONLY (dr_card_visible): it persists on completed pages, its mount timing is indistinguishable from staged page rendering (loads/reloads/SPA flips all false-armed it — three failed gating attempts), and the report renders into the SAME conversation turn, so no parent-DOM structure can gate it. A 1.5s-debounced legacy chip heuristic covers the opening seconds before the frame boots.' },
      { outcome: 'done', via: 'snapshot', detail: 'STANDARD turn, VISIBLE tab: the DOM completion snapshot is the production done. The /f/conversation webRequest completion is deliberately NOT a clear: ChatGPT’s handoff-shaped turns (2026-07 resumable streaming) end that POST with an early stream [DONE] ~1-2s into a reply that keeps streaming on a channel webRequest cannot see, so clearing on it marked long replies done ~20-28s early.' },
      { outcome: 'done', via: 'stream_body', detail: 'STANDARD turn, HIDDEN tab (frozen DOM): the sniffer’s [DONE] clears via /complete when the body streamed >= 5s (body_ms) — a full body’s end IS the true finish (observed 43.1s vs GT 43.2s backgrounded); a short/handoff body is ambiguous and never clears (at worst the old dead zone, never a wrong early clear). background.js stream-signal handler (d).' },
      { outcome: 'done', via: 'quiescence', detail: 'DEEP RESEARCH: no clean completion request (research is a loop of ecosystem/call_mcp tool calls; the report is written over a channel webRequest cannot see). Done paths, fastest first (final, v0.5.19): (1) COMPLETED marker — the inner frame’s body flips to “Research completed in Xm · N citations · N searches”; the observer reports it and background completes immediately. Works HIDDEN (the frame mutates off-screen; graded run: done 0.5s from GT, tab never visible). Guarded: only fires for a frame observed RUNNING this session (a finished page shows the marker from first paint and never phase-activates), and a recent Stop CLICK wins. (2) Post-end fast complete — Stop button gone (task_status:ended, the research-ended edge) then the next research-endpoint completion ≥5s later (the report-render burst; foreground). (3) Backstop — /complete after 240s (DR_QUIESCENCE_MS > ~107s mid-research gaps + ~140-180s silent report-writing) of no call_mcp / heartbeat activity; evidence-gated (corroborated by frame/heuristic, or ≥3 events over ≥15s — a lone idle-tab call_mcp burst, ~15min cadence, silently disarms), per-conversation isolated (counters reset on cid change / >60s gaps), freeze-guarded (a frozen/discarded hidden tab’s silence is not quiescence), and cooldown-guarded (a completed conversation cannot re-arm from snapshots for 10min). While armed, a task_status:active in-flight hold blocks ALL DOM clears except failure (the intro turn’s response actions are a false completion for the ENTIRE research — same turn as the report, so no turn arithmetic can release it). CANCEL discrimination: the in-frame observer reports the Stop-research CLICK itself; the ended edge within 30s of a click posts /cancel instead of completing (a stopped research’s trailing drain is otherwise indistinguishable from the render burst — live-confirmed false done). Conversation ids are recovered from the tab URL when the worker restarts mid-research (an entire hidden research once ran end-to-end with every signal muted by empty-cid guards). The recorder GRADES against activity-quiescence (lib/browser_chat_activity, 240s DR window, ws-teardown + isolated-straggler filtered).' },
      { outcome: 'cancelled', via: 'web_request', detail: 'backend-api/stop_conversation request start posts /api/browser-chats/cancel and clears straight back to the blank monitor pill. The following aborted generation request is ignored because the watch is already cleared. GT cancel = the harness cancel_sent (trusted Tab×3 → wait → Enter×2 keystrokes).' },
      { outcome: 'attribution', via: 'stream_body', detail: 'S1: SSE stream_handoff / resume_conversation_token frames carry conversation_id (+ turn_exchange_id) in the response BODY, read by the extension main-world hook (chrome.webRequest cannot read bodies). This is the PRODUCTION attribution key now — it replaces the fragile tab /c/<id> URL + lastConversationId fallback, closing the findings/10 §4 weak spot. S3 [DONE] is also the stream-end done marker fed into the activity-quiescence GT; each signal now carries a handoff flag + body_ms (stream duration) so consumers can tell a full body from an early-ending handoff body. The sniffer also patches WebSocket/EventSource on provider hosts so a handoff turn’s realtime channel is observable. Gated behind the privacy toggle; structural fields only.' },
      { outcome: 'done', via: 'snapshot', detail: 'DOM completion_signal/failure landmark — the production DR finish (and the standard-turn done above), but DIAGNOSTIC for grading (dom_done_ms in calibration). DOM is not the GT done clock and is stale-misleading backgrounded (kept reporting generating:true 15s past a real finish); failure collapses into done.' },
    ],
    replayModes: ['events'],
    ssh: { supported: false, note: 'Desktop Chrome extension posts to the local Orchestra API only.' },
    note: 'watch_tracking.provider remains chatgpt; the bank surface browser-chatgpt distinguishes browser chat from Codex. Scenarios: happy-path, happy-path-long, happy-path-again (multi-turn done→working), happy-path-parallel (two same-provider tabs), deep-research, deep-research-simple, canceled. GROUND TRUTH (2026-06 rewrite; filters 2026-07-03): GT done is **activity quiescence** — the last meaningful provider activity (telemetry-filtered network requests + spoofer stream-body markers) after which nothing meaningful happens for the quiet window (90s standard, 240s deep research — must exceed the ~107s mid-research gaps and the ~140-180s silent report-writing phase; lib/browser_chat_activity). Two GT filters: realtime:ws socket-close end_of_stream is channel lifecycle (excluded — a >30min tab-scoped socket closing minutes after a turn once dragged GT 407s late), and isolated stragglers (≥120s silence on both sides; idle DR tabs emit lone call_mcp bursts ~15min apart) are dropped. The DOM landmark is kept only as `dom_done_ms` diagnostic, NOT graded (it is circular vs Orchestra and dead on a backgrounded tab); the sentinel line was REMOVED from prompts. GT start = first generating snapshot (approximate); GT cancel = cancel_sent keystroke time. PRODUCTION (the signal under test, 2026-07-02 rework for ChatGPT’s handoff/resumable streaming): STANDARD turn = DOM completion snapshot when visible, sniffer [DONE] with body_ms>=5s → /complete when hidden (the /f/conversation webRequest completion is NOT a clear — handoff turns end it ~1-2s in with an early [DONE]); DEEP RESEARCH (final, v0.5.19 — validated live + graded PASS banked 2026-07-03) = a three-phase in-frame observer inside the NESTED sandboxed card iframe (pending/Start → running/Stop → completed/“Research completed” marker), relayed via window.top.postMessage through the parent content script (the direct runtime port never delivers from the opaque-origin frame); working spans send→countdown→research (pending auto-starts, so it reads working even hidden); done = completed marker (instant, works hidden) → post-end render burst → evidence-gated/freeze-guarded/cid-recovering 240s backstop; a Stop-research CLICK flips the ended edge to /cancel; the card ELEMENT is diagnostics-only (persists on completed pages; mount timing ungateable); standard-turn CANCEL = stop_conversation request start → /cancel. The spoofer’s URL match is ANCHORED to the real generation endpoint (housekeeping /prepare, /init, /stream_status, /textdocs bodies no longer emit markers into the GT), and WebSocket/EventSource are patched (structural-only) so handoff realtime channels are observable. A chrome.storage.session genInFlight keepalive holds the MV3 worker alive through a turn; on worker start the extension posts /tabs-sync so items for tabs closed while it slept are pruned (no phantom working rows). ATTRIBUTION (v3-browser-signals): main-world stream-body sniffer reads conversation_id from stream_handoff/resume_conversation_token frames (S1); opt-in, structural only — never model content. Capture-everything: every probe-log request + stream signal lands in extra_signals (now incl. handoff + body_ms); the optional Chrome-MCP DOM oracle is ground-truth-only and a green run never depends on it.',
  },
  'browser-claude': {
    status: 'supported',
    provider: 'browser-claude',
    kind: 'browser_chat',
    hookProvider: null,
    captureMode: 'snapshot',
    remote: false,
    location: 'extensions/chat-watch + /api/browser-chats/*',
    extraSources: [
      'content-script DOM snapshots',
      'chrome.webRequest /chat_conversations/<id>/completion* completion/error',
      'chrome.webRequest /chat_conversations/<id>/stop_response request start (cancel)',
      'main-world stream-body sniffer: SSE message_stop terminal frame (S4 — clean done edge, corroboration)',
      'debug probe logs for request lifecycle',
    ],
    liveOnlySources: [],
    recordedChannels: ['browser_chat_events', 'probe_logs', 'extra_signals', 'stream_signals'],
    replayChannels: ['browser_chat_events'],
    hookCatalog: null,
    sources: [
      { outcome: 'generating', via: 'snapshot', detail: 'Stop/activity/deep-research DOM heuristics (Claude: Stop response visible → generating). DOM generating is also the GT START anchor.' },
      { outcome: 'done', via: 'web_request', detail: 'STANDARD turn: /chat_conversations/<id>/completion* streaming POST completing → handleClaudeStreamComplete posts /api/browser-chats/complete (PRODUCTION done edge). Strongest attribution of the three (conversation id is in the URL).' },
      { outcome: 'done', via: 'stream_body', detail: 'DEEP RESEARCH: there is NO /completion stream — done lives in the task-status poll body. The spoofer emits a terminal `task_completed` marker (from `…/task/wf-<id>/status` returning a completed enum), which background.js turns into /api/browser-chats/complete. STANDARD turn also emits S4 `message_stop` (a stream-end done marker). Both feed the activity-quiescence GT.' },
      { outcome: 'cancelled', via: 'web_request', detail: '/chat_conversations/<id>/stop_response request start posts /api/browser-chats/cancel and clears straight back to the blank monitor pill, beating the completion request error that follows on cancel. GT cancel = the harness cancel_sent (trusted Tab×5 → wait → Enter keystrokes).' },
      { outcome: 'done', via: 'snapshot', detail: 'DOM completion snapshot (generating:false / completion_signal / failure) — still a PRODUCTION clear path, but DIAGNOSTIC for grading now (dom_done_ms). A bare generating:false is suppressed while a deep-research task is in flight (the initial-ack flicker), via the task_status in-flight flag.' },
    ],
    replayModes: ['events'],
    ssh: { supported: false, note: 'Desktop Chrome extension posts to the local Orchestra API only.' },
    note: 'watch_tracking.provider remains claude; the bank surface browser-claude distinguishes browser chat from the claude IDE agent. Scenarios: happy-path, happy-path-long, happy-path-again, happy-path-parallel, deep-research, deep-research-simple, canceled. GROUND TRUTH (2026-06: rewritten): GT done is **activity quiescence** — last meaningful provider activity (telemetry-filtered network + spoofer stream markers, incl. `task_completed`) + 90s quiet (lib/browser_chat_activity). DOM is `dom_done_ms` diagnostic only; sentinel removed. DEEP RESEARCH specifics: there is no /completion stream — the research is a `…/task/wf-<id>/status` poll loop whose body carries the terminal status, surfaced as the `task_completed` stream marker → /complete. The initial-ack DOM flicker (a bare generating:false ~1-2s in, before research) is SUPPRESSED via a `task_status:active` in-flight flag set from the first task-status request (lib/browser_chat shouldCompleteBrowserChatWatch), so it does not false-clear; the recorder synthesizes that flag at t=0. PRODUCTION = the /completion edge + DOM for a standard turn, task_completed → /complete for DR, /stop_response → /cancel. genInFlight keepalive holds the worker through a turn. ATTRIBUTION: conversation id is in the request URL (strongest of the three); S4 message_stop corroborates. Chrome-MCP DOM oracle is ground-truth-only.',
  },
  'browser-gemini': {
    status: 'supported',
    provider: 'browser-gemini',
    kind: 'browser_chat',
    hookProvider: null,
    captureMode: 'snapshot',
    remote: false,
    location: 'extensions/chat-watch + /api/browser-chats/*',
    extraSources: [
      'content-script DOM snapshots',
      'chrome.webRequest StreamGenerate* completion/error',
      'chrome.webRequest batchexecute rpcids=NkpXw request start (cancel)',
      'main-world stream-body sniffer: StreamGenerate chunked body holds c_<id> / rc_<id> (S5 — the only place Gemini\'s conversation/response id appears)',
      'debug probe logs for request lifecycle',
    ],
    liveOnlySources: [],
    recordedChannels: ['browser_chat_events', 'probe_logs', 'extra_signals', 'stream_signals'],
    replayChannels: ['browser_chat_events'],
    hookCatalog: null,
    sources: [
      { outcome: 'generating', via: 'snapshot', detail: 'Stop/activity/deep-research DOM heuristics (Gemini: thought/bottom-sheet UI in progress). DOM generating is also the GT START anchor.' },
      { outcome: 'done', via: 'web_request', detail: 'STANDARD turn: the StreamGenerate streaming POST completing → handleGeminiStreamComplete posts /api/browser-chats/complete (PRODUCTION done edge).' },
      { outcome: 'done', via: 'snapshot', detail: 'DEEP RESEARCH clears in production via the DOM completion snapshot (completion_signal) at the real research finish — the standard snapshot path (handles DR too). Gemini DR has no dedicated network done: StreamGenerate is only the intro and the research runs over a batchexecute poll loop with no clean completion request, so there is no claude-style task_completed nor a chatgpt-style quiescence backstop. The recorder GRADES GT done via activity-quiescence of that batchexecute loop (~195s); production uses DOM. The trade-off: a backgrounded gemini DR (DOM frozen) has no network done to fall back on.' },
      { outcome: 'cancelled', via: 'web_request', detail: 'batchexecute rpcids=NkpXw request start posts /api/browser-chats/cancel and clears straight back to the blank monitor pill. This opaque Gemini RPC appeared in all captured cancelled browser-chat runs and no captured happy/deep-research runs (keep under regression coverage). GT cancel = the harness cancel_sent (trusted Tab×3 → wait → Enter keystrokes).' },
      { outcome: 'attribution', via: 'stream_body', detail: 'S5: the StreamGenerate chunked response BODY holds c_<id> / rc_<id> — the only place Gemini\'s conversation/response id appears. Read by the extension main-world hook (chrome.webRequest cannot read bodies). The production attribution key, replacing the fragile tab /app/<id> URL + lastConversationId fallback. End-of-chunked-body is a stream-end done marker fed into the activity-quiescence GT. Gated behind the privacy toggle; structural fields only.' },
    ],
    replayModes: ['events'],
    ssh: { supported: false, note: 'Desktop Chrome extension posts to the local Orchestra API only.' },
    note: 'watch_tracking.provider remains gemini; the bank surface browser-gemini distinguishes browser chat from the antigravity gemini agent. Scenarios: happy-path, happy-path-long, happy-path-again, happy-path-parallel, deep-research, deep-research-simple, canceled. GROUND TRUTH (2026-06: rewritten): GT done is **activity quiescence** — last meaningful provider activity (telemetry-filtered network + spoofer stream markers) + 90s quiet (lib/browser_chat_activity). DOM is `dom_done_ms` diagnostic only; sentinel removed. DEEP RESEARCH: production clears gemini DR via the **DOM completion snapshot** at the real research finish (the standard snapshot path — confirmed by passing DR captures clearing at the completion_signal). Gemini DR has no dedicated network done (the research is a batchexecute poll loop with no clean completion request, and StreamGenerate is only the intro), so unlike claude (task_completed) and chatgpt (a quiescence backstop) it leans on DOM; the recorder GRADES GT done via activity-quiescence of the batchexecute loop. The trade-off is a backgrounded gemini DR (DOM frozen) having no network done to fall back on. PRODUCTION = StreamGenerate completion → /complete + DOM snapshots (standard) and the DOM completion snapshot (DR); cancel = batchexecute rpcids=NkpXw → /cancel. genInFlight keepalive holds the worker. ATTRIBUTION: c_<id>/rc_<id> from the StreamGenerate body (S5); opt-in, structural only. Capture-everything probe-logs + stream signals → extra_signals; Chrome-MCP DOM oracle is ground-truth-only.',
  },
  claude_chat: {
    status: 'research',
    provider: 'claude_chat',
    kind: 'browser_chat',
    hookProvider: null,
    captureMode: 'audit',
    remote: false,
    location: '~/Library/Application Support/Claude/{IndexedDB,Session Storage,Local Storage} plus ~/Library/Logs/Claude',
    extraSources: [
      'Claude Desktop storage and logs inspected by scripts/claude_chat_signal_session.js',
      'Future supported path should use lib/browser_chat.js plus extensions/chat-watch snapshots',
    ],
    liveOnlySources: [],
    recordedChannels: ['extra_signals (future)', 'research candidate timeline only today'],
    replayChannels: [],
    hookCatalog: null,
    sources: [
      {
        outcome: 'done',
        via: 'db',
        detail: 'Research-only persisted storage heuristics were timing-unstable and are not production replay inputs.',
      },
      {
        outcome: 'permission',
        via: 'ax',
        detail: 'Frontmost-only AX checkpoints can validate a manual run but are not attributable under concurrency.',
      },
      {
        outcome: 'question',
        via: 'ax',
        detail: 'Frontmost-only AX checkpoints can validate a manual run but are not attributable under concurrency.',
      },
      {
        outcome: 'cancelled',
        via: 'db',
        detail: 'Research-only persisted storage heuristics were not reliable enough for bank promotion.',
      },
    ],
    replayModes: [],
    ssh: {
      supported: false,
      note: 'Parked as research. Do not build storage/AX bank recordings; future support should use the browser extension channel.',
    },
    note:
      'Status research: keep the storage/AX script as evidence, but do not fold it into V3 adapters or signal-bank promotion. Future Claude web chat support should be based on lib/browser_chat.js and extensions/chat-watch.',
  },
  chatgpt_desktop: {
    status: 'research',
    provider: 'chatgpt_desktop',
    kind: 'desktop_app',
    hookProvider: null,
    captureMode: 'audit',
    remote: false,
    location: '~/Library/Application Support/com.openai.chat plus ~/Library/Group Containers/*openai* (storage/logs)',
    extraSources: [
      'ChatGPT desktop AX + storage inspected by scripts/chatgpt_mode_probe.js / chatgpt_watch.js (lib/chatgpt_ax_flow.js, lib/chatgpt_ax_signals.js)',
    ],
    liveOnlySources: [],
    recordedChannels: ['extra_signals (future)', 'research candidate timeline only today'],
    replayChannels: [],
    hookCatalog: null,
    sources: [
      {
        outcome: 'done',
        via: 'ax',
        detail: 'No attributable production signal found. Frontmost-only AX (Stop-generating vs Send) can validate a manual run but is not attributable under concurrency.',
      },
      {
        outcome: 'permission',
        via: 'ax',
        detail: 'N/A — ChatGPT desktop has no permission/question gate surface usable as a production signal.',
      },
      {
        outcome: 'question',
        via: 'ax',
        detail: 'N/A — no reliable, attributable question signal found.',
      },
      {
        outcome: 'cancelled',
        via: 'ax',
        detail: 'No reliable attributable cancel signal found in storage/logs.',
      },
    ],
    replayModes: [],
    ssh: {
      supported: false,
      note: 'Parked as research. Local macOS app only; no viable Orchestra signal found.',
    },
    note:
      'Status research: no viable production signal found despite AX/storage/log probing. Keep the chatgpt_* AX scripts as evidence; do not fold into V3 adapters or signal-bank promotion. Revisit only if a browser-extension or app-level signal surfaces.',
  },
};

function uniqueHookEvents(events) {
  const out = [];
  const seen = new Set();
  for (const event of events || []) {
    if (typeof event !== 'string') continue;
    const trimmed = event.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeHookProfile(profile) {
  const p = String(profile || '').trim().toLowerCase();
  if (p === 'maximal' || p === 'all') return 'maximal';
  return 'production';
}

function getHookCatalog(provider) {
  const entry = getRegistryEntry(provider);
  if (!entry?.hookCatalog) return { captured: [], available: [] };
  return {
    captured: uniqueHookEvents(entry.hookCatalog.captured),
    available: uniqueHookEvents(entry.hookCatalog.available),
  };
}

function getHookEventsForProfile(provider, profile = 'production') {
  const catalog = getHookCatalog(provider);
  const normalized = normalizeHookProfile(profile);
  if (normalized === 'maximal') {
    return uniqueHookEvents([...catalog.captured, ...catalog.available]);
  }
  return uniqueHookEvents(catalog.captured);
}

function getRegistryEntry(provider) {
  const id = String(provider || '').trim();
  if (REGISTRY[id]) return REGISTRY[id];
  // Deprecated registry id — hook catalog and docs checks still use `gemini`.
  if (id === 'gemini') return REGISTRY['agy-cli'] || null;
  // Live Orchestra watch_tracking uses the production `cursor` provider; the registry split it into
  // cursor_ide (IDE) + cursor_cli (CLI). `cursor` resolves to the IDE entry (same hook catalog + watch
  // logic) so getHookEventsForProfile('cursor') / hook-catalog checks keep working.
  if (id === 'cursor') return REGISTRY.cursor_ide || null;
  return null;
}

/** Map an agent_watch_harness agent name to a registry provider id. */
function providerForAgent(agent) {
  const a = String(agent || '');
  if (a.startsWith('cursor')) return 'cursor';
  if (a === 'agy-cli') return 'agy-cli';
  if (a === 'agy-app') return 'agy-app';
  if (a === 'claude-cowork') return 'claude_cowork';
  return a; // claude, codex
}

function listProviders() {
  // cursor_ide is defined in-place (before cursor_cli) in REGISTRY, so insertion order already gives
  // the desired cursor_ide → cursor_cli grouping — no reordering needed.
  return Object.keys(REGISTRY);
}

// Per-source ssh disposition for the sshCapable session platforms — the human-facing declaration of
// how each capture source behaves over ssh. tests/signal_source_ssh_parity.test.js cross-checks this
// against the actual adapter source descriptors (scripts/sessions/*_signal_session.js), so the two
// can never drift: adding/changing a source without updating this map (or vice-versa) fails CI.
//   same             — identical read both ways
//   remote-read      — read over ssh (the source has a pollRemote, or its poll self-branches)
//   local-regardless — always read locally even over ssh (data lives on the control machine)
//   skip             — not captured over ssh (absent/redundant remotely)
// Keyed by provider (matches REGISTRY keys); the value maps source id → disposition. Reasons live on
// the adapter source descriptors (sshReason) to avoid duplicating prose here.
const SSH_SOURCE_DISPOSITIONS = {
  claude: {
    hooks: 'same',
    transcript_discover: 'skip',
    transcript: 'remote-read',
    file_stat: 'skip',
    // Was 'skip' (TG-CC-3): the ssh gate launch pipes the remote TUI stdout into the LOCAL capture
    // log, so the terminal gate scanner reads identically over ssh — local-regardless by nature.
    // Without it no terminal-source gate event exists over ssh and the gate GT block can never pass.
    terminal_gate: 'local-regardless',
  },
  codex: {
    hooks: 'same',
    session_discover: 'same',
    transcript: 'remote-read',
    // Was 'skip' (backlog #7, fixed 2026-07-07): worker rollouts are now discovered by agent-id
    // filename suffix under the remote ~/.codex/sessions and tailed incrementally over ssh
    // (_tailWorkerRolloutsRemote), capture parity with the production remoteCodexAgentRolloutFacts
    // read — so ssh sub-agent recordings carry subagent_transcripts and the rollout-only
    // (hook-silent worker) release path is capturable/replayable over ssh.
    subagent_transcripts: 'remote-read',
    file_stat: 'skip',
  },
  // codex-desktop --source ssh (watch-only; live-validated 2026-07-07, P2-3 round: 5/5 PASS,
  // topology REAL, GO for first-class support): the LOCAL Codex.app GUI drives the agent against a
  // remote workspace; only the signals are captured over ssh. The desktop session script reuses
  // the codex recorder adapter, so its capture sources (and these dispositions) are identical to
  // `codex` BY CONSTRUCTION — the parity test pins codex_desktop to that shared adapter, so a
  // future desktop-specific adapter fork must update this map. Worker rollouts: capture parity
  // with production closed 2026-07-07 (backlog #7) — the recorder now tails the remote worker
  // rollout (`subagent_transcripts: 'remote-read'`, _tailWorkerRolloutsRemote), matching the
  // PRODUCTION remote read (remoteCodexAgentRolloutFacts via a background-refreshed cache; cold
  // cache degrades to the 30s quiet backstop).
  codex_desktop: {
    hooks: 'same',
    session_discover: 'same',
    transcript: 'remote-read',
    subagent_transcripts: 'remote-read',
    file_stat: 'skip',
  },
  // cursor_ide --source ssh: the Cursor GUI + AX driver stay LOCAL (watch-only, no remote
  // launch); only the agent + its signals are remote. Three sources:
  //   - cursor_probe (mixed): reads IDENTICALLY over ssh (`same`) — the dev-server hook API (the
  //     remote agent's hooks arrive via the reverse tunnel) plus the LOCAL Cursor AX / renderer.log
  //     gate signals, which are local-by-nature even for a Remote-SSH workspace (the Cursor UI
  //     renders on the control machine). CAVEAT (Step-0 2026-07-07): the probe's Cursor Agent
  //     Exec.log arm is BLIND over ssh — exec.log moves to the remote ~/.cursor-server for a
  //     Remote-SSH workspace; renderer.log (local) is the sole main-agent gate channel.
  //   - transcript (`remote-read`): the agent runs on the remote workspace, so its transcript — the
  //     test's done sentinel, the production AskQuestion signal, and the cancel marker — lives on the
  //     remote host and is read over ssh (_pollTranscriptRemote).
  //   - sibling_tasks (`remote-read`, TG-CID-1 fix 2026-07-07): child (Task) sub-agent transcripts in
  //     the parent's remote subagents/ underdir — the continuation hold's arm/release surface — are
  //     scanned over ssh (_pollSubagentsRemote), mirroring the production remote continuation gate.
  cursor_ide: {
    cursor_probe: 'same',
    transcript: 'remote-read',
    sibling_tasks: 'remote-read',
  },
  cursor_cli: {
    hooks: 'remote-read',
    transcript: 'remote-read',
    subagent_transcripts: 'remote-read',
    chat_db: 'remote-read',
    chat_db_content: 'remote-read',
    capture_log_gate: 'remote-read',
    // Continuation surfaces (sibling sub-agent transcripts + terminal task files): scanned on the
    // remote host since 2026-07-05 (_pollSiblingTasksRemote), capture parity with the production
    // remote continuation gate (lib/cursor_cli_continuation.js createRemoteContinuationOps).
    sibling_tasks: 'remote-read',
  },
  'agy-cli': {
    transcript: 'remote-read',
    hooks: 'remote-read',
    db_permission: 'remote-read',
    cli_log_permission: 'remote-read',
    cli_log_cancel: 'remote-read',
    hook_debug: 'remote-read',
    // Was effectively skip (the ssh reader did not exist): the DB step-status busy/settle
    // channel is now read from the remote conversation DBs (readRemoteAgyCliDbStepStatusSignals).
    db_status: 'remote-read',
  },
};

module.exports = {
  REGISTRY,
  SSH_SOURCE_DISPOSITIONS,
  getRegistryEntry,
  providerForAgent,
  listProviders,
  getHookCatalog,
  getHookEventsForProfile,
  normalizeHookProfile,
};
