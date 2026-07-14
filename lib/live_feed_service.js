'use strict';

/*
 * live_feed_service.js — assembles GET /api/projects/:id/live-feed responses (Lane C §0 contract).
 *
 * Pure function of in-memory state: the raw hook tap (hook_event_log), the per-task normalized
 * ring (live_turn_ring), and the task's own watch fields (watch_tracking / paused_watch_tracking /
 * watch_finished — the same fields the pill reads). NO disk reads — Phase-2b transcript-tail
 * adapters must come in through poll_guard (wrapShortTtlMemo) and append via ring.append; the
 * hook path here never blocks.
 *
 * FAIL SAFE: a failing lazy pull for one task degrades that task to its retained ring (or a
 * lifecycle-only row); it never 500s the response or blocks other tasks.
 *
 * Response per task (locked probe contract, lib/livefeed_probe.js):
 *   { task_id, session_key, provider, surface, tier, state, gate_kind, turn_id,
 *     base_seq, head_seq, reset, events: [{seq, t, kind, ...payload}],
 *     lifecycle: { elapsed_ms, tool_count, model, cwd, remote_host, prompt_preview,
 *                  stop_text, waiting_since } }
 */

const {
  normalizeHookEvent,
  providerLogKey,
  rawEventMatchesWatch,
  liveTierForWatch,
  clamp,
  CAPS,
} = require('./live_turn_normalizer');
const { createLiveTurnRing } = require('./live_turn_ring');
const { taskLiveState } = require('./signal_session/orchestra_live_poller');
const { reportedGateKind } = require('./watch_tracker');

/** The tracking binding a live-feed row keys off (active > paused > finished re-arm binding). */
function liveFeedWatchBinding(task) {
  if (!task || typeof task !== 'object') return null;
  return (
    task.watch_tracking ||
    task.cursor_tracking ||
    task.paused_watch_tracking ||
    (task.watch_finished ? task.completed_watch_tracking || null : null)
  );
}

// state served on the wire: taskLiveState phases → working | blocked | done | idle.
function liveStateForTask(task) {
  const cls = taskLiveState(task);
  if (!cls) return 'idle';
  if (cls.phase === 'active') return 'working';
  if (cls.phase === 'needs_input') return 'blocked';
  if (cls.phase === 'done') return 'done';
  return 'idle';
}

// gate_kind: only for blocked rows. Prefer the kind Orchestra REPORTED (watch_finished.gate_kind,
// born from reportedGateKind in the marker); fall back to computing it from the paused watcher.
function liveGateKind(task, wt) {
  const wf = task.watch_finished;
  if (wf && (wf.gate_kind === 'permission' || wf.gate_kind === 'question' || wf.gate_kind === 'unknown')) {
    return wf.gate_kind;
  }
  const source = task.paused_watch_tracking || wt || null;
  const computed = reportedGateKind(source);
  return computed || 'unknown';
}

// Mirror of server.js watchTrackingProviderKind for rows linked before provider_kind stamping.
function providerKindFallback(wt) {
  if (!wt || typeof wt !== 'object') return '';
  if (wt.kind === 'cursor') return 'cursor';
  if (wt.kind === 'process') return 'process';
  if (wt.kind === 'ide_agent') {
    if (wt.provider === 'claude' || wt.provider === 'claude_cowork') return 'claude';
    if (wt.provider === 'gemini' || wt.provider === 'gemini_cli') return 'gemini';
    if (wt.provider === 'codex') return 'openai';
    if (wt.provider === 'grok') return 'grok';
    return '';
  }
  if (wt.kind === 'browser_chat') {
    const p = String(wt.provider || '');
    if (p.includes('chatgpt')) return 'openai';
    if (p.includes('claude')) return 'claude';
    if (p.includes('gemini')) return 'gemini';
    return '';
  }
  return '';
}

