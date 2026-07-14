'use strict';

/*
 * orchestra_live_poller — opt-in LIVE Orchestra watch-state feed for signal-monitor.
 *
 * The graded Orchestra-state lane is a REPLAY-time reconstruction (lib/signal_replay.js), so it only
 * exists once a run finishes and writes its recording. To let signal-monitor show Orchestra's state
 * DURING a run, this poller hits the dev server's `/api/state` on an interval, finds the watched task
 * by the run's match id, classifies its current watch state, and appends a line to `orchestra-live.jsonl`
 * whenever the state changes. signal-monitor tails that file into the Agent tab's blue lane.
 *
 * It is OFF by default and only started when a session script opts in (env SIGNAL_LIVE_ORCHESTRA=1).
 * It is read-only against Orchestra and best-effort — any failure is swallowed; the finalize replay is
 * still the canonical, graded Orchestra lane. The live lane reflects the REAL dev Orchestra (production
 * logic running on the dev server), which is what you want for live monitoring.
 *
 * The state mapping (taskLiveState) mirrors the watch fields lib/signal_replay.js reads
 * (watch_tracking / paused_watch_tracking / watch_finished); confirm it against a live run.
 */

const fs = require('fs');

// Pure: classify a task's CURRENT watch state from the /api/state task shape. Returns one of:
//   { phase: 'active' }                      — watch bound and running (generating/working)
//   { phase: 'needs_input', gate }           — paused at a permission/question gate
//   { phase: 'done' }                        — watch finished, no needs-input
//   { phase: 'gone' }                        — no active watch and not finished (cancelled / pre-start)
//   null                                     — no task
// Mirrors the watch predicates in lib/signal_replay.js (~:373-384).
function taskLiveState(task) {
  if (!task) return null;
  const wf = task.watch_finished;
  if (wf) {
    if (wf.needs_input) {
      // Prefer the KIND Orchestra actually reported (watch_finished.gate_kind) when it is a concrete
      // permission/question; fall back to the reconstructed clear_gate for older served state and for
      // 'unknown'/absent (keeps the monitor byte-identical where the kind isn't reported).
      const reported = wf.gate_kind === 'permission' || wf.gate_kind === 'question' ? wf.gate_kind : '';
      const gate = reported
        || (task.last_watch_clear && task.last_watch_clear.gate)
        || (task.paused_watch_tracking && task.paused_watch_tracking.clear_gate)
        || 'permission';
      return { phase: 'needs_input', gate };
    }
    return { phase: 'done' };
  }
  if (task.watch_tracking == null) return { phase: 'gone' };
  const paused = task.paused_watch_tracking;
  if (paused) return { phase: 'needs_input', gate: paused.clear_gate || 'permission' };
  return { phase: 'active' };
}

// Pure: find the watched task in an /api/state payload by the run's match id(s). The match id is
// stamped into the watch binding / task title by the session script, so a substring scan over the
// task's watch fields + identity is a robust loose match without coupling to the exact binding schema.
// `matchId` may be a single id or an array of candidate ids (e.g. [runId, testCode]) — a task matches
// if ANY non-empty candidate is found, which makes the per-platform wiring robust without each one
// needing to know the exact identifier Orchestra ends up storing.
function findTaskByMatch(state, matchId) {
  const ids = (Array.isArray(matchId) ? matchId : [matchId]).filter((s) => s && String(s).length);
  if (!state || !ids.length) return null;
  for (const project of (state.projects || [])) {
    for (const task of (project.tasks || [])) {
      const hay = JSON.stringify([
        task.watch_tracking, task.paused_watch_tracking, task.watch_finished,
        // completed_watch_tracking retains the full binding (incl. browser-chat conversation_id) after a
        // watch finishes — without it the match is lost exactly at DONE (watch_finished drops the id), so
        // the blue lane would show working but never the done flip.
        task.completed_watch_tracking,
        // task.text is the board task's actual text (title is the watcher-set display name, usually
        // empty on hand-created tasks) — without it a task titled with the run id never matches
        // (V1 2026-07-12: cursor binder tasks bound only when tracking.last_user_preview happened
        // to carry the prompt; claude/codex matched through that accident, cursor served 0 rows).
        task.text,
        task.title, task.id, task.run_id, task.match_id,
      ]);
      if (hay && ids.some((id) => hay.includes(String(id)))) return task;
    }
  }
  return null;
}

