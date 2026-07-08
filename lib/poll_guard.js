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

module.exports = { wrapNonOverlapping };