// The `surface` a live-feed row serves. ide_agent/cursor watches carry a discovered surface
// ('cli' | 'desktop' | 'plugin', stamped onto task.surface_kind at link). A browser_chat watch
// has NO tracking surface (watchTrackingSurfaceKind is ide_agent/cursor-only) so real browser
// rows served '' and the UI's window-dots accessory (public/live_feed_ui.js, keys on
// surface === 'browser') never rendered — the ui-checks seed masked it by hardcoding
// surface_kind (Phase-3 verify-lane findings1 §2). Deriving from the watch KIND here fixes
// already-linked watches with no data migration and without touching task.surface_kind's
// task-board consumers.
function liveFeedSurface(task, wt) {
  return (
    (task && task.surface_kind) ||
    (wt && typeof wt.surface === 'string' && wt.surface) ||
    (wt && wt.kind === 'browser_chat' ? 'browser' : '')
  );
}

// codex writes the final turn text TWICE in its rollout — event_msg/agent_message (mapped by the
// rollout-notes adapter → a terminal `note`) and response_item/message (mapped by the Stop hook →
// `stop.text`) — yielding a redundant terminal note row equal to the stop text (Phase-3 codex
// findings1 §5, product polish). The streaming adapter has no look-ahead, so the dedupe happens
// at assembly: drop the LAST note when its text equals the served stop text. Position- and
// equality-guarded so a mid-run note that merely resembles the final answer is never dropped.
// Cap asymmetry (Phase-5 codex findings2 §3, F6-4): the note pipeline clamps to CAPS.noteText
// (400) while stop clamps to the larger CAPS.stopText, so a >400-char final answer arrives as the
// ellipsis-truncated note `clamp(text, 400)` and no longer byte-equals the stop text — the dup
// evaded the exact-equality filter. Both texts pass through the SAME clamp() (whitespace-flatten
// + slice), so re-clamping the served stop text to the note cap reproduces the note the terminal
// duplicate would have produced, exactly, in every length regime — match either form.
// Codex-scoped by the caller: agy deliberately rides completion on the final note (empty stop) and
// claude/cursor note shapes were Phase-3-graded as-is.
function withoutRedundantTerminalNote(events, fullEvents) {
  let stopText = '';
  let lastNote = null;
  for (const ev of fullEvents || []) {
    if (!ev) continue;
    if (ev.kind === 'stop' && typeof ev.text === 'string' && ev.text) stopText = ev.text;
    else if (ev.kind === 'note') lastNote = ev;
  }
  if (!stopText || !lastNote) return events;
  const isTerminalDup =
    lastNote.text === stopText || lastNote.text === clamp(stopText, CAPS.noteText);
  if (!isTerminalDup) return events;
  const filtered = events.filter((ev) => !(ev && ev.kind === 'note' && ev.seq === lastNote.seq));
  return filtered.length === events.length ? events : filtered;
}

