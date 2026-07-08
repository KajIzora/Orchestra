// Agy (Antigravity) CLI idle-completion fallback.
//
// NOTE: file/function names mention "transcript" for historical reasons, but the
// discriminator is hook-activity quiescence, not transcript shape. The transcript parsing
// approach was unreliable (it keyed off the last record being a terminal PLANNER_RESPONSE).
//
// The agy CLI emits a Stop hook on every stop — including mid-turn partial stops — and often
// does NOT emit a clean fullyIdle:true terminal Stop at the true end (the agent, or one of its
// sub-agents, just goes quiet, or ends mid tool-call). So "done" can't be read off a single Stop.
//
// The reliable signal is CASCADE-WIDE QUIESCENCE: once the parent has ended at least one turn
// (a NO_TOOL_CALL partial Stop anchors "this isn't the first generation"), the run is done when
// the WHOLE tree — the parent AND every sub-agent it spawned — has produced no hook activity for
// a quiet window, and nothing is paused (question/permission) or waiting on a backgrounded tool.
// Watching the whole tree (not just the parent) is what distinguishes "parent done" from "parent
// waiting on a sub-agent", and measuring quiet from the LAST activity anywhere in the tree (rather
// than blocking forever on any resume) is what handles a final turn that never emits a clean Stop.

// Quiet window after a partial Stop before we treat the foreground turn as done.
// Must clear observed resume latency (sub-second to a couple seconds) with margin, while
// staying well under the old 15s fallback. Tunable; callers may override via quiescenceMs.
const DEFAULT_QUIESCENCE_MS = 6_000;

// Safety cap on how long an in-flight tool call (or a persistent blocking DB step) may defer the
// clear. While the agent's most recent tool call is still running (e.g. a blocking `sleep`/build/
// test that backgrounded after waitMsBeforeAsync, or a supervised server it left running) we keep
// the watch up — the agent is presumed waiting on it and will resume when it returns. This cap
// bounds the case where the agent ended its turn leaving a never-returning background process with
// no follow-up: after this long we stop deferring and let the normal quiet window clear the watch.
//
// 5min since 2026-07-08 (was 30min, 2026-07-06). Backtest over the full agy-cli bank+lab archive
// (121 recordings with the DB step-status channel; 94 with legitimate frozen status-2 windows):
// the longest LEGITIMATE in-flight freeze — a real foreground tool the agent was genuinely
// waiting on — was 4.0min (all multi-minute freezes were the `custom` long-build family; p99=50s,
// every non-custom scenario < 47s). A 5min cap false-cleared 0/94 legit runs while cutting the
// abandoned-server over-hold from 30min → 5min (6× faster).
//
// TRADE-OFF (accepted, maintainer decision 2026-07-08): unlike claude, agy exposes NO stated-intent
// channel (no TodoWrite equivalent) and NO per-instant discriminator between "long foreground tool"
// and "done but left a server running" — the two are structurally identical at the Stop (same
// fullyIdle:false NO_TOOL_CALL Stop, same frozen blocking status-2, no task list on the Stop;
// agy-cli findings §8.1, the eternal-task-vs-waiter wall). So this is a FLAT timeout, not a tier.
// The cost is that a foreground tool running LONGER than the cap clears to done at the cap and then
// RE-ARMS to working when the tool finishes and the agent resumes — a recoverable done→working
// flicker (done_detection: "warned, never a failure"), premature-done in exchange for abandoned
// servers clearing 6× sooner. The archive's own worst legit freeze (4.0min) sits under the cap with
// ~1min margin; a genuinely long build/test/deep-research run as a foreground tool (>5min) is the
// case that will flicker. Env-tunable via AGY_INFLIGHT_MAX_MS to re-tune against production data.
const DEFAULT_INFLIGHT_MAX_MS = (() => {
  const env = Number(process.env.AGY_INFLIGHT_MAX_MS);
  return Number.isFinite(env) && env > 0 ? env : 5 * 60_000;
})();

// How long to keep a sub-agent that is mid-tool (in-flight tool call, producing no hooks) counted
// as "busy" before treating it as settled. Must exceed the longest in-flight tool gap that will
// still resume (foreground tools background + schedule a wakeup beyond this), so a sub-agent's
// silent tool gap doesn't read as the run's end — while a sub-agent that ended mid-tool with no
// final Stop still settles after the grace. Tunable.
const DEFAULT_TREE_INFLIGHT_GRACE_MS = 15_000;

