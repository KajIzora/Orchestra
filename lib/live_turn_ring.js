'use strict';

/*
 * live_turn_ring.js — bounded per-task ring of normalized LiveTurnEvents (Lane C §5).
 *
 * Structure: Map<taskId, entry> where entry =
 *   {
 *     turn_id,        // increments on every new prompt (per-turn feed)
 *     t0_abs_ms,      // epoch ms of the turn's prompt (t=0); first event seeds it pre-prompt
 *     next_seq,       // next seq to assign — MONOTONIC PER TASK, never reset across turns, so a
 *                     // stale client cursor from a prior turn still yields only newer events
 *     base_seq,       // oldest RETAINED event's seq (advances on FIFO overflow / turn reset)
 *     events,         // bounded FIFO of {seq, t, kind, ...payload}
 *     last_raw_seq,   // hook_event_log global seq high-water mark for the lazy pull
 *     norm_state,     // normalizer scratch (pending gate, agy open steps, meta key) — the
 *                     // NORMALIZER wipes it when a prompt starts a new turn (gates/steps never
 *                     // span prompts); the ring only stores it

 *     touched_ms,     // LRU stamp
 *   }
 *
 * Bounds: maxEventsPerTurn = 300 (FIFO drop-oldest, base_seq advances), LRU cap 50 concurrent
 * task rings (~≤77KB/task worst case, typically <4KB — see the Lane C sizing math).
 *
 * Reset semantics: an appended 'prompt' event bumps turn_id, sets t0, clears events + scratch.
 * The PRIOR turn's trailing events (its stop strip) stay served until that prompt arrives —
 * matching the done→working re-arm model. A client whose `since` predates base_seq (evicted
 * window) gets reset:true + the full retained ring; a turn_id change is the client's other
 * rebuild trigger (the probe treats either as "drop local buffer").
 */

const DEFAULT_MAX_EVENTS_PER_TURN = 300;
const DEFAULT_MAX_TASKS = 50;

function createLiveTurnRing(options = {}) {
  const maxEventsPerTurn =
    Number.isInteger(options.maxEventsPerTurn) && options.maxEventsPerTurn > 0
      ? options.maxEventsPerTurn
      : DEFAULT_MAX_EVENTS_PER_TURN;
  const maxTasks =
    Number.isInteger(options.maxTasks) && options.maxTasks > 0 ? options.maxTasks : DEFAULT_MAX_TASKS;
  const now = typeof options.now === 'function' ? options.now : Date.now;

  /** @type {Map<string, object>} insertion order is refreshed on touch → Map doubles as LRU */
  const byTaskId = new Map();

  function evictLru() {
    while (byTaskId.size > maxTasks) {
      // Oldest-touched entry is the first key (touch() re-inserts).
      const oldest = byTaskId.keys().next().value;
      if (oldest === undefined) break;
      byTaskId.delete(oldest);
    }
  }

  function ensure(taskId) {
    const key = String(taskId || '');
    let entry = byTaskId.get(key);
    if (entry) {
      // LRU touch: re-insert at the back.
      byTaskId.delete(key);
      entry.touched_ms = now();
      byTaskId.set(key, entry);
      return entry;
    }
    entry = {
      turn_id: 0,
      t0_abs_ms: 0,
      next_seq: 1,
      base_seq: 1,
      events: [],
      last_raw_seq: 0,
      norm_state: {},
      touched_ms: now(),
    };
    byTaskId.set(key, entry);
    evictLru();
    return entry;
  }

  function resetTurn(entry, t0AbsMs) {
    entry.turn_id += 1;
    entry.t0_abs_ms = Number.isFinite(t0AbsMs) ? t0AbsMs : now();
    entry.events = [];
    entry.base_seq = entry.next_seq;
    // NOTE: entry.norm_state is deliberately NOT reset here — the normalizer wipes its own
    // scratch when it emits the prompt (it runs BEFORE append, so a ring-side replace would
    // lose the wipe ordering; see wipeScratch in live_turn_normalizer.js).
  }

  /**
   * Append normalized events (each {abs_ms, kind, ...payload}) to a task's ring. A 'prompt'
   * event resets the turn first, then lands as the new turn's first row (t=0). Assigns seq + t.
   * Returns the number of events appended.
   */
  function append(taskId, liveEvents) {
    const list = Array.isArray(liveEvents) ? liveEvents : [];
    if (!list.length) return 0;
    const entry = ensure(taskId);
    let appended = 0;
    for (const raw of list) {
      if (!raw || typeof raw !== 'object' || !raw.kind) continue;
      const absMs = Number.isFinite(raw.abs_ms) ? raw.abs_ms : now();
      if (raw.kind === 'prompt') {
        resetTurn(entry, absMs);
      } else if (!entry.t0_abs_ms) {
        // Pre-prompt events (SessionStart meta): seed t0 so t stays 0-based.
        entry.t0_abs_ms = absMs;
      }
      const { abs_ms, ...payload } = raw;
      void abs_ms;
      const event = {
        seq: entry.next_seq,
        t: Math.max(0, absMs - entry.t0_abs_ms),
        ...payload,
      };
      entry.next_seq += 1;
      entry.events.push(event);
      appended += 1;
      while (entry.events.length > maxEventsPerTurn) {
        entry.events.shift();
      }
      entry.base_seq = entry.events.length ? entry.events[0].seq : entry.next_seq;
    }
    return appended;
  }

  /**
   * Delta snapshot for one task. `sinceSeq` = the client's last head_seq (omit/null for first
   * call → full retained ring, reset:false). reset:true when the cursor predates the retained
   * window (events were evicted past it) — the client must rebuild from the returned events.
   */
  function snapshot(taskId, sinceSeq) {
    const entry = ensure(taskId);
    const headSeq = entry.next_seq - 1;
    const baseSeq = entry.events.length ? entry.events[0].seq : entry.next_seq;
    const since = Number.isFinite(sinceSeq) ? Number(sinceSeq) : null;
    let reset = false;
    let events;
    if (since == null) {
      events = entry.events.slice();
    } else if (since + 1 < baseSeq && headSeq >= baseSeq) {
      // The client missed evicted events (or the turn rolled past its cursor): full rebuild.
      reset = true;
      events = entry.events.slice();
    } else {
      events = entry.events.filter((ev) => ev.seq > since);
    }
    return {
      turn_id: entry.turn_id,
      base_seq: baseSeq,
      head_seq: headSeq,
      reset,
      events,
      t0_abs_ms: entry.t0_abs_ms,
    };
  }

  function drop(taskId) {
    byTaskId.delete(String(taskId || ''));
  }

  return {
    ensure,
    append,
    snapshot,
    drop,
    size: () => byTaskId.size,
    _byTaskId: byTaskId, // exposed for tests only
  };
}

module.exports = {
  createLiveTurnRing,
  DEFAULT_MAX_EVENTS_PER_TURN,
  DEFAULT_MAX_TASKS,
};
