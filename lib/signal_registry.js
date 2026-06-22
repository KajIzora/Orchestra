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
 * @property {string} outcome      done | cancelled | permission | question
 * @property {string} via          hook | transcript | renderer | audit | db
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
      captured: ['UserPromptSubmit', 'SessionStart', 'Stop', 'PermissionRequest', 'Notification'],
      available: [
        'Setup',
        'InstructionsLoaded',
        'UserPromptExpansion',
        'MessageDisplay',
        'PreToolUse',
        'PostToolUse',
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
    // Surfaces sharing this entry (same provider id `claude`, same hook store + watch logic):
    //   - claude-code-desktop (Claude Desktop app): emits ONLY UserPromptSubmit + Stop. No
    //     SessionEnd / MessageDisplay / tool hooks / SubagentStop. Relies purely on the
    //     Stop-debounce for done (no SessionEnd hard-close).
    //   - claude-code (CLI) and the VS Code plugin: emit the full catalog (UserPromptSubmit,
    //     Stop, SessionEnd, MessageDisplay, PreToolUse/PostToolUse, SubagentStop, …).
    //   Both surfaces emit the same UserPromptSubmit resume heralds (<task-notification> for
    //   background tasks, the cron's prompt verbatim for cron fires) and the same Stop body
    //   (background_tasks + session_crons), so the done-detection is identical across them.
    surfaces: {
      'claude-code-desktop': { hookEvents: ['UserPromptSubmit', 'Stop'], note: 'Desktop app emits only these two; no SessionEnd — done relies on the Stop debounce.' },
      'claude-code-cli': { hookEvents: 'full catalog (see hookCatalog)', note: 'CLI emits SessionEnd, MessageDisplay, tool hooks, SubagentStop, etc.' },
      'claude-code-plugin': { hookEvents: 'full catalog (see hookCatalog)', note: 'VS Code plugin matches the CLI surface.' },
    },
    // Backend state captured on each Stop snapshot (claude_hook_store) and surfaced for a future
    // "running / scheduled" view. Does NOT change the tracking flip — it is attribution only.
    backendState: [
      { field: 'background_tasks', detail: 'running supervised shell tasks at the Stop (id/type/status/description/command). A Stop with any running task is "busy" → debounced.' },
      { field: 'session_crons', detail: 'scheduled crons registered at the Stop (id/schedule/recurring/prompt; incl. ScheduleWakeup self-reminders). A Stop with pending crons is "busy" → debounced; crons no longer block done.' },
    ],
    // Done flips on idle OR debounce, and a resume can flip back (flicker):
    //   - idle Stop (no running background_tasks AND no pending session_crons) → done immediately.
    //   - busy Stop (running background_tasks OR pending crons) → held for the 15s debounce
    //     (stopDebounceMs); a resume within the window keeps tracking (no flicker); a resume
    //     after it re-arms tracking (done→tracking flicker). Resume = ANY UserPromptSubmit
    //     (task-notification, cron-fired prompt, or human message) — tracking follows generation.
    flickerBehavior: {
      debounce_ms: 15000,
      idle_clear: 'immediate',
      busy_clear: 'after debounce',
      resume_within_window: 'stays tracking (seamless)',
      resume_after_window: 'done shown then re-tracks (flicker — tolerated)',
      reactivation_trigger: 'any UserPromptSubmit (cause stored as backend state, not gated on)',
    },
    sources: [
      {
        outcome: 'done',
        via: 'hook',
        detail:
          'Stop hook: an idle Stop (no running background_tasks, no pending session_crons) clears to done immediately; a busy Stop clears after the 15s debounce (stopDebounceMs). A resume (any UserPromptSubmit) within the window keeps tracking; after it, tracking re-arms (flicker). session_crons no longer block done — they are stored as backend state. Transcript end_turn alone does NOT clear.',
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
        outcome: 'permission',
        via: 'transcript',
        detail:
          'after pause: user tool_result resumes tracking (primary — Claude Code emits no permission-resolved hook)',
      },
      {
        outcome: 'question',
        via: 'transcript',
        detail:
          'after pause: AskUserQuestion tool_result resumes tracking ("User has answered your questions:" or "Your questions have been answered:")',
      },
      {
        outcome: 'permission',
        via: 'hook',
        detail:
          'after pause: any later hook on the session (fallback; in captures often the next PermissionRequest, slower than tool_result)',
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
        'SSH cat full session JSONL for shouldCompleteRemoteClaudeWatch; SSH tail -c for resume (remoteClaudeWatchActiveGenerationSince), permission-hint stale check, and picker enrichment. Recorder tails 512 KiB per phase (fetch_ms).',
      unavailable: [
        'local session JSONL mtime poll (~400ms fs.watchFile while needs-input) — remote uses the 2s watch poller only',
      ],
      differences: [
        'watch poller uses shouldCompleteRemoteClaudeWatch (remoteClaudeWatchCompletionSince) instead of local file read',
        'paused resume: remoteClaudeWatchActiveGenerationSince over SSH tail',
        'paused cancel while needs-input: remoteClaudeTranscriptCancelSince over SSH tail -c 512 KiB',
        'permission-hint stale drop: remote tail read (isClaudePermissionCompletionHintStale)',
        'picker rows tagged source:ssh + host + projects_root; transcript tail enriched over SSH',
      ],
      replay:
        'shouldCompleteRemoteClaudeWatch runs the same recorded transcript predicate as local; only the real SSH read is skipped. fetch_ms on each transcript phase models remote round-trip cost in modeled_e2e_ms.',
      note:
        'Clock-skew caveat: transcript-internal timestamps are on the remote host; compare against linked_at on the control Mac — keep both on NTP.',
    },
    note:
      'Needs-input → tracking: transcript tool_result is the fastest resume signal (signal-tail captures show no hook between answer and tool_result). Live server also polls local transcript mtime during pause (~400ms) and treats any post-pause hook as a resume fallback. UI refresh while paused is 2s. Stale permission hints are dropped once transcript shows a user tool_result after the hook. For done: an idle Stop clears immediately; a busy Stop (running background_tasks or pending session_crons) is held for the 15s debounce (stopDebounceMs) then clears — a resume within the window keeps tracking, after it tracking re-arms (flicker). session_crons no longer block done; background_tasks + session_crons are stored on the snapshot as backend state for a future running/scheduled view (see surfaces/backendState/flickerBehavior). The UI still shows tracking → done; the extra state is backend-only. Same logic across Claude Desktop (UserPromptSubmit+Stop only, no SessionEnd) and the CLI/plugin (full catalog).',
  },
  cursor: {
    status: 'supported',
    provider: 'cursor',
    kind: 'cursor',
    hookProvider: 'cursor',
    captureMode: 'hooks',
    remote: true,
    location: '~/.cursor/projects/<slug>/agent-transcripts/<run>/<run>.jsonl',
    extraSources: [
      '~/Library/Application Support/Cursor/logs/**/renderer*.log (wakelock — main-agent permissions + question gate + active composerId per window)',
      '~/Library/Application Support/Cursor/logs/**/exthost/anysphere.cursor-agent-exec/Cursor Agent Exec.log (shell permission gate — universal: fires for both main-agent and sub-agent)',
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
      { outcome: 'done', via: 'hook', detail: 'stop / sessionEnd hook (status=completed)' },
      { outcome: 'cancelled', via: 'hook', detail: 'stop / sessionEnd hook (status=aborted/cancelled)' },
      { outcome: 'permission', via: 'renderer', detail: 'renderer.log wakelock (user-approval-requested) — main-agent shell permissions and question gates; does NOT fire for sub-agent shell permissions' },
      { outcome: 'permission', via: 'agent_exec', detail: 'Cursor Agent Exec.log "Shell permissions: requesting shell approval" — universal shell permission signal; the only source that covers sub-agent permissions. Conversation resolved via co-located renderer.log active composerId (agent-loop wakelock).' },
      { outcome: 'question', via: 'transcript', detail: 'pending AskQuestion in the transcript — only sometimes written; real captures often surface the question via renderer.log as gate=permission instead' },
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
        'renderer.log + Cursor Agent Exec.log remain LOCAL on the control Mac (still drive permission gates for SSH-remote workspaces opened in Cursor)',
        'watch poller uses shouldCompleteRemoteCursorWatch (same predicate, SSH transcript read)',
        'paused resume: shouldCompleteRemoteCursorWatch on SSH transcript (no renderer-only path on remote transcript)',
      ],
      replay:
        'shouldCompleteRemoteCursorWatch uses recorded transcript; renderer_events replay locally. fetch_ms models SSH transcript read cost.',
    },
    note: 'renderer.log fires user-approval-requested for main-agent permissions/questions but is silent for sub-agent shell permissions. Cursor Agent Exec.log fires for all shell permissions regardless of agent level and is used as the universal source; renderer.log still handles question gates and is needed to resolve window→composerId for the exec probe. Both probes run in parallel — for main-agent shell permissions both fire (deduped by pendingByConversation); for sub-agent permissions only the exec probe fires.',
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
    recordedChannels: ['hook_events', 'transcript_phases'],
    replayChannels: ['hook_events', 'transcript_phases'],
    hookCatalog: {
      // Observed set the cursor-agent CLI actually emits (verified 2026-06-16). It is a
      // subset of the cursor IDE catalog: the CLI never fires sessionEnd, subagentStart/
      // Stop, before/afterMCPExecution, before/afterTab*, or preCompact.
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
      { outcome: 'done', via: 'hook', detail: 'stop hook with status=completed' },
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
        via: 'hook',
        detail:
          'No single permission hook exists (preToolUse/beforeShellExecution fire for every tool, gated or not), but the gate is DERIVED by config-eval + arm/resume: lib/cursor_cli_permission.js merges ~/.cursor/cli-config.json + project .cursor/cli.json, evaluates each preToolUse (deny→Run-Everything→allow→prompt), arms permission_pending on a "prompt", and resumes on the matching postToolUse / next tool / stop. A debounce (gate not surfaced until ~2s) + per-session force-latch make it flicker-free; --force/--yolo is invisible in hooks so a hidden-force session\'s first long-running tool can false-positive once. CLI-only (gated off the IDE by cursor_version CalVer-vs-SemVer). The session recorder still scrapes the capture log as ground truth to validate predictions.',
      },
      {
        outcome: 'question',
        via: 'transcript',
        detail:
          'transcript tool_use named AskQuestion. The only question signal (no preToolUse hook for it); delayed (arrives after the gate renders) and not 100% reliable (missing in some runs).',
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
      differences: [
        'permission gate: lib/cursor_cli_permission.js merges remote cli-config over SSH (sources tagged ssh:<host>)',
        'no sub-agent hook surface — Task appears as ordinary tool calls in one conversation_id',
        'TUI capture log (scripts/cursor_cli_session.js) is recorder ground truth when validating remote runs',
      ],
      replay: 'Same hook+transcript replay as local; fetch_ms on remote transcript phases.',
    },
    note:
      'cursor-agent CLI shares ~/.cursor hooks + transcripts with the IDE but is a separate surface (distinguished by cursor_version: CLI is CalVer 2026.06.15-…, IDE is SemVer 3.x.y). done is hook-driven (stop.status=completed); cancelled is hook-primary (stop.status=aborted) with a transcript fallback (turn_ended manual abort). Permission has no single hook, but is DERIVED from the per-tool hooks + the CLI permission config via lib/cursor_cli_permission.js (config-eval + arm/resume, mirroring Codex/Gemini), wired into the live watch tracker as a permission gate; the TUI capture log (scripts/cursor_cli_session.js) is no longer the only source but remains the recorder ground truth. Question is transcript-only via AskQuestion and is delayed. No sub-agent hooks: a Task/sub-agent appears as ordinary tool calls within the one conversation_id.',
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
      captured: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop'],
      available: ['PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop'],
    },
    sources: [
      { outcome: 'done', via: 'hook', detail: 'Stop hook / task_complete transcript event (NB: this hook also fires when the turn ended on a question — see note)' },
      { outcome: 'permission', via: 'hook', detail: 'PermissionRequest hook / pending permission in transcript; a later generating PostToolUse after the pause resumes tracking (including sub-agent permissions whose hook keeps the parent session_id but points at the child transcript_path)' },
      { outcome: 'question', via: 'transcript', detail: 'pending request_user_input in transcript; combined detection prefers this over the turn-complete hook' },
      { outcome: 'cancelled', via: 'transcript', detail: 'turn_aborted transcript event (no cancel hook)' },
    ],
    replayModes: ['both', 'hooks-only', 'transcript-only'],
    ssh: {
      supported: true,
      hookDelivery:
        'Remote hook script POSTs to Orchestra. Default install route opens a reverse SSH tunnel and writes a remote remoteApiBase pointing at http://127.0.0.1:<remotePort> (48725 dev / 48726 stable); the $SSH_CLIENT → control-Mac LAN-IP POST is a fallback (and the route the live agent_watch_harness uses). Same hook catalog as local. Stop hook drives done/permission; transcript fallbacks via SSH read; transcript-only Stop synthesis stamps remote_host.',
      hookInstall: 'POST /api/projects/:id/codex-hooks/install-remote → opens reverse hook tunnel, then ~/.codex/config.toml merge + task-app-codex-hook.sh',
      transcriptRead:
        'SSH cat full session JSONL for remoteCodexWatchShouldClearSince; SSH tail -c for resume (remoteCodexWatchActiveGenerationSince) and picker enrichment. Recorder tails 512 KiB per phase (fetch_ms).',
      differences: [
        'watch poller uses shouldCompleteRemoteCodexWatch (remoteCodexWatchShouldClearSince)',
        'paused resume: remoteCodexWatchActiveGenerationSince over SSH tail',
        'picker matches hook snapshots by remote_host + ssh workspace path',
        'sub-agent permissions: hook keeps parent session_id with child transcript_path — same as local',
      ],
      replay:
        'shouldCompleteRemoteCodexWatch mirrors local transcript predicate on recorded text; fetch_ms models SSH cost.',
      note: 'agy-app / claude-cowork have no remote variant. With the reverse-tunnel install route the remote posts to 127.0.0.1:<remotePort>, so no LAN bind is needed; HOST=0.0.0.0 is only required for the $SSH_CLIENT/LAN-IP fallback route (e.g. the live harness).',
    },
    note: 'Codex emits a turn-complete hook even when the turn ends on a question — in isolation (hooks-only) it misreads as done, so combined detection prefers the transcript\'s request_user_input. Question and cancel are transcript-only (no question/cancel hook). Permission resume is hook-driven: after a PermissionRequest clears to needs-input, a later generating PostToolUse with the same session/transcript identity flips the watch back to tracking. For sub-agent permissions, Codex hook payloads keep the parent session_id while the transcript_path points at the child transcript; session matching is what lets the parent watch resume before the child finishes.',
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
      'Antigravity app conversation DB: local cancel + permission signals (step_type=21 + permissions blob; WAL "context canceled" markers), normalized into the Gemini hook store',
      'Antigravity app language_server.log: local cancel fallback, normalized into the Gemini hook store',
    ],
    recordedChannels: ['hook_events', 'transcript_phases'],
    replayChannels: ['hook_events', 'transcript_phases'],
    hookCatalog: AGY_HOOK_CATALOG,
    sources: [
      { outcome: 'done', via: 'hook', detail: 'agy Stop with terminationReason=NO_TOOL_CALL + fullyIdle (completion_hint). Fallback: agy transcript-idle quiescence after a partial Stop.' },
      { outcome: 'permission', via: 'hook', detail: 'agy PreToolUse for a gated tool (run_command / write_to_file / replace_file_content) → permission_pending' },
      {
        outcome: 'permission',
        via: 'db',
        detail:
          'Antigravity app conversation DB rows (step_type=21 + permissions blob); live server normalizes these into permission_pending hints (not captured as db rows by the recorder; the signal:session tail reconstructs synthetic hook bodies for replay)',
      },
      { outcome: 'question', via: 'hook', detail: 'agy PreToolUse for the ask_question tool → question_pending' },
      { outcome: 'cancelled', via: 'hook', detail: 'agy Stop with terminationReason=USER_CANCELED (cancel_hint), or transcript cancellation' },
      {
        outcome: 'cancelled',
        via: 'db',
        detail:
          'Antigravity app conversation DB/WAL bytes containing "context canceled" markers; live server normalizes these into cancel hints (not captured as db bytes by the recorder; the signal:session tail reconstructs synthetic hook bodies for replay)',
      },
    ],
    replayModes: ['both', 'hooks-only', 'transcript-only'],
    ssh: {
      supported: false,
      note: 'Local Electron app only — harness has no --source ssh variant (agent_watch_harness.js skips agy-app under --source ssh).',
    },
    note:
      'Orchestra watch_tracking.provider is `gemini` (same as agy-cli). Antigravity app (Electron): real agy hooks (PreInvocation / PostInvocation / PreToolUse / PostToolUse / Stop) plus live-only app DB/WAL and language_server.log signals normalized into the gemini hook store. Transcript fns are fallbacks. DB-derived permission/cancel never reach the HTTP raw tap — the signal:session tail re-derives them for replay.',
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
      'Antigravity CLI logs: local/remote cancel + permission fallbacks, normalized into the Gemini hook store',
    ],
    recordedChannels: [
      'hook_events',
      'transcript_phases',
      'remote log-derived synthetic hook_events only when tapped by the server',
    ],
    replayChannels: ['hook_events', 'transcript_phases'],
    hookCatalog: AGY_HOOK_CATALOG,
    sources: [
      { outcome: 'done', via: 'hook', detail: 'agy Stop with terminationReason=NO_TOOL_CALL + fullyIdle (completion_hint). Fallback: agy transcript-idle quiescence after a partial Stop.' },
      { outcome: 'permission', via: 'hook', detail: 'agy PreToolUse for a gated tool (run_command / write_to_file / replace_file_content) → permission_pending' },
      { outcome: 'question', via: 'hook', detail: 'agy PreToolUse for the ask_question tool → question_pending' },
      { outcome: 'cancelled', via: 'hook', detail: 'agy Stop with terminationReason=USER_CANCELED (cancel_hint), or transcript cancellation' },
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
        'remote agy CLI log cancel signals (readRemoteAgyCliCancelSignals)',
        'remote agy CLI conversation DB permission rows (readRemoteAgyCliDbPermissionSignals) → synthetic gemini hook bodies',
      ],
      differences: [
        'remote picker can use hookOnlyRemote:true for fast hook-only rows; list API uses hookOnlyRemote:false for transcript enrichment',
        'refreshGeminiSubAgentCacheForHost runs after remote hook-debug / permission DB polls',
        'legacy discoverRemoteGeminiRuns (~/.gemini/tmp) is deprecated — agy-cli uses antigravity-cli brain transcripts',
      ],
      replay:
        'Remote transcript predicates use the same recorded text as local (buildGeminiPollerDeps transcriptCancelRemote / transcriptDoneRemote); fetch_ms models SSH read cost. Polled log/DB synthetics appear in hook_events when tapped during capture.',
    },
    note:
      'Orchestra watch_tracking.provider is `gemini` (same as agy-app). Antigravity CLI: headless agy hooks written to hook-debug.log and POSTed to Orchestra; CLI log/DB fallbacks for cancel/permission on local and remote. No app conversation DB. signal-bank recordings still use provider `gemini` in metadata.',
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
      { outcome: 'done', via: 'audit', detail: 'completed result (or rate-limit rejection)' },
      { outcome: 'permission', via: 'audit', detail: 'AskUserQuestion permission request' },
      { outcome: 'cancelled', via: 'audit', detail: 'cancelled result / main-log cancel' },
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
      'chrome.webRequest backend-api/conversation* completion/error',
      'main-world stream-body sniffer: SSE stream_handoff/resume_conversation_token carries conversation_id (S1) + [DONE] (S3)',
      'debug probe logs for request lifecycle',
    ],
    liveOnlySources: [],
    recordedChannels: ['browser_chat_events', 'probe_logs', 'extra_signals', 'stream_signals'],
    replayChannels: ['browser_chat_events'],
    hookCatalog: null,
    sources: [
      { outcome: 'generating', via: 'snapshot', detail: 'Stop/activity/deep-research DOM heuristics' },
      { outcome: 'done', via: 'web_request', detail: 'backend-api/conversation* generation request completed or errored (PRODUCTION done edge; tighter timing clock).' },
      { outcome: 'attribution', via: 'stream_body', detail: 'S1: SSE stream_handoff / resume_conversation_token frames carry conversation_id (+ turn_exchange_id) in the response BODY, read by the extension main-world hook (chrome.webRequest cannot read bodies). This is the PRODUCTION attribution key now — it replaces the fragile tab /c/<id> URL + lastConversationId fallback, closing the findings/10 §4 weak spot. S3 [DONE] is the clean stream-end edge (corroboration). Gated behind the privacy toggle; structural fields only.' },
      { outcome: 'done', via: 'snapshot', detail: 'idle/completion/failure snapshot (DOM landmark + sentinel line are GROUND TRUTH; failure collapses into done)' },
    ],
    replayModes: ['events'],
    ssh: { supported: false, note: 'Desktop Chrome extension posts to the local Orchestra API only.' },
    note: 'watch_tracking.provider remains chatgpt; the bank surface browser-chatgpt distinguishes browser chat from Codex. Partial framework: generating → done only (no permission/question/cancel gates — this surface exposes none). Two-tier signals: PRODUCTION = the extension network completion edge + DOM snapshots (what Orchestra clears on); GROUND TRUTH = the DOM completion landmark + a model-emitted sentinel line ("All steps done for test <code>"). ATTRIBUTION (v3-browser-signals): the main-world stream-body sniffer reads conversation_id from the SSE stream_handoff/resume_conversation_token frames (S1) — the production attribution key, replacing the tab-URL + lastConversationId fallback and closing the §4 weak spot. Body-reading is opt-in behind the privacy toggle and captures STRUCTURAL fields only (conversation_id, turn id, [DONE], endpoint, method, timing) — never model content. The recorder captures every observable provider request from the probe logs AND the stream signals into extra_signals (capture-everything); the optional Chrome-MCP DOM oracle is ground-truth-only and a green run never depends on it.',
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
      'main-world stream-body sniffer: SSE message_stop terminal frame (S4 — clean done edge, corroboration)',
      'debug probe logs for request lifecycle',
    ],
    liveOnlySources: [],
    recordedChannels: ['browser_chat_events', 'probe_logs', 'extra_signals', 'stream_signals'],
    replayChannels: ['browser_chat_events'],
    hookCatalog: null,
    sources: [
      { outcome: 'generating', via: 'snapshot', detail: 'Stop/activity/deep-research DOM heuristics (Claude: Stop response visible → generating; "Research complete" + no Stop → done)' },
      { outcome: 'done', via: 'web_request', detail: '/chat_conversations/<id>/completion* generation request completed or errored (PRODUCTION done edge). STRONGEST attribution of the three: the conversation id is in the request URL itself, so this is the cleanest done edge.' },
      { outcome: 'done', via: 'stream_body', detail: 'S4: SSE message_stop terminal frame, read by the extension main-world hook — a clean stream-end edge that CORROBORATES the already-strong URL attribution (Claude does not need the stream for attribution). Captured into extra_signals; gated behind the privacy toggle; structural fields only.' },
      { outcome: 'done', via: 'snapshot', detail: 'idle/completion/failure snapshot (DOM landmark + sentinel line are GROUND TRUTH; failure collapses into done)' },
    ],
    replayModes: ['events'],
    ssh: { supported: false, note: 'Desktop Chrome extension posts to the local Orchestra API only.' },
    note: 'watch_tracking.provider remains claude; the bank surface browser-claude distinguishes browser chat from the claude IDE agent. Partial framework: generating → done only. Claude is the best-attributed browser-chat surface because /chat_conversations/<id>/completion* carries the conversation id in the URL — it does NOT need the stream body for attribution. The main-world sniffer captures the SSE message_stop frame (S4) as a clean corroborating stream-end edge into extra_signals (capture-everything), gated behind the privacy toggle (structural only). Two-tier signals: PRODUCTION = network completion edge + DOM snapshots; GROUND TRUTH = DOM completion landmark + sentinel line. Chrome-MCP DOM oracle is ground-truth-only.',
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
      'main-world stream-body sniffer: StreamGenerate chunked body holds c_<id> / rc_<id> (S5 — the only place Gemini\'s conversation/response id appears)',
      'debug probe logs for request lifecycle',
    ],
    liveOnlySources: [],
    recordedChannels: ['browser_chat_events', 'probe_logs', 'extra_signals', 'stream_signals'],
    replayChannels: ['browser_chat_events'],
    hookCatalog: null,
    sources: [
      { outcome: 'generating', via: 'snapshot', detail: 'Stop/activity/deep-research DOM heuristics (Gemini: thought/bottom-sheet UI in progress; used-sources/message-content/export-menu test-ids → done)' },
      { outcome: 'done', via: 'web_request', detail: 'StreamGenerate* request lifecycle completed or errored (PRODUCTION done edge).' },
      { outcome: 'attribution', via: 'stream_body', detail: 'S5: the StreamGenerate chunked response BODY holds c_<id> / rc_<id> — the only place Gemini\'s conversation/response id appears. Read by the extension main-world hook (chrome.webRequest cannot read bodies). This is the PRODUCTION attribution key now — it replaces the fragile tab /app/<id> URL + lastConversationId fallback, closing the findings/10 §4 weak spot. End-of-chunked-body is the done edge. Gated behind the privacy toggle; structural fields only.' },
      { outcome: 'done', via: 'snapshot', detail: 'idle/completion/failure snapshot (DOM landmark + sentinel line are GROUND TRUTH; failure collapses into done)' },
    ],
    replayModes: ['events'],
    ssh: { supported: false, note: 'Desktop Chrome extension posts to the local Orchestra API only.' },
    note: 'watch_tracking.provider remains gemini; the bank surface browser-gemini distinguishes browser chat from the antigravity gemini agent. Partial framework: generating → done only. Gemini deep-research is the most valuable scenario (long generating→done window, multi-request StreamGenerate path). Two-tier signals: PRODUCTION = network completion edge + DOM snapshots; GROUND TRUTH = DOM completion landmark + sentinel line. ATTRIBUTION (v3-browser-signals): the main-world stream-body sniffer reads c_<id> / rc_<id> from the StreamGenerate chunked body (S5) — the production attribution key, replacing the tab-URL + lastConversationId fallback and closing the §4 weak spot. Body-reading is opt-in behind the privacy toggle and captures STRUCTURAL fields only — never model content. Capture-everything probe-log requests AND stream signals go to extra_signals; Chrome-MCP DOM oracle is ground-truth-only.',
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

REGISTRY.cursor_ide = {
  ...REGISTRY.cursor,
  provider: 'cursor_ide',
  note:
    `${REGISTRY.cursor.note} signal-bank Cursor IDE recordings use provider \`cursor_ide\` so replay and bank paths distinguish the IDE from cursor-agent CLI; live Orchestra watch_tracking still uses the production \`cursor\` key.`,
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
  const providers = Object.keys(REGISTRY);
  const cursorIdeIdx = providers.indexOf('cursor_ide');
  const cursorIdx = providers.indexOf('cursor');
  if (cursorIdeIdx !== -1 && cursorIdx !== -1 && cursorIdeIdx !== cursorIdx + 1) {
    providers.splice(cursorIdeIdx, 1);
    providers.splice(cursorIdx + 1, 0, 'cursor_ide');
  }
  return providers;
}

module.exports = {
  REGISTRY,
  getRegistryEntry,
  providerForAgent,
  listProviders,
  getHookCatalog,
  getHookEventsForProfile,
  normalizeHookProfile,
};
