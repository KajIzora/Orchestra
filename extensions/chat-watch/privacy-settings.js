/** Shared privacy defaults for Orchestra Chat Watch (no build step). */
(function initOrchestraChatWatchPrivacy(root) {
  const OPT_IN_PROMPT_PREVIEW_MAX = 240;

  function normalizePreviewText(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function applyPromptPreviewPolicy(text, sendPromptPreviews) {
    const normalized = normalizePreviewText(text);
    if (!sendPromptPreviews || !normalized) return '';
    return normalized.slice(0, OPT_IN_PROMPT_PREVIEW_MAX);
  }

  root.__orchestraChatWatchPrivacy = {
    OPT_IN_PROMPT_PREVIEW_MAX,
    normalizePreviewText,
    applyPromptPreviewPolicy,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
