/**
 * Gemini deep-research watch signals (browser + Node tests).
 * Done when used-sources-button, message-content, and export-menu-button are all visible.
 */
(function initGeminiWatchSignals(root) {
  const GEMINI_DEEP_RESEARCH_DONE_TEST_IDS = [
    'used-sources-button',
    'message-content',
    'export-menu-button',
  ];

  function evaluateGeminiDeepResearchState(flags) {
    const hasUsedSourcesButton = !!flags.hasUsedSourcesButton;
    const hasMessageContent = !!flags.hasMessageContent;
    const hasExportMenuButton = !!flags.hasExportMenuButton;
    const hasThoughtHeader = !!flags.hasThoughtHeader;
    const hasPanelBottomSheetButton = !!flags.hasPanelBottomSheetButton;
    const conversationId = String(flags.conversationId || '').trim();

    const deepResearchReportComplete =
      hasUsedSourcesButton && hasMessageContent && hasExportMenuButton;
    const deepResearchInProgress = Boolean(
      conversationId &&
        !deepResearchReportComplete &&
        (hasPanelBottomSheetButton || hasThoughtHeader)
    );

    return {
      hasUsedSourcesButton,
      hasMessageContent,
      hasExportMenuButton,
      hasThoughtHeader,
      hasPanelBottomSheetButton,
      deepResearchReportComplete,
      deepResearchInProgress,
    };
  }

  const api = {
    GEMINI_DEEP_RESEARCH_DONE_TEST_IDS,
    evaluateGeminiDeepResearchState,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.__orchestraGeminiWatchSignals = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : global);