function createLiveFeedService(options = {}) {
  const hookEventLog = options.hookEventLog || null;
  const ring = options.ring || createLiveTurnRing(options.ringOptions || {});
  const now = typeof options.now === 'function' ? options.now : Date.now;
  // Phase-2b pull adapters (disk/transcript-tail sources hooks don't carry — codex rollout notes,
  // cowork audit tail, …). Each is `{ pump(taskId, wt, nowMs) }`: a SYNC, non-blocking scheduler
  // that appends to `ring` in the background (its events land on the next poll). Held by reference
  // so wiring can push an adapter that itself needs `ring` after this service is built. Fail-safe
  // per adapter — a throwing pump never breaks a task's feed (§5 Seam B: cold/failed read ⇒ lower
  // tier, never a block or 500). The array is provider-agnostic so every pull-adapter lane shares
  // one seam.
  const tailAdapters = Array.isArray(options.tailAdapters) ? options.tailAdapters : [];
  // Second Seam-B shape: a map providerKey → pull({ taskId, wt, ring }) for adapters that read
  // synchronously within the tick off an already-debounced shared reader (e.g. the cursor chat
  // store.db head, which the watch poller reads anyway). Same fail-safe guarantee as tailAdapters.
  const pullAdapters = options.pullAdapters && typeof options.pullAdapters === 'object' ? options.pullAdapters : null;

  /**
   * Lazy pull: drain the task's provider slice of the raw hook tap into its normalized ring.
   * Seq-based high-water dedup (hook_event_log seq is globally monotonic) so a same-millisecond
   * boundary can never skip or duplicate an event. Any error leaves the retained ring intact.
   */
  function fillRingFromHookLog(taskId, wt) {
    if (!hookEventLog) return;
    const providerKey = providerLogKey(wt);
    if (!providerKey) return; // lifecycle-only platform: no raw hook flow
    const entry = ring.ensure(taskId);
    try {
      // First fill replays the full retained window (bounded: 5000/provider, 1h TTL) so a watch
      // linked mid-turn still reconstructs the whole current turn; later fills resume 1ms before
      // the high-water stamp and dedup by seq.
      const sinceIso = entry.last_raw_t_ms ? new Date(entry.last_raw_t_ms - 1).toISOString() : '';
      const rows = hookEventLog.since(providerKey, sinceIso) || [];
      for (const row of rows) {
        if (!row || !Number.isFinite(row.seq) || row.seq <= entry.last_raw_seq) continue;
        entry.last_raw_seq = row.seq;
        entry.last_raw_t_ms = Number.isFinite(row.t_ms) ? row.t_ms : entry.last_raw_t_ms || 0;
        if (!rawEventMatchesWatch(providerKey, row.body, wt)) continue;
        const normalized = normalizeHookEvent(providerKey, row, { state: entry.norm_state });
        if (normalized.length) ring.append(taskId, normalized);
      }
    } catch {
      // fail safe: serve whatever the ring retains; never block or throw into the route
    }
  }

  function lifecycleForTask(task, wt, state, snap, nowMs) {
    const events = snap.events || [];
    let toolStarts = 0;
    let toolEnds = 0;
    let model = null;
    let cwd = null;
    let lastStop = null;
    let lastPromptText = '';
    for (const ev of events) {
      if (ev.kind === 'tool_start') toolStarts += 1;
      else if (ev.kind === 'tool_end') toolEnds += 1;
      else if (ev.kind === 'meta') {
        if (ev.model) model = ev.model;
        if (ev.cwd) cwd = ev.cwd;
      } else if (ev.kind === 'stop') lastStop = ev;
      else if (ev.kind === 'prompt') lastPromptText = ev.text || '';
    }
    const t0 = snap.t0_abs_ms || 0;
    let elapsedMs = null;
    if (t0) {
      elapsedMs = state === 'done' && lastStop ? lastStop.t : Math.max(0, nowMs - t0);
    }
    const wf = task.watch_finished || null;
    return {
      elapsed_ms: elapsedMs,
      tool_count: Math.max(toolStarts, toolEnds),
      model,
      cwd: (wt && typeof wt.workspace_path === 'string' && wt.workspace_path) || cwd || null,
      remote_host: (wt && wt.source === 'ssh' && wt.host) || null,
      prompt_preview:
        (wt && typeof wt.last_user_preview === 'string' && wt.last_user_preview) || lastPromptText || '',
      stop_text: state === 'done' && lastStop && lastStop.text ? lastStop.text : null,
      waiting_since:
        state === 'blocked'
          ? (wf && wf.paused_at) || (task.paused_watch_tracking && task.paused_watch_tracking.clear_signal_at) || null
          : null,
    };
  }

  /**
   * One task's live-feed row, or null when the task is not tracked. Never throws.
   */
  function buildTaskFeed(task, sinceMap, nowMs) {
    const wt = liveFeedWatchBinding(task);
    if (!wt) return null;
    try {
      fillRingFromHookLog(task.id, wt);
      // Live state (done/blocked/working/idle) is a task-level fact (no ring/pull dependency), so it
      // is computed here and passed into the pull adapters — the cursor pull needs it for its
      // POST-DONE final-message step (append the closing message as stop text on the done flip).
      const state = liveStateForTask(task);
      // Schedule any transcript-tail pull adapters (codex rollout notes, cowork audit tail, …).
      // Sync + fail-safe: pump appends in the background for the next poll and never throws here.
      for (const adapter of tailAdapters) {
        try {
          if (adapter && typeof adapter.pump === 'function') adapter.pump(task.id, wt, nowMs);
        } catch {
          /* an adapter can never break a task's feed */
        }
      }
      // Provider-keyed pull adapters (cursor store.db question head + post-done stop text, …):
      // synchronous within the tick off an already-debounced shared reader; same fail-safe guarantee.
      if (pullAdapters) {
        const pull = pullAdapters[providerLogKey(wt)];
        if (typeof pull === 'function') {
          try { pull({ taskId: task.id, wt, ring, state }); } catch { /* pull is fail-safe; ignore */ }
        }
      }
      const sinceRaw = sinceMap && Object.prototype.hasOwnProperty.call(sinceMap, task.id) ? Number(sinceMap[task.id]) : null;
      const snap = ring.snapshot(task.id, Number.isFinite(sinceRaw) ? sinceRaw : null);
      // Lifecycle is a fact about the WHOLE retained turn, not the delta slice — a steady-state
      // delta poll (events: []) must still report tool_count/model/stop_text.
      const fullSnap = snap.reset || sinceRaw == null ? snap : ring.snapshot(task.id, null);
      // codex only: drop the redundant terminal note that duplicates stop.text (see
      // withoutRedundantTerminalNote). Judged against the FULL turn so a delta poll that carries
      // the late note (the stop landed a poll earlier) filters it too.
      const events = providerLogKey(wt) === 'codex'
        ? withoutRedundantTerminalNote(snap.events, fullSnap.events)
        : snap.events;
      return {
        task_id: task.id,
        session_key: wt.session_id || wt.conversation_id || '',
        provider: task.provider_kind || providerKindFallback(wt),
        surface: liveFeedSurface(task, wt),
        tier: liveTierForWatch(wt),
        state,
        gate_kind: state === 'blocked' ? liveGateKind(task, wt) : null,
        turn_id: snap.turn_id,
        base_seq: snap.base_seq,
        head_seq: snap.head_seq,
        reset: snap.reset,
        events,
        lifecycle: lifecycleForTask(task, wt, state, fullSnap, nowMs),
      };
    } catch {
      return null; // fail safe: omit this task's feed rather than break the response
    }
  }

  /**
   * The full endpoint payload for one project. `sinceMap` = decoded ?since cursor
   * ({taskId: headSeq}); `taskIds` = optional narrowing set/array from ?tasks=.
   */
  function buildProjectFeed(project, { sinceMap = {}, taskIds = null, nowMs = now() } = {}) {
    const narrowing = taskIds
      ? new Set((Array.isArray(taskIds) ? taskIds : [...taskIds]).map(String).filter(Boolean))
      : null;
    const tasks = [];
    for (const task of (project && project.tasks) || []) {
      if (!task || !task.id) continue;
      if (narrowing && narrowing.size && !narrowing.has(String(task.id))) continue;
      const row = buildTaskFeed(task, sinceMap, nowMs);
      if (row) tasks.push(row);
    }
    return { now: nowMs, tasks };
  }

  return {
    buildProjectFeed,
    buildTaskFeed,
    ring,
  };
}

module.exports = {
  createLiveFeedService,
  liveFeedWatchBinding,
  liveStateForTask,
  liveGateKind,
  liveFeedSurface,
  withoutRedundantTerminalNote,
};
