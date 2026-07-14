'use strict';

/*
 * Non-overlapping poll wrapper.
 *
 * The 2026-07 ssh round's "herd" blocker: server.js ran pollRemoteHookLogs() on a bare
 * setInterval(1000) with no re-entrancy guard. When remote reads got slow (ssh contention, big
 * logs), a pass took 10–25s but a NEW pass still started every second — 10–25 overlapping passes,
 * each holding ssh channels, saturating the shared ControlMaster past the remote's MaxSessions and
 * never draining (the stable app measured 26–64 sustained ssh connections with zero harness load).
 *
 * wrapNonOverlapping() converts that overload into "polling slows down": if the previous pass is
 * still in flight, the tick is SKIPPED (returns null). Same pattern as createWatchPoller's
 * tickInFlight guard (lib/watch_tracker.js), factored out so interval-driven pollers can share it.
 */

/**
 * Wrap an async function so concurrent invocations are skipped instead of stacked.
 * A skipped invocation resolves to null. Errors propagate and release the guard.
 *
 * @param {Function} fn - async function to guard
 * @returns {Function} guarded wrapper; `wrapper.isInFlight()` exposes the guard state for tests
 */
function wrapNonOverlapping(fn) {
  let inFlight = false;
  async function guarded(...args) {
    if (inFlight) return null;
    inFlight = true;
    try {
      return await fn.apply(this, args);
    } finally {
      inFlight = false;
    }
  }
  guarded.isInFlight = () => inFlight;
  return guarded;
}

/**
 * Wrap an async function so rapid repeat calls share one result instead of re-running it.
 * Built for the picker discovery scans (in-flight generation fix): the run pickers poll ~700ms
 * while open, but a disk-scan result a second stale is fine — so the first call starts the scan
 * and callers within ttlMs of it SETTLING get the same promise back. While the scan is still in
 * flight every caller shares it regardless of ttl (non-overlapping, like wrapNonOverlapping, but
 * sharing the pending result instead of returning null). A rejected run is not memoized: the
 * next call after it settles starts a fresh one.
 *
 * Callers within the ttl window get the memoized result whatever arguments they pass — intended
 * for zero-argument scans.
 *
 * @param {Function} fn - async function to memoize
 * @param {number} ttlMs - how long a settled result keeps being served
 * @returns {Function} memoized wrapper; `wrapper.clear()` drops the memo (for tests)
 */
function wrapShortTtlMemo(fn, ttlMs) {
  let entry = null; // { promise, settledAtMs (0 while in flight), failed }
  function memoized(...args) {
    const nowMs = Date.now();
    if (entry && !entry.failed && (!entry.settledAtMs || nowMs - entry.settledAtMs < ttlMs)) {
      return entry.promise;
    }
    const next = { promise: null, settledAtMs: 0, failed: false };
    next.promise = (async () => fn.apply(this, args))().then(
      (value) => {
        next.settledAtMs = Date.now();
        return value;
      },
      (err) => {
        next.settledAtMs = Date.now();
        next.failed = true;
        throw err;
      }
    );
    entry = next;
    return next.promise;
  }
  memoized.clear = () => {
    entry = null;
  };
  return memoized;
}

module.exports = { wrapNonOverlapping, wrapShortTtlMemo };
