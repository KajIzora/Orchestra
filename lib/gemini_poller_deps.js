// Single source of truth for the gemini watch-poller dependency wiring.
//
// Both the live server (server.js) and the signal replay (lib/signal_replay.js)
// feed createWatchPoller. They used to build the gemini deps in two separate
// places that drifted — notably the replay omitted the transcript-completion
// channel the server has. This builder owns the parts that must stay identical
// (the key set, the flag gating, which hook-store method maps to which dep, and
// the async/try-catch shape) and takes the legitimately environment-specific
// transcript reads as injected predicates (live files/ssh on the server,
// in-memory recorded text in replay).
//
// It returns ONLY the 10 gemini-specific deps — never the shared lifecycle keys
// (getState/save/pollMs/applyTaskStatusChange), which each caller still owns.
// The poller guards every gemini dep with `typeof deps.X === 'function'`, so the
// `() => null` / `() => false` stubs returned when a flag is off behave exactly
// like an absent key.

/**
 * @param {object} options
 * @param {object} options.hookStore - gemini hook store instance
 * @param {boolean} options.hooksEnabled - server: true; replay: flags.hooks
 * @param {boolean} options.transcriptEnabled - server: true; replay: flags.transcript
 * @param {()=>number} [options.now] - clock for time-based hints (default Date.now). The
 *   signal replay passes a virtual clock so the agy idle-completion quiescence can fire
 *   during recorded silent gaps; the live server omits it and uses the real clock.
 * @param {(wt:object)=>boolean|Promise<boolean>} options.transcriptCancelLocal
 * @param {(wt:object)=>boolean|Promise<boolean>} options.transcriptCancelRemote
 * @param {(wt:object)=>boolean|Promise<boolean>} options.transcriptDoneLocal
 * @param {(wt:object)=>boolean|Promise<boolean>} options.transcriptDoneRemote
 * @param {boolean} [options.primaryDoneOnly] - when true, the only "done" completion is the
 *   primary Stop+fullyIdle+NO_TOOL_CALL hook (getCompletionHintForTracking). The SECONDARY
 *   done paths — the idle-quiescence backup and the transcript-done channel — are stubbed.
 *   Cancel/permission/question gates are unaffected. Used to confirm which runs the primary
 *   done signal does (not) fire on. Off by default.
 */
function buildGeminiPollerDeps(options) {
  const {
    hookStore,
    hooksEnabled,
    transcriptEnabled,
    transcriptCancelLocal,
    transcriptCancelRemote,
    transcriptDoneLocal,
    transcriptDoneRemote,
    // Cascade discovery: (wt) => [conversationId,...] of the watched parent's sub-agents,
    // parsed from its transcript's INVOKE_SUBAGENT steps. Injected per environment (live: read
    // the transcript file; replay: the recording's pre-computed rec.cascade.sub_agents).
    subAgentIds = () => [],
    now = Date.now,
    primaryDoneOnly = false,
  } = options;

  const hook = (method) => (hooksEnabled ? (wt) => hookStore[method](wt) : () => null);
  const tx = (fn) => (transcriptEnabled ? fn : () => false);
  // The transcript-DONE channel is a secondary completion; stub it under primaryDoneOnly.
  const txDone = (fn) => (primaryDoneOnly ? () => false : tx(fn));
  const collectSubAgentIds = (wt) => {
    try {
      return subAgentIds(wt) || [];
    } catch {
      return [];
    }
  };

  // The cascade still has recent activity (any tree conversation active within the quiet window,
  // or a pending gate). While true, the transcript-DONE channel must not declare the parent done —
  // its quiet just means "waiting on a sub-agent". (The idle-completion backup applies the same
  // tree-wide quiescence internally.)
  const cascadeActive = (wt) =>
    hookStore.cascadeHasRecentActivity(wt, { subAgentIds: collectSubAgentIds(wt), nowMs: now() });

  return {
    // Hook-based hints.
    getGeminiCompletionHint: hook('getCompletionHintForTracking'),
    getGeminiCancelHint: hooksEnabled
      ? (wt) => hookStore.getCancelHintForTracking(wt, { subAgentIds: collectSubAgentIds(wt) })
      : () => null,
    getGeminiPermissionPendingHint: hooksEnabled
      ? (wt) => hookStore.getPermissionPendingHintForTracking(wt, { subAgentIds: collectSubAgentIds(wt) })
      : () => null,
    getGeminiQuestionPendingHint: hooksEnabled
      ? (wt) => hookStore.getQuestionPendingHintForTracking(wt, { subAgentIds: collectSubAgentIds(wt) })
      : () => null,
    getGeminiGateResolutionHint: hooksEnabled
      ? (wt, opts = {}) =>
          hookStore.getGateResolutionHintForTracking(wt, {
            ...opts,
            subAgentIds: collectSubAgentIds(wt),
          })
      : () => null,
    getGeminiActiveGenerationHint: hook('getActiveGenerationForTracking'),
    // Async idle-completion (quiescence) backup — a SECONDARY done path. Stubbed under
    // primaryDoneOnly. Cascade-aware: the store gates on sub-agents via subAgentIds and starts
    // the quiet window from the last sub-agent's terminal Stop.
    getGeminiAgyTranscriptIdleCompletionHint:
      hooksEnabled && !primaryDoneOnly
        ? async (wt) => {
            try {
              return await hookStore.getAgyTranscriptIdleCompletionHintForTracking(wt, {
                nowMs: now(),
                subAgentIds: collectSubAgentIds(wt),
              });
            } catch {
              return null;
            }
          }
        : () => null,
    // Transcript-based predicates (injected per environment). Cancel stays; the DONE channel is
    // secondary — stubbed under primaryDoneOnly, and additionally gated while any sub-agent is
    // still outstanding (defensive: it must not declare the parent done mid-cascade either).
    shouldCompleteGeminiTranscriptCancelWatch: tx(transcriptCancelLocal),
    shouldCompleteRemoteGeminiTranscriptCancelWatch: tx(transcriptCancelRemote),
    shouldCompleteGeminiWatch: txDone((wt) => (cascadeActive(wt) ? false : transcriptDoneLocal(wt))),
    shouldCompleteRemoteGeminiWatch: txDone((wt) => (cascadeActive(wt) ? false : transcriptDoneRemote(wt))),
  };
}

module.exports = { buildGeminiPollerDeps };
