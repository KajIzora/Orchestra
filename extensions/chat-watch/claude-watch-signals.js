/**
 * Claude deep-research watch signals (browser + Node tests).
 * Done when the conversation is open, Stop response is gone, and visible text includes "Research complete".
 */
(function initClaudeWatchSignals(root) {
  const CLAUDE_RESEARCH_COMPLETE_PATTERN = /Research complete/i;

  function evaluateClaudeDeepResearchState(flags) {
    const conversationId = String(flags.conversationId || '').trim();
    const hasStopResponseButton = !!flags.hasStopResponseButton;
    const hasResearchCompleteText = !!flags.hasResearchCompleteText;

    const deepResearchReportComplete = Boolean(
      conversationId && !hasStopResponseButton && hasResearchCompleteText
    );
    const deepResearchInProgress = Boolean(
      conversationId && !deepResearchReportComplete && hasStopResponseButton
    );

    return {
      hasStopResponseButton,
      hasResearchCompleteText,
      deepResearchReportComplete,
      deepResearchInProgress,
    };
  }

  const api = {
    CLAUDE_RESEARCH_COMPLETE_PATTERN,
    evaluateClaudeDeepResearchState,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.__orchestraClaudeWatchSignals = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : global);