/**
 * Cascade-wide quiescence completion for the agy CLI. Returns a completion hint only when:
 *   (a) the parent has emitted a NO_TOOL_CALL partial Stop (partialStopAtMs) — it ended at least
 *       one turn, so we are not mid first-generation;
 *   (b) nothing in the tree is paused on a question/permission prompt;
 *   (c) the parent is not waiting on its own backgrounded tool call (inflight, bounded by cap);
 *   (d) the WHOLE cascade has been quiet for the quiet window — i.e. now is at least quiescenceMs
 *       past the latest of: the parent's partial Stop, any scheduled wakeup, and the last hook
 *       activity anywhere in the tree (treeLastActivityMs, which the caller maxes across the
 *       parent + every sub-agent).
 *
 * Unlike the old rule, ANY activity after the partial Stop does NOT block forever — it just
 * pushes out the quiet window (the run clears once the whole tree finally goes quiet). That is
 * what lets a final turn with no clean Stop (parent or sub-agent) still complete.
 *
 * @param {object} options
 * @param {number} options.partialStopAtMs  ms timestamp of the parent's NO_TOOL_CALL partial Stop (required)
 * @param {number} [options.treeLastActivityMs] ms of the most recent hook activity anywhere in the cascade
 * @param {number} [options.scheduledWakeupAtMs] ms timestamp the agent (or a sub-agent) scheduled to resume by
 * @param {boolean} [options.inflightToolCall] the parent's latest tool call has not returned yet
 * @param {number} [options.inflightSinceMs] ms timestamp the in-flight tool call started
 * @param {boolean} [options.questionPending] a question prompt is pending anywhere in the tree
 * @param {boolean} [options.permissionPending] a permission prompt is pending anywhere in the tree
 * @param {number} [options.nowMs]
 * @param {number} [options.quiescenceMs]
 * @param {number} [options.inflightMaxMs]
 */
function evaluateAgyTranscriptIdleCompletion(options = {}) {
  const {
    partialStopAtMs,
    treeLastActivityMs = 0,
    scheduledWakeupAtMs = 0,
    inflightToolCall = false,
    inflightSinceMs = 0,
    questionPending = false,
    permissionPending = false,
    nowMs = Date.now(),
    quiescenceMs = DEFAULT_QUIESCENCE_MS,
    inflightMaxMs = DEFAULT_INFLIGHT_MAX_MS,
  } = options;

  if (!partialStopAtMs) return null;
  if (questionPending || permissionPending) return null;

  // The agent's most recent tool call has not returned yet (e.g. it ran a blocking
  // `sleep`/build/test that backgrounded after waitMsBeforeAsync). The agent is waiting on it,
  // not done — defer the clear while it runs. Bounded by inflightMaxMs so a never-returning
  // final-action process can't hang the watch forever.
  if (inflightToolCall) {
    const inflightFor = inflightSinceMs ? nowMs - inflightSinceMs : 0;
    if (!inflightSinceMs || inflightFor < inflightMaxMs) return null;
  }

  // The quiet window starts at the latest of: the parent's partial Stop, a scheduled wakeup (the
  // agent intends to resume), or the last hook activity anywhere in the cascade. Measuring from
  // the whole tree's last activity is what makes "parent quiet but sub-agent still working" not
  // count as done, and what lets a resumed-then-quiet final turn clear once everything settles.
  const lastExpectedMs = Math.max(partialStopAtMs, scheduledWakeupAtMs, treeLastActivityMs || 0);

  if (nowMs - lastExpectedMs < quiescenceMs) return null;

  const stopAtIso = new Date(partialStopAtMs).toISOString();
  return {
    updated_at: new Date(nowMs).toISOString(),
    event_name: 'Stop',
    completion_source: 'agy_transcript_idle',
    last_activity_at: new Date(Math.max(partialStopAtMs, treeLastActivityMs || 0)).toISOString(),
    partial_stop_at: stopAtIso,
  };
}

module.exports = {
  DEFAULT_QUIESCENCE_MS,
  DEFAULT_INFLIGHT_MAX_MS,
  DEFAULT_TREE_INFLIGHT_GRACE_MS,
  evaluateAgyTranscriptIdleCompletion,
};
