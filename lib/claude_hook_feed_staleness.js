'use strict';

/*
 * Hook-feed staleness probe for remote (source:'ssh') claude watches.
 *
 * Claude has NO on-disk hook-log fallback on the remote host: every hook rides the reverse tunnel,
 * and a dropped tunnel (it auto-restarts once, then stays down) silently stops ALL claude hooks
 * while the agent keeps working. The transcript ssh-read backstop only carries done/cancel/
 * generating — permission gates, the sub-agent HELD hold, and cron re-arms are hook-only, so a
 * tunnel drop turns into a silently-wrong board (stuck working / held forever / never re-arms).
 *
 * This probe converts that silent failure into an operator-visible flag: a remote watch whose
 * hooks have been silent for `staleAfterMs` WHILE the remote transcript keeps advancing gets
 * `hook_feed_stale: true` stamped on its watch_tracking (surfacing only — never a state change).
 * Hook silence alone is NOT enough (a long hook-quiet turn is legitimate); the transcript-advance
 * corroboration is what the registry's candidate-fix notes call for on both the cursor wedge and
 * the claude tunnel-drop modes.
 *
 * Cost: zero extra ssh work until a watch has been hook-silent past `staleAfterMs`; then one
 * throttled remote `stat` per `statThrottleMs` per watch. Failures are swallowed (a broken ssh
 * transport must not break the poll tick — and an unreachable host makes the transcript check
 * moot anyway).
 */

const DEFAULT_STALE_AFTER_MS = 60_000;
const DEFAULT_STAT_THROTTLE_MS = 15_000;
// The transcript must have advanced meaningfully past the last hook to corroborate (guards the
// race where the final Stop's own transcript flush lands a moment after the hook).
const DEFAULT_ADVANCE_SLACK_MS = 5_000;

function parseMs(value) {
  const ms = Date.parse(String(value || '')) || 0;
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * @param {object} options
 * @param {(wt: object) => object|null} options.getHookActivityHintForTracking - host-matched
 *   latest-hook accessor (claude hook store instance method).
 * @param {(wt: object) => Promise<number>} options.statRemoteTranscriptMtimeMs - resolves the
 *   remote transcript's mtime in ms (0/NaN = unknown). Injected so tests never need real ssh.
 * @param {() => number} [options.now]
 */
function createClaudeHookFeedStalenessProbe(options = {}) {
  const getHint = options.getHookActivityHintForTracking;
  const statRemote = options.statRemoteTranscriptMtimeMs;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const staleAfterMs = Number.isFinite(options.staleAfterMs) ? options.staleAfterMs : DEFAULT_STALE_AFTER_MS;
  const statThrottleMs = Number.isFinite(options.statThrottleMs)
    ? options.statThrottleMs
    : DEFAULT_STAT_THROTTLE_MS;
  const advanceSlackMs = Number.isFinite(options.advanceSlackMs)
    ? options.advanceSlackMs
    : DEFAULT_ADVANCE_SLACK_MS;
  // watch key -> { checked_at_ms, mtime_ms } (throttle memory; bounded by active-watch count)
  const statCache = new Map();

  function lastHookMsFor(wt) {
    let best = 0;
    try {
      const hint = typeof getHint === 'function' ? getHint(wt) : null;
      if (hint) best = Math.max(best, parseMs(hint.updated_at || hint.last_activity_at));
    } catch {
      // Accessor failure = no hook recency info; fall through to the tracking fields.
    }
    best = Math.max(best, parseMs(wt.completion_hint_at), parseMs(wt.linked_at));
    return best;
  }

  /**
   * Evaluate and STAMP staleness onto the watch tracking. Never throws, never transitions state.
   * Returns the stamped verdict for tests/telemetry.
   */
  async function evaluateAndStamp(wt) {
    if (!wt || wt.source !== 'ssh' || wt.provider !== 'claude') return { stale: false, reason: 'not_applicable' };
    const nowMs = now();
    const lastHookMs = lastHookMsFor(wt);
    const silentMs = lastHookMs ? nowMs - lastHookMs : 0;
    if (!lastHookMs || silentMs < staleAfterMs) {
      if (wt.hook_feed_stale) {
        wt.hook_feed_stale = false;
        wt.hook_feed_stale_at = null;
      }
      return { stale: false, reason: 'hooks_fresh', silent_ms: silentMs };
    }
    const key = wt.transcript_path || wt.session_id || '';
    if (!key || typeof statRemote !== 'function') return { stale: !!wt.hook_feed_stale, reason: 'no_transcript_probe' };
    let entry = statCache.get(key);
    if (!entry || nowMs - entry.checked_at_ms >= statThrottleMs) {
      let mtime = 0;
      try {
        mtime = Number(await statRemote(wt)) || 0;
      } catch {
        mtime = 0;
      }
      entry = { checked_at_ms: nowMs, mtime_ms: mtime };
      statCache.set(key, entry);
    }
    const advancing = entry.mtime_ms > lastHookMs + advanceSlackMs;
    if (advancing && !wt.hook_feed_stale) {
      wt.hook_feed_stale = true;
      wt.hook_feed_stale_at = new Date(nowMs).toISOString();
      wt.hook_feed_last_hook_at = new Date(lastHookMs).toISOString();
    } else if (!advancing && wt.hook_feed_stale) {
      // Transcript stopped advancing too — could be a finished quiet turn; drop the flag rather
      // than hold a stale warning forever.
      wt.hook_feed_stale = false;
      wt.hook_feed_stale_at = null;
    }
    return {
      stale: !!wt.hook_feed_stale,
      reason: advancing ? 'hook_silent_transcript_advancing' : 'hook_silent_transcript_static',
      silent_ms: silentMs,
      transcript_mtime_ms: entry.mtime_ms,
    };
  }

  return { evaluateAndStamp, _statCache: statCache };
}

module.exports = {
  createClaudeHookFeedStalenessProbe,
  DEFAULT_STALE_AFTER_MS,
  DEFAULT_STAT_THROTTLE_MS,
};
