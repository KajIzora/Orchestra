'use strict';

/**
 * Bounded, TTL'd in-memory log of raw hook POST bodies — the lossless "raw-hook tap".
 *
 * The hook stores collapse to the latest event per session, which is lossy for replay.
 * This log keeps the exact `/api/<provider>-hooks/event` bodies (with server-side
 * timestamps) for a short window so a recording session can capture them verbatim and
 * re-ingest them into a real hook store during replay. Bounded + TTL'd, never persisted
 * by the server; the recorder sanitizes before writing to the bank.
 *
 * The cap is enforced **per provider**, not globally. A single global cap let a flood
 * from one provider (e.g. a hook-rich agy-cli/gemini wave run with many parallel
 * scenarios) evict every other provider's events — and even evict a provider's own
 * earlier events before its recorder's next poll, producing empty recordings. A
 * per-provider cap keeps each provider's recent window intact independently.
 */

// Per-provider cap. Generous: raw hook bodies are small, and a single `harness_wave
// all --no-max` run for a hook-rich provider can emit a few thousand events. The window
// only needs to outlast the recorder's poll interval (500ms), so headroom is cheap
// insurance against losing events under a parallel flood.
const DEFAULT_MAX = 5000;
const DEFAULT_TTL_MS = 60 * 60 * 1000;

function createHookEventLog(options = {}) {
  const max = Number.isInteger(options.max) && options.max > 0 ? options.max : DEFAULT_MAX;
  const ttlMs = Number.isInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
  let seq = 0;
  /** @type {Array<{provider:string, seq:number, t_iso:string, t_ms:number, body:object}>} */
  const events = [];

  function prune(nowMs = Date.now()) {
    // Drop expired entries first (oldest are at the front of the array).
    while (events.length && nowMs - events[0].t_ms > ttlMs) events.shift();
    // Then enforce the cap per provider: walk newest -> oldest, keeping the most recent
    // `max` of each provider and dropping older ones. This way a burst from one provider
    // never starves another's window.
    const counts = new Map();
    for (let i = events.length - 1; i >= 0; i--) {
      const provider = events[i].provider;
      const kept = (counts.get(provider) || 0) + 1;
      counts.set(provider, kept);
      if (kept > max) events.splice(i, 1);
    }
  }

  function push(provider, body) {
    const now = Date.now();
    seq += 1;
    events.push({ provider: String(provider || ''), seq, t_iso: new Date(now).toISOString(), t_ms: now, body: body || {} });
    prune(now);
    return seq;
  }

  function since(provider, sinceIso) {
    prune();
    const sinceMs = Date.parse(sinceIso || '') || 0;
    return events
      .filter((e) => e.provider === provider && (!sinceMs || e.t_ms > sinceMs))
      .map((e) => ({ seq: e.seq, t_iso: e.t_iso, t_ms: e.t_ms, body: e.body }));
  }

  return { push, since, prune, size: () => events.length };
}

module.exports = { createHookEventLog, DEFAULT_MAX, DEFAULT_TTL_MS };