// Translate the pure phase classification into the Orchestra state names signal-monitor renders
// (generating / working / needs_input / done / cancelled), using a tiny bit of history (first active
// is "generating"/picker-populated; an active after a gate is a "working" resume; a watch that
// disappears mid-run without finishing is "cancelled"). Returns {state, gate} or null (no change).
function classifyForEmit(cls, hist) {
  if (!cls) return null;
  if (cls.phase === 'active') {
    if (!hist.started) { hist.started = true; return { state: 'generating', gate: '' }; }
    return { state: hist.sawGate ? 'working' : 'generating', gate: '' };
  }
  if (cls.phase === 'needs_input') { hist.started = true; hist.sawGate = true; return { state: 'needs_input', gate: cls.gate || 'permission' }; }
  if (cls.phase === 'done') { hist.done = true; return { state: 'done', gate: '' }; }
  if (cls.phase === 'gone') {
    if (hist.started && !hist.done) { hist.done = true; return { state: 'cancelled', gate: '' }; }
    return null;
  }
  return null;
}

// Start the poller. Returns { stop() }. Off-path failures are swallowed (best-effort).
//   apiBase   — Orchestra dev server base (e.g. http://127.0.0.1:47823)
//   matchId   — the run's match id(s): a string, an array of candidate ids, or a function returning
//               either (re-evaluated each tick for ids learned mid-run, e.g. browser-chat's conversation_id)
//   outPath   — orchestra-live.jsonl path in the scenario dir
//   pollMs    — poll interval (default 700ms, matches the snapshot cadence)
//   fetchImpl — injectable fetch (tests); defaults to global fetch
//   now       — injectable clock (tests)
function startOrchestraLivePoller({ apiBase, matchId, outPath, pollMs = 700, fetchImpl, now = () => Date.now() } = {}) {
  const fetchFn = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!apiBase || !matchId || !outPath || !fetchFn) return { stop() {} };
  let stopped = false;
  let timer = null;
  let last = null; // last emitted {state, gate}
  const hist = { started: false, sawGate: false, done: false };
  let stream = null;
  try { stream = fs.createWriteStream(outPath, { flags: 'w' }); stream.on('error', () => { stream = null; }); } catch { stream = null; }

  const emit = (state, gate) => {
    if (last && last.state === state && last.gate === (gate || '')) return; // collapse repeats
    last = { state, gate: gate || '' };
    try { if (stream) stream.write(`${JSON.stringify({ t_ms: now(), state, gate: gate || '' })}\n`); } catch { /* best-effort */ }
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const res = await fetchFn(`${apiBase}/api/state`);
      const data = await res.json();
      // matchId may be a function so a caller can supply ids learned mid-run (browser-chat resolves
      // its watch conversation_id only once the chat starts streaming).
      const mid = typeof matchId === 'function' ? matchId() : matchId;
      const out = classifyForEmit(taskLiveState(findTaskByMatch(data, mid)), hist);
      if (out) emit(out.state, out.gate);
    } catch { /* dev server transient — retry next tick */ }
  };

  timer = setInterval(tick, pollMs);
  tick();
  return {
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      try { if (stream) stream.end(); } catch { /* ignore */ }
    },
  };
}

// Default-ON wrapper. The live Orchestra feed runs by default; set SIGNAL_LIVE_ORCHESTRA=0 to opt out
// (e.g. when not pointed at a live dev server). Returns a no-op handle when disabled or under-specified,
// so call sites can always `?.stop()` unconditionally. This is the single place the on/off policy lives.
function maybeStartOrchestraLivePoller(opts = {}) {
  if (process.env.SIGNAL_LIVE_ORCHESTRA === '0') return { stop() {} };
  return startOrchestraLivePoller(opts);
}

/*
 * ---------------------------------------------------------------------------
 * LIVE SERVED-ROW LANE (live-feed campaign A3)
 * ---------------------------------------------------------------------------
 *
 * A second, independent poller that records what the REAL live-feed endpoint
 * (GET /api/projects/:id/live-feed, server.js ~:2652) actually SERVES for the run's linked task,
 * into the run's recording — the serving-path evidence the offline layer cannot produce (Phase-3
 * precedent: the normalizer was fine but the service served empty for browser_chat).
 *
 * Lifecycle: started by recorder.enableLiveFlush alongside the blue lane whenever the session's
 * orchestra opts carry { apiBase, matchId } (every session passes both today), and stopped with it.
 * It is deliberately a SEPARATE timer + failure domain from the blue lane: it works with EITHER
 * blue-lane driver (partial replay or the /api/state poller above), and no failure here can
 * disturb them.
 *
 * Binding: REUSES findTaskByMatch — the exact match-id mechanism the blue lane uses to find the
 * run's watched task in /api/state (loose substring scan over watch_tracking /
 * paused_watch_tracking / watch_finished / completed_watch_tracking / title / id / run_id /
 * match_id; matchId may be a string, array, or function). It is applied per-project so the lane
 * also learns the PROJECT id the live-feed route needs. Bound once; the row itself only appears
 * once the watch links (buildTaskFeed returns null for an untracked task), so pre-link polls
 * simply record nothing.
 *
 * Cursoring: first live-feed poll sends no `since` (full retained ring); afterwards
 * `since={taskId: <last head_seq>}`. Events are deduped by a max-seq watermark (ring seqs are
 * monotonic per task, never reset across turns), so a `reset:true` re-serve stores only events
 * not already recorded. If head_seq ever REGRESSES below the cursor (the server ring was
 * LRU-evicted and recreated — a fresh seq space), the watermark resets, everything served is
 * accepted, and the emitted row is flagged `rebased`.
 *
 * Emit policy (bounded): a `{type:'live_feed_row'}` recorder event is appended only when the
 * served row CHANGED (state / gate_kind / tier / surface / provider / lifecycle.stop_text) or
 * carried new/reset events — steady-state delta polls record nothing. `new_events` per emitted
 * row is capped (drop-oldest, mirroring the ring's own FIFO; `new_events_dropped` counts them,
 * and the service's own caps — 300 events/turn, clamped text — bound each poll upstream). After
 * `maxRows` emitted rows only CHANGED rows still land, so state transitions are never lost to
 * the cap.
 *
 * Failure tolerance: a 404 (endpoint absent / project gone) disables ONLY this lane, logging
 * once; other HTTP errors log once and keep retrying; network/parse errors retry silently. The
 * blue lane and the recording are never disturbed.
 */

const LIVE_FEED_MAX_EVENTS_PER_POLL = 120;
const LIVE_FEED_MAX_ROWS = 1500;

// Start the served-row lane. Returns { stop() }. Under-specified opts → inert no-op handle.
//   apiBase          — Orchestra dev server base (e.g. http://127.0.0.1:47823)
//   matchId          — the run's match id(s); same contract as startOrchestraLivePoller
//   append           — recorder event sink (event) => void (recorder.append; sets t_ms if absent)
//   pollMs           — poll interval (default 700ms, the blue-lane cadence)
//   maxEventsPerPoll — cap on new_events stored per emitted row (default 120)
//   maxRows          — soft cap on emitted rows; past it only changed rows land (default 1500)
//   fetchImpl / now / log — injectable for tests
function startLiveFeedPoller({
  apiBase, matchId, append, pollMs = 700, fetchImpl, now = () => Date.now(),
  maxEventsPerPoll = LIVE_FEED_MAX_EVENTS_PER_POLL, maxRows = LIVE_FEED_MAX_ROWS, log,
} = {}) {
  const fetchFn = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!apiBase || !matchId || typeof append !== 'function' || !fetchFn) return { stop() {} };
  let stopped = false;
  let disabled = false; // 404 → this lane off for good (endpoint absent); blue lane unaffected
  let running = false; // single-flight: overlapping ticks would race the cursor ordering
  let bound = null; // { projectId, taskId } once findTaskByMatch locates the run's task
  let cursor = null; // last served head_seq (the ?since value)
  let maxSeqSeen = -Infinity; // dedupe watermark over served event seqs
  let last = null; // last emitted row signature { sig, stopText }
  let emitted = 0;
  let warned = false;
  const logFn = typeof log === 'function' ? log : (msg) => { try { console.error(msg); } catch { /* best-effort */ } };
  const warnOnce = (msg) => { if (!warned) { warned = true; try { logFn(`[live-feed-lane] ${msg}`); } catch { /* best-effort */ } } };

  // Same binding mechanism as the blue lane (findTaskByMatch), applied per-project so the
  // live-feed route's project id is learned along with the task id.
  const bind = async () => {
    const res = await fetchFn(`${apiBase}/api/state`);
    const data = await res.json();
    const mid = typeof matchId === 'function' ? matchId() : matchId;
    for (const project of (data && data.projects) || []) {
      const task = findTaskByMatch({ projects: [project] }, mid);
      if (task && task.id != null && project && project.id != null) {
        bound = { projectId: String(project.id), taskId: String(task.id) };
        return;
      }
    }
  };

  const pollFeed = async () => {
    const since = cursor == null ? '' : `&since=${encodeURIComponent(JSON.stringify({ [bound.taskId]: cursor }))}`;
    const url = `${apiBase}/api/projects/${encodeURIComponent(bound.projectId)}/live-feed`
      + `?tasks=${encodeURIComponent(bound.taskId)}${since}`;
    const res = await fetchFn(url);
    const status = res && typeof res.status === 'number' ? res.status : 200;
    if (status === 404) {
      disabled = true;
      warnOnce(`live-feed endpoint 404 for project ${bound.projectId} — served-row lane off (blue lane unaffected)`);
      return;
    }
    if (status >= 400) {
      warnOnce(`live-feed endpoint HTTP ${status} — retrying each tick (blue lane unaffected)`);
      return;
    }
    const data = await res.json();
    const row = ((data && Array.isArray(data.tasks) && data.tasks) || [])
      .find((t) => t && String(t.task_id) === bound.taskId);
    if (!row) return; // watch not linked yet / row degraded away — keep polling

    const served = Array.isArray(row.events) ? row.events : [];
    let rebased = false;
    if (Number.isFinite(row.head_seq) && cursor != null && row.head_seq < cursor) {
      // Server ring recreated (LRU eviction): a fresh seq space — accept everything served.
      rebased = true;
      maxSeqSeen = -Infinity;
    }
    const fresh = served.filter((ev) => ev && Number.isFinite(ev.seq) && ev.seq > maxSeqSeen);
    for (const ev of fresh) { if (ev.seq > maxSeqSeen) maxSeqSeen = ev.seq; }
    if (Number.isFinite(row.head_seq)) cursor = row.head_seq;

    const sig = [row.state, row.gate_kind || '', row.tier, row.surface || '', row.provider || ''].join('|');
    const stopText = row.lifecycle && typeof row.lifecycle.stop_text === 'string' ? row.lifecycle.stop_text : '';
    const changed = !last || last.sig !== sig || last.stopText !== stopText;
    if (!changed && !fresh.length && !row.reset && !rebased) return; // steady-state: nothing new
    if (!changed && emitted >= maxRows) return; // row cap: transitions always land, event churn stops
    last = { sig, stopText };

    let newEvents = fresh;
    let dropped = 0;
    if (newEvents.length > maxEventsPerPoll) {
      dropped = newEvents.length - maxEventsPerPoll;
      newEvents = newEvents.slice(-maxEventsPerPoll); // drop-oldest, like the ring's own FIFO
    }
    if (stopped) return; // teardown raced the fetch — never append after stop
    emitted += 1;
    append({
      type: 'live_feed_row',
      t_ms: now(),
      row: {
        task_id: row.task_id,
        session_key: row.session_key || '',
        provider: row.provider || '',
        surface: row.surface || '',
        tier: row.tier,
        state: row.state,
        gate_kind: row.gate_kind ?? null,
        turn_id: row.turn_id,
        base_seq: row.base_seq,
        head_seq: row.head_seq,
        reset: !!row.reset,
        lifecycle: row.lifecycle && typeof row.lifecycle === 'object' ? row.lifecycle : {},
      },
      new_events: newEvents,
      ...(dropped ? { new_events_dropped: dropped } : {}),
      ...(rebased ? { rebased: true } : {}),
    });
  };

  const tick = async () => {
    if (stopped || disabled || running) return; // single-flight keeps since-cursoring ordered
    running = true;
    try {
      if (!bound) await bind();
      if (bound && !stopped && !disabled) await pollFeed();
    } catch { /* transient (network/parse/dev-server restart) — retry next tick */ }
    running = false;
  };

  const timer = setInterval(tick, pollMs);
  tick();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

// Default-ON wrapper for the served-row lane (mirrors maybeStartOrchestraLivePoller). Disabled by
// SIGNAL_LIVE_FEED=0 (this lane alone) or SIGNAL_LIVE_ORCHESTRA=0 (all live Orchestra feeds — the
// existing "not pointed at a live dev server" switch). Single home of the on/off policy.
function maybeStartLiveFeedPoller(opts = {}) {
  if (process.env.SIGNAL_LIVE_ORCHESTRA === '0' || process.env.SIGNAL_LIVE_FEED === '0') return { stop() {} };
  return startLiveFeedPoller(opts);
}

module.exports = {
  taskLiveState, findTaskByMatch, classifyForEmit, startOrchestraLivePoller, maybeStartOrchestraLivePoller,
  startLiveFeedPoller, maybeStartLiveFeedPoller,
  LIVE_FEED_MAX_EVENTS_PER_POLL, LIVE_FEED_MAX_ROWS,
};
