(() => {
  if (typeof window.__taskAppChatWatchCleanup === 'function') {
    window.__taskAppChatWatchCleanup();
  }

  const VERSION = '0.3.0';
  const geminiSignals = globalThis.__orchestraGeminiWatchSignals;
  const claudeSignals = globalThis.__orchestraClaudeWatchSignals;
  const privacy = globalThis.__orchestraChatWatchPrivacy;
  const LOG_PREFIX = '[chat-watch]';
  const STORAGE_KEYS = {
    debug: 'taskAppChatWatchDebug',
    sendPromptPreviews: 'taskAppChatWatchSendPromptPreviews',
    // Opt-in gate for the MAIN-world stream-body sniffer (S1/S3/S4/S5). Default off; body-reading
    // only happens once the user enables this. Structural fields only — never message content.
    streamSignals: 'taskAppChatWatchStreamSignals',
    // Separate, stricter opt-in (FollowUps §3.3): stream the assistant's MESSAGE TEXT into Orchestra.
    // Default off. When on, the sniffer extracts reply text (chatgpt/claude) and the DOM path streams
    // gemini + posts the final message for every provider. This is the "explicit privacy opt-in".
    streamBody: 'taskAppChatWatchStreamBody',
  };
  const MAX_BUTTONS = 80;
  const MAX_INPUTS = 20;
  const MAX_MESSAGE_PREVIEW = 240;
  const MAX_LANDMARKS = 60;
  const MAX_ACTIVITY_INDICATORS = 20;
  const CHANGE_DEBOUNCE_MS = 750;
  const CHATGPT_RESPONSE_ACTION_LABELS = ['Copy response', 'Good response', 'Bad response'];
  const ACTIVE_RESEARCH_PATTERN =
    /\b(researching|searching|browsing|reading|analyzing|analysing|checking|reviewing|visiting|gathering|synthesizing|synthesising|writing|drafting)\b/i;
  const ACTIVE_RESEARCH_CONTEXT_PATTERN =
    /\b(researching|searching|browsing|reading|analyzing|analysing|checking|reviewing|visiting|gathering|synthesizing|synthesising|writing|drafting)\b[\s\S]{0,120}\b(source|sources|site|sites|web|webpage|pages|result|results|research|report)\b/i;
  const CHATGPT_GENERATION_ERROR_PATTERNS = [
    /something went wrong while generating the response/i,
    /if this issue persists please contact us through our help center at help\.openai\.com/i,
  ];
  const PROVIDERS = [
    {
      id: 'chatgpt',
      label: 'ChatGPT',
      hostPattern: /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/i,
      conversationPatterns: [/\/c\/([^/?#]+)/i],
    },
    {
      id: 'claude',
      label: 'Claude',
      hostPattern: /(^|\.)claude\.ai$/i,
      conversationPatterns: [/\/chat\/([^/?#]+)/i, /\/project\/[^/]+\/chat\/([^/?#]+)/i],
    },
    {
      id: 'gemini',
      label: 'Gemini',
      hostPattern: /(^|\.)gemini\.google\.com$/i,
      conversationPatterns: [/\/app\/([^/?#]+)/i],
    },
  ];

  let lastSignature = '';
  let lastSnapshot = null;
  let changeTimer = null;
  let bgTimer = null;
  let observer = null;
  let disposed = false;
  let debugEnabled = false;
  let sendPromptPreviews = false;
  let streamSignalsEnabled = false;
  let streamBodyEnabled = false;

  // Tell the MAIN-world spoofer whether stream-body sniffing is allowed. The spoofer defaults OFF
  // and only tees response bodies once it receives this with enabled:true or bodyEnabled:true (the
  // privacy gate). `bodyEnabled` additionally unlocks assistant-text extraction (§3.3).
  function pushStreamSniffConfig() {
    try {
      window.dispatchEvent(new CustomEvent('chat-watch-stream-config', {
        detail: { enabled: !!streamSignalsEnabled, bodyEnabled: !!streamBodyEnabled },
      }));
    } catch (_) {
      /* ignore */
    }
  }

  function applyPrivacySettings(stored) {
    debugEnabled = !!stored[STORAGE_KEYS.debug];
    sendPromptPreviews = !!stored[STORAGE_KEYS.sendPromptPreviews];
    streamSignalsEnabled = !!stored[STORAGE_KEYS.streamSignals];
    streamBodyEnabled = !!stored[STORAGE_KEYS.streamBody];
    pushStreamSniffConfig();
  }

  function loadPrivacySettings() {
    try {
      chrome.storage.local.get(
        [STORAGE_KEYS.debug, STORAGE_KEYS.sendPromptPreviews, STORAGE_KEYS.streamSignals, STORAGE_KEYS.streamBody],
        (stored) => {
          if (disposed) return;
          applyPrivacySettings(stored || {});
        }
      );
    } catch (err) {
      handleInvalidatedExtensionContext(err);
    }
  }

  const consoleLogListener = (event) => {
    try {
      const detail = event.detail;
      chrome.runtime.sendMessage({
        type: 'PAGE_CONSOLE_LOG',
        payload: {
          method: detail.method,
          text: detail.text,
          timestamp: detail.timestamp
        }
      }, () => {
        try { void chrome.runtime.lastError; } catch (_) {}
      });
    } catch (err) {
      handleInvalidatedExtensionContext(err);
    }
  };

  window.addEventListener('chat-watch-console-log', consoleLogListener);

  // Forward MAIN-world stream-body signals (S1/S3/S4/S5) to the background worker. Structural
  // fields only — provider, conversation_id, turn_id, marker, endpoint, method, t, plus the
  // handoff flag and body duration (both structural; see spoofer.js emitStreamSignals). Same
  // dispatch pattern as the console-log path above.
  const streamSignalListener = (event) => {
    try {
      const d = (event && event.detail) || {};
      chrome.runtime.sendMessage(
        {
          type: 'STREAM_SIGNAL',
          payload: {
            provider: d.provider || '',
            conversation_id: d.conversation_id || '',
            turn_id: d.turn_id || '',
            marker: d.marker || '',
            endpoint: d.endpoint || '',
            method: d.method || '',
            t: typeof d.t === 'number' ? d.t : Date.now(),
            handoff: d.handoff === true,
            body_ms: typeof d.body_ms === 'number' && d.body_ms >= 0 ? d.body_ms : 0,
          },
        },
        () => {
          try { void chrome.runtime.lastError; } catch (_) {}
        }
      );
    } catch (err) {
      handleInvalidatedExtensionContext(err);
    }
  };

  window.addEventListener('chat-watch-stream-signal', streamSignalListener);

  // Forward MAIN-world assistant-TEXT snapshots (§3.3 opt-in) to the background worker. Unlike the
  // structural signal above, this carries model message content — it only ever fires when the
  // body-streaming opt-in is on (the spoofer gates the dispatch on streamBodyEnabled).
  const streamBodyListener = (event) => {
    try {
      const d = (event && event.detail) || {};
      chrome.runtime.sendMessage(
        {
          type: 'STREAM_BODY',
          payload: {
            provider: d.provider || '',
            conversation_id: d.conversation_id || '',
            turn_id: d.turn_id || '',
            text: typeof d.text === 'string' ? d.text : '',
            final: d.final === true,
            source: d.source || 'stream',
            t: typeof d.t === 'number' ? d.t : Date.now(),
          },
        },
        () => {
          try { void chrome.runtime.lastError; } catch (_) {}
        }
      );
    } catch (err) {
      handleInvalidatedExtensionContext(err);
    }
  };

  window.addEventListener('chat-watch-stream-body', streamBodyListener);

  // Relay for the deep-research frame observer (v0.5.15). content-dr-frame.js runs inside the
  // SANDBOXED research-card iframe, whose opaque origin cannot reliably use runtime APIs
  // (live-confirmed) — so it posts its button state to this parent page, and we forward it to the
  // background worker. Validation is by SOURCE, not origin (a sandboxed frame's origin is "null"):
  // the message must come from the contentWindow of an iframe in THIS document whose src points at
  // the *.oaiusercontent.com sandbox. Payload is structural booleans/counters only.
  let drFrameSeen = false;
  const drFrameRelayListener = (event) => {
    const data = event && event.data;
    const payload = data && typeof data === 'object' ? data.__orchestraChatWatchDrFrame : null;
    if (!payload || typeof payload !== 'object') return;
    // The research UI is NESTED (page → connector shell iframe → inner frame), so the sender may
    // be any depth below one of our sandbox iframes. Walk the source's parent chain (parent/top
    // are whitelisted cross-origin accessors; identity comparison against contentWindow is safe)
    // and accept only if it passes through an iframe in THIS document whose src points at the
    // *.oaiusercontent.com sandbox.
    let fromSandboxFrame = false;
    try {
      const sandboxWindows = [];
      for (const frame of document.querySelectorAll('iframe')) {
        const host = new URL(frame.getAttribute('src') || '', location.href).hostname;
        if (/\.oaiusercontent\.com$/i.test(host) && frame.contentWindow) sandboxWindows.push(frame.contentWindow);
      }
      let w = event.source;
      for (let depth = 0; w && depth < 5; depth += 1) {
        if (sandboxWindows.includes(w)) { fromSandboxFrame = true; break; }
        if (w === window.top || w === w.parent) break;
        w = w.parent;
      }
    } catch (_) { fromSandboxFrame = false; }
    if (!fromSandboxFrame) return;
    drFrameSeen = true;
    try {
      chrome.runtime.sendMessage(
        {
          type: 'DR_FRAME_STATE',
          payload: {
            event: typeof payload.event === 'string' ? payload.event : '',
            stop_visible: payload.stop_visible === true,
            start_visible: payload.start_visible === true,
            completed_visible: payload.completed_visible === true,
            pagehide: payload.pagehide === true,
            buttons: typeof payload.buttons === 'number' ? payload.buttons : 0,
            t: typeof payload.t === 'number' ? payload.t : Date.now(),
          },
        },
        () => {
          try { void chrome.runtime.lastError; } catch (_) {}
        }
      );
    } catch (err) {
      handleInvalidatedExtensionContext(err);
    }
  };
  window.addEventListener('message', drFrameRelayListener);

  function cleanup() {
    disposed = true;
    window.clearTimeout(changeTimer);
    window.clearTimeout(bgTimer);
    if (observer) observer.disconnect();
    window.removeEventListener('chat-watch-console-log', consoleLogListener);
    window.removeEventListener('chat-watch-stream-signal', streamSignalListener);
    window.removeEventListener('message', drFrameRelayListener);
  }

  window.__taskAppChatWatchCleanup = cleanup;

  function handleInvalidatedExtensionContext(err) {
    if (err && /Extension context invalidated/i.test(String(err.message || err))) {
      cleanup();
      return true;
    }
    return false;
  }

  function textOf(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function hasVisibleTestId(testId) {
    const id = textOf(testId);
    if (!id) return false;
    const selector = `[data-testid="${id}"], [data-test-id="${id}"]`;
    return Array.from(document.querySelectorAll(selector)).some(isVisible);
  }

  function compactElement(element) {
    return {
      tag: element.tagName.toLowerCase(),
      text: textOf(element.innerText || element.textContent),
      ariaLabel: textOf(element.getAttribute('aria-label')),
      title: textOf(element.getAttribute('title')),
      role: textOf(element.getAttribute('role')),
      testId: textOf(element.getAttribute('data-testid')),
      disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
      visible: isVisible(element),
    };
  }

  function labelOf(info) {
    return textOf([info.text, info.ariaLabel, info.title, info.testId].filter(Boolean).join(' '));
  }

  function primaryLabelOf(info) {
    return textOf(info.ariaLabel || info.text || info.title || info.testId);
  }

  function hasAllResponseActions(items) {
    const labels = new Set((items || []).filter((item) => item.visible !== false).map(primaryLabelOf));
    return CHATGPT_RESPONSE_ACTION_LABELS.every((label) => labels.has(label));
  }

  function isChatGptAssistantShell(info, element) {
    const testId = textOf(info.testId);
    const textPreview = textOf(info.textPreview || info.text);
    if (!/^conversation-turn-\d+$/i.test(testId)) return false;
    if (/^ChatGPT said:/.test(textPreview)) return true;
    if (element && element.querySelector('[data-message-author-role="assistant"]')) return true;
    if (info.messageAuthorRole === 'assistant') return true;
    return false;
  }

  function conversationTurnNumber(info) {
    const match = textOf(info && info.testId).match(/^conversation-turn-(\d+)$/i);
    return match ? Number.parseInt(match[1], 10) : -1;
  }

  function getProvider() {
    return (
      PROVIDERS.find((provider) => provider.hostPattern.test(location.host)) || {
        id: 'unknown',
        label: 'Unknown',
        hostPattern: /^$/,
        conversationPatterns: [],
      }
    );
  }

  function collectButtons() {
    return Array.from(document.querySelectorAll('button'))
      .map(compactElement)
      .filter((button) => button.visible && labelOf(button))
      .slice(0, MAX_BUTTONS);
  }

  function collectInputs() {
    const selectors = ['textarea', 'input', '[contenteditable="true"]'];
    return Array.from(document.querySelectorAll(selectors.join(',')))
      .map((element) => {
        const info = compactElement(element);
        return {
          ...info,
          placeholder: textOf(element.getAttribute('placeholder')),
          valueLength: typeof element.value === 'string' ? element.value.length : textOf(element.textContent).length,
        };
      })
      .filter((input) => input.visible)
      .slice(0, MAX_INPUTS);
  }

  function collectLandmarks() {
    const selectors = [
      '[data-testid]',
      '[data-test-id]',
      '[data-message-author-role]',
      '[aria-live]',
      '[role="status"]',
      '[role="log"]',
      '[role="main"]',
      '[role="textbox"]',
      '[contenteditable="true"]',
    ];
    return Array.from(document.querySelectorAll(selectors.join(',')))
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        role: textOf(element.getAttribute('role')),
        ariaLabel: textOf(element.getAttribute('aria-label')),
        ariaLive: textOf(element.getAttribute('aria-live')),
        testId: textOf(element.getAttribute('data-testid') || element.getAttribute('data-test-id')),
        messageAuthorRole: textOf(element.getAttribute('data-message-author-role')),
        className: textOf(element.className).slice(0, 160),
        textPreview: textOf(element.innerText || element.textContent).slice(0, 120),
        visible: isVisible(element),
      }))
      .filter((item) => item.visible)
      .slice(0, MAX_LANDMARKS);
  }

  function excerptAround(text, pattern) {
    const value = textOf(text);
    const match = value.match(pattern);
    if (!match || match.index == null) return '';
    const start = Math.max(0, match.index - 80);
    const end = Math.min(value.length, match.index + match[0].length + 160);
    return value.slice(start, end);
  }

  function collectActivityIndicators(provider, buttons, landmarks) {
    const selectors = [
      '[aria-live]',
      '[aria-busy="true"]',
      '[role="status"]',
      '[role="log"]',
      '[role="progressbar"]',
      'progress',
      '[data-testid*="research" i]',
      '[data-test-id*="research" i]',
      '[data-testid*="progress" i]',
      '[data-test-id*="progress" i]',
      '[data-state*="loading" i]',
      '[data-state*="running" i]',
      '[class*="research" i]',
      '[class*="progress" i]',
      '[class*="loading" i]',
      '[class*="spinner" i]',
    ];
    const byKey = new Map();
    const addIndicator = (item, checkTestId = true) => {
      const label = checkTestId
        ? labelOf(item)
        : textOf([item.text, item.ariaLabel, item.title].filter(Boolean).join(' '));
      if (label.length > 250) return;
      if (!ACTIVE_RESEARCH_PATTERN.test(label)) return;
      if (provider.id === 'claude' && /Research complete/i.test(label)) return;
      const key = `${item.tag}:${label}`;
      if (!byKey.has(key)) {
        byKey.set(key, item);
      }
    };

    [...buttons, ...landmarks].forEach((item) => addIndicator(item, false));
    Array.from(document.querySelectorAll(selectors.join(',')))
      .map(compactElement)
      .filter((item) => item.visible)
      .forEach((item) => addIndicator(item, true));

    if (!byKey.size && provider.id === 'chatgpt') {
      const assistantTurns = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]'))
        .filter((el) => isVisible(el) && el.querySelector('[data-message-author-role="assistant"]'));
      const latestAssistantTurn = assistantTurns[assistantTurns.length - 1];
      const hasActions = latestAssistantTurn && Boolean(
        latestAssistantTurn.querySelector('[data-testid="copy-turn-action-button"]') ||
        latestAssistantTurn.querySelector('[data-testid="good-response-turn-action-button"]') ||
        latestAssistantTurn.querySelector('[data-testid="bad-response-turn-action-button"]')
      );
      if (latestAssistantTurn && !hasActions) {
        const turnText = textOf(latestAssistantTurn.innerText || latestAssistantTurn.textContent);
        const excerpt = excerptAround(turnText, ACTIVE_RESEARCH_CONTEXT_PATTERN);
        if (excerpt) {
          byKey.set('body:active-research', {
            tag: 'body',
            text: excerpt,
            ariaLabel: '',
            title: '',
            role: '',
            testId: '',
            disabled: false,
            visible: true,
          });
        }
      }
    }

    return Array.from(byKey.values()).slice(0, MAX_ACTIVITY_INDICATORS);
  }

  function collectChatGptFailureSignal(provider) {
    if (provider.id !== 'chatgpt') {
      return { failureSignal: false, failureReason: '' };
    }
    const selectors = [
      '[role="alert"]',
      '[aria-live="assertive"]',
      '[data-testid*="error" i]',
      '[class*="error" i]',
    ];
    const candidates = Array.from(document.querySelectorAll(selectors.join(',')))
      .filter(isVisible)
      .map((element) => textOf(element.innerText || element.textContent))
      .filter(Boolean);
    if (!candidates.length) {
      const bodyText = textOf(document.body.innerText || document.body.textContent);
      if (bodyText) candidates.push(bodyText);
    }
    for (const text of candidates) {
      for (const pattern of CHATGPT_GENERATION_ERROR_PATTERNS) {
        if (pattern.test(text)) {
          return { failureSignal: true, failureReason: 'chatgpt_generation_error' };
        }
      }
    }
    return { failureSignal: false, failureReason: '' };
  }

  function hasVisibleClaudeResearchCompleteText(buttons) {
    const pattern = /Research complete/i;
    const fromDom = Array.from(document.querySelectorAll('button,[role="status"]'))
      .filter(isVisible)
      .some((element) => pattern.test(textOf(element.innerText || element.textContent)));
    if (fromDom) return true;
    return (buttons || [])
      .filter((item) => item.visible !== false)
      .some((item) => pattern.test(labelOf(item)));
  }

  function collectClaudeDeepResearchSignals(provider, conversationId, stopButtonCandidates, buttons) {
    if (provider.id !== 'claude' || !claudeSignals) {
      return {
        hasStopResponseButton: false,
        hasResearchCompleteText: false,
        deepResearchReportComplete: false,
        deepResearchInProgress: false,
      };
    }
    const hasStopResponseButton = (stopButtonCandidates || []).some((button) =>
      /stop response/i.test(labelOf(button))
    );
    return claudeSignals.evaluateClaudeDeepResearchState({
      conversationId,
      hasStopResponseButton,
      hasResearchCompleteText: hasVisibleClaudeResearchCompleteText(buttons),
    });
  }

  function collectGeminiDeepResearchSignals(provider, conversationId) {
    if (provider.id !== 'gemini' || !geminiSignals) {
      return {
        hasUsedSourcesButton: false,
        hasMessageContent: false,
        hasExportMenuButton: false,
        hasThoughtHeader: false,
        hasPanelBottomSheetButton: false,
        deepResearchReportComplete: false,
        deepResearchInProgress: false,
      };
    }
    return geminiSignals.evaluateGeminiDeepResearchState({
      conversationId,
      hasUsedSourcesButton: hasVisibleTestId('used-sources-button'),
      hasMessageContent: hasVisibleTestId('message-content'),
      hasExportMenuButton: hasVisibleTestId('export-menu-button'),
      hasThoughtHeader: hasVisibleTestId('thought-header'),
      hasPanelBottomSheetButton: hasVisibleTestId('panel-state-bottom-sheet-button'),
    });
  }

  // The deep-research progress card renders in a cross-origin sandboxed iframe
  // (connector_openai_deep_research.web-sandbox.oaiusercontent.com, title "internal://deep-research").
  // Same-origin policy hides its CONTENTS (the "Stop research" button lives in there, unreachable
  // from this document), but the <iframe> ELEMENT is part of this page — its visible presence is
  // the one parent-DOM landmark that the research is on screen. The in-frame observer
  // (content-dr-frame.js) reads the button itself; this is the parent-side half.
  function findChatGptResearchCardIframe() {
    for (const frame of document.querySelectorAll('iframe')) {
      let host = '';
      try { host = new URL(frame.getAttribute('src') || '', location.href).hostname; } catch (_) { host = ''; }
      const title = textOf(frame.getAttribute('title'));
      const isResearchCard =
        title === 'internal://deep-research' ||
        (/\.web-sandbox\.oaiusercontent\.com$/i.test(host) && /deep[_-]?research/i.test(host));
      if (isResearchCard && isVisible(frame)) return frame;
    }
    return null;
  }

  // v0.5.12: the legacy chip heuristic (chip + assistant shell + no response actions) must hold
  // CONTINUOUSLY for this long before it reads as research-in-progress. A completed-research page
  // load passes through that exact shape for a sub-second window while the response actions
  // render (observed live: one transient arm + one generating:true snapshot per page load — the
  // immediate-resume flap vector). A real research start holds the shape from prompt-send until
  // the intro's actions appear (~5-15s), so a 1.5s debounce costs the arm almost nothing.
  const DR_HEURISTIC_DEBOUNCE_MS = 1500;
  let drHeuristicSinceMs = 0;
  let drHeuristicCid = null;

  // v0.5.11: the card iframe element is DIAGNOSTIC ONLY (dr_card_visible), never a state input.
  // Live evidence killed every attempt to use it for state: (a) the card PERSISTS on a completed
  // research page, so visibility ≠ working; (b) a "live-mount" gate (card appearing where it was
  // absent) is defeated by staged page rendering — turns render a beat before the iframe mounts,
  // on loads, reloads, AND rapid SPA navigation, so completed pages kept false-arming (observed
  // three transient arms while flipping through finished researches); (c) the report renders into
  // the SAME conversation turn as the intro, so no turn arithmetic can release a card-based hold.
  // The in-frame observer (content-dr-frame.js — sees the actual Stop-research button) is the
  // deep-research truth; the legacy chip heuristic below covers the opening seconds before the
  // frame port connects.

  function collectChatGptDeepResearchSignals(provider, buttons, landmarks, conversationId) {
    if (provider.id !== 'chatgpt') {
      return {
        hasDeepResearchChip: false,
        hasAssistantShell: false,
        hasCompletedResponseActions: false,
        hasResearchCard: false,
        latestTurnNumber: -1,
        completedTurnNumber: -1,
        deepResearchInProgress: false,
      };
    }

    const isDeepResearchButton = (button) => {
      const text = textOf(button.text);
      const ariaLabel = textOf(button.ariaLabel);
      return text === 'Deep research' || ariaLabel === 'Deep research' || ariaLabel.startsWith('Deep research,');
    };
    const hasDeepResearchChip =
      buttons.some(isDeepResearchButton) ||
      Array.from(document.querySelectorAll('button')).some((element) =>
        isVisible(element) &&
        isDeepResearchButton({
          text: element.innerText || element.textContent,
          ariaLabel: element.getAttribute('aria-label'),
        })
      );

    const turnElements = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]')).filter(isVisible);
    const latestTurnNumber = turnElements.reduce((max, element) => {
      return Math.max(max, conversationTurnNumber({ testId: element.getAttribute('data-testid') }));
    }, -1);
    const assistantShells = turnElements
      .map((element) => ({
        element,
        turnNumber: conversationTurnNumber({ testId: element.getAttribute('data-testid') }),
        isAssistantShell: isChatGptAssistantShell({
          testId: element.getAttribute('data-testid'),
          textPreview: element.innerText || element.textContent,
        }, element),
      }))
      .filter((item) => item.isAssistantShell);
    const latestAssistantShell = assistantShells[assistantShells.length - 1] || null;
    const latestAssistantIsCurrent = Boolean(latestAssistantShell && latestAssistantShell.turnNumber === latestTurnNumber);

    const landmarkLatestTurnNumber = landmarks.reduce((max, item) => Math.max(max, conversationTurnNumber(item)), -1);
    const hasCurrentAssistantShell =
      latestTurnNumber >= 0
        ? latestAssistantIsCurrent
        : landmarks.some((item) => isChatGptAssistantShell(item) && conversationTurnNumber(item) === landmarkLatestTurnNumber);

    const shellButtons = latestAssistantIsCurrent
      ? Array.from(latestAssistantShell.element.querySelectorAll('button')).map(compactElement)
      : [];
    let hasCompletedResponseActions = hasAllResponseActions(shellButtons);

    if (!hasCompletedResponseActions && (latestAssistantIsCurrent || latestTurnNumber < 0)) {
      let latestShellIndex = -1;
      for (let i = landmarks.length - 1; i >= 0; i -= 1) {
        if (isChatGptAssistantShell(landmarks[i]) && conversationTurnNumber(landmarks[i]) === landmarkLatestTurnNumber) {
          latestShellIndex = i;
          break;
        }
      }
      if (latestShellIndex >= 0) {
        const scopedLandmarks = [];
        for (let i = latestShellIndex + 1; i < landmarks.length; i += 1) {
          const item = landmarks[i];
          if (/^conversation-turn-\d+$/i.test(textOf(item.testId))) break;
          scopedLandmarks.push(item);
        }
        hasCompletedResponseActions = hasAllResponseActions(scopedLandmarks);
      }
    }

    // Turn anchors (structural ints, never content). DIAGNOSTIC as of v0.5.11: the report renders
    // into the SAME conversation turn as the intro (turn numbers never advance), so these can no
    // longer gate the completion — they are kept for recordings/replay analysis only.
    const observedLatestTurn = latestTurnNumber >= 0 ? latestTurnNumber : landmarkLatestTurnNumber;
    const completedTurnNumber = hasCompletedResponseActions
      ? (latestAssistantIsCurrent && latestAssistantShell ? latestAssistantShell.turnNumber : observedLatestTurn)
      : -1;

    // Raw card-iframe visibility — diagnostics only (dr_card_visible), never a state input.
    const hasResearchCard = Boolean(findChatGptResearchCardIframe());

    return {
      hasDeepResearchChip,
      hasAssistantShell: hasCurrentAssistantShell,
      hasCompletedResponseActions,
      hasResearchCard,
      latestTurnNumber: observedLatestTurn,
      completedTurnNumber,
      // Legacy chip heuristic only: true during the research's OPENING seconds (chip + assistant
      // shell present, response actions not yet grown). Goes false once the intro's actions appear
      // — from there the in-frame observer (Stop-research button, via background) is the truth.
      // Time-debounced (v0.5.12) so a completed page's staged render can't transiently match.
      deepResearchInProgress: debouncedDrHeuristic(
        Boolean(conversationId && hasDeepResearchChip && hasCurrentAssistantShell && !hasCompletedResponseActions),
        conversationId
      ),
    };
  }

  // See DR_HEURISTIC_DEBOUNCE_MS. Raw heuristic edges (false, or a conversation change) reset the
  // clock; the debounced value is true only once the shape has held for the full window.
  function debouncedDrHeuristic(rawActive, conversationId) {
    const now = Date.now();
    if (!rawActive || drHeuristicCid !== conversationId) {
      drHeuristicSinceMs = rawActive ? now : 0;
      drHeuristicCid = conversationId;
      return false;
    }
    if (!drHeuristicSinceMs) drHeuristicSinceMs = now;
    return now - drHeuristicSinceMs >= DR_HEURISTIC_DEBOUNCE_MS;
  }

  function collectMessageStats() {
    const roleNodes = Array.from(document.querySelectorAll('[data-message-author-role]'));
    const roleCounts = {};
    let lastAssistantPreview = '';

    roleNodes.forEach((node) => {
      const role = textOf(node.getAttribute('data-message-author-role')) || 'unknown';
      roleCounts[role] = (roleCounts[role] || 0) + 1;
    });

    for (let i = roleNodes.length - 1; i >= 0; i -= 1) {
      const node = roleNodes[i];
      if (node.getAttribute('data-message-author-role') === 'assistant') {
        lastAssistantPreview = textOf(node.innerText || node.textContent).slice(0, MAX_MESSAGE_PREVIEW);
        break;
      }
    }

    return {
      messageCount: roleNodes.length,
      roleCounts,
      lastAssistantPreview,
      foundRoleAttribute: roleNodes.length > 0,
    };
  }

  function getConversationId(provider) {
    for (const pattern of provider.conversationPatterns) {
      const match = location.pathname.match(pattern);
      if (match) return match[1];
    }
    return '';
  }

  function rawLastUserPreviewText(provider, inputs) {
    if (provider.id === 'chatgpt') {
      const nodes = Array.from(document.querySelectorAll('[data-message-author-role="user"]'));
      if (nodes.length) {
        const last = nodes[nodes.length - 1];
        return textOf(last.innerText || last.textContent);
      }
    }
    if (provider.id === 'claude') {
      const nodes = Array.from(document.querySelectorAll('[data-testid="user-message"]'));
      if (nodes.length) {
        const last = nodes[nodes.length - 1];
        return textOf(last.innerText || last.textContent);
      }
    }
    if (provider.id === 'gemini') {
      const nodes = Array.from(document.querySelectorAll('user-query, user-query-content, .query-text, .user-query-container'));
      if (nodes.length) {
        const last = nodes[nodes.length - 1];
        const rawText = textOf(last.innerText || last.textContent);
        return rawText.replace(/^you said\s*/i, '').trim();
      }
    }
    let best = '';
    for (const input of inputs) {
      const t = textOf(input.text);
      if (t.length > best.length) best = t;
    }
    return best;
  }

  function lastUserPreviewText(provider, inputs) {
    const raw = rawLastUserPreviewText(provider, inputs);
    if (!privacy || typeof privacy.applyPromptPreviewPolicy !== 'function') {
      return sendPromptPreviews ? raw.slice(0, 240) : '';
    }
    return privacy.applyPromptPreviewPolicy(raw, sendPromptPreviews);
  }

  function scheduleBackgroundSend(snapshot, immediate = false) {
    if (disposed || snapshot.provider === 'unknown') return;
    window.clearTimeout(bgTimer);

    const send = () => {
      if (disposed) return;
      const cid = String(snapshot.conversationId || '').trim().toLowerCase();
      try {
        chrome.runtime.sendMessage(
          {
            type: 'CHAT_UPDATE',
            payload: {
              url: snapshot.url,
              title: snapshot.title,
              provider: snapshot.provider,
              conversation_id: cid,
              last_user_preview: snapshot.last_user_preview || '',
              generating: !!snapshot.generating,
              completion_signal: !!snapshot.completionSignal,
              failure_signal: !!snapshot.failureSignal,
              failure_reason: snapshot.failureReason || '',
              // Turn anchors for the chatgpt DR completion gate (see collectChatGptDeepResearchSignals).
              latest_turn: snapshot.chatGptDeepResearch && snapshot.chatGptDeepResearch.latestTurnNumber >= 0
                ? snapshot.chatGptDeepResearch.latestTurnNumber : null,
              completion_turn: snapshot.chatGptDeepResearch && snapshot.chatGptDeepResearch.completedTurnNumber >= 0
                ? snapshot.chatGptDeepResearch.completedTurnNumber : null,
              // Parent-DOM research-card observation (cross-origin iframe element visibility,
              // live-mount + turn gated) — the server arms its deep-research in-flight hold on it.
              deep_research_active: !!(snapshot.chatGptDeepResearch && snapshot.chatGptDeepResearch.deepResearchInProgress),
              // Raw card visibility (ungated) — observability: does the iframe persist on a
              // finished research page? Never used to arm or clear anything.
              dr_card_visible: !!(snapshot.chatGptDeepResearch && snapshot.chatGptDeepResearch.hasResearchCard),
              // Whether the in-frame observer has been heard from on this page (v0.5.15 diagnostic).
              dr_frame_seen: drFrameSeen,
              activity_summary: (snapshot.activityIndicators || [])
                .map((item) => labelOf(item))
                .filter(Boolean)
                .join(' | ')
                .slice(0, 500),
            },
          },
          () => {
            try {
              void chrome.runtime.lastError;
            } catch (err) {
              handleInvalidatedExtensionContext(err);
            }
          }
        );
      } catch (err) {
        if (!handleInvalidatedExtensionContext(err)) throw err;
      }
    };

    if (immediate) {
      send();
    } else {
      bgTimer = window.setTimeout(send, 400);
    }
  }

  // ── DOM assistant-text path for the §3.3 opt-in ──
  // The sniffer (spoofer.js) reconstructs chatgpt/claude reply text from the network stream. The DOM
  // path here covers (a) gemini streaming (its stream body is not text-parsed) and (b) the FINAL
  // message for EVERY provider on the generating→idle edge — a reliable done strip even if the
  // sniffer missed a format. Uncapped read (bounded to MAX_STREAM_BODY_TEXT), opt-in gated.
  const MAX_STREAM_BODY_TEXT = 8000;
  const STREAM_BODY_DOM_EMIT_MS = 1500;
  let lastStreamBodyDomEmitAt = 0;
  let streamBodyTurnActive = false;

  function rawLastAssistantTextById(providerId) {
    if (providerId === 'chatgpt' || providerId === 'claude') {
      const nodes = document.querySelectorAll('[data-message-author-role="assistant"]');
      if (nodes.length) {
        const last = nodes[nodes.length - 1];
        return textOf(last.innerText || last.textContent);
      }
    }
    if (providerId === 'gemini') {
      const nodes = document.querySelectorAll('message-content, .model-response-text');
      if (nodes.length) {
        const last = nodes[nodes.length - 1];
        return textOf(last.innerText || last.textContent);
      }
    }
    return '';
  }

  function sendStreamBody(detail) {
    if (disposed) return;
    try {
      chrome.runtime.sendMessage(
        {
          type: 'STREAM_BODY',
          payload: {
            provider: detail.provider || '',
            conversation_id: detail.conversation_id || '',
            turn_id: detail.turn_id || '',
            text: typeof detail.text === 'string' ? detail.text : '',
            final: detail.final === true,
            source: detail.source || 'dom',
            t: Date.now(),
          },
        },
        () => {
          try { void chrome.runtime.lastError; } catch (err) { handleInvalidatedExtensionContext(err); }
        }
      );
    } catch (err) {
      if (!handleInvalidatedExtensionContext(err)) throw err;
    }
  }

  function handleStreamBody(snapshot) {
    if (disposed || !streamBodyEnabled) {
      streamBodyTurnActive = snapshot ? !!snapshot.generating : false;
      return;
    }
    const providerId = snapshot.provider;
    if (!providerId || providerId === 'unknown') return;
    const cid = String(snapshot.conversationId || '').trim().toLowerCase();
    if (snapshot.generating) {
      streamBodyTurnActive = true;
      // gemini streams via the DOM (sniffer doesn't parse its body); chatgpt/claude stream via the
      // sniffer, so we don't double-source their intermediate text here.
      if (providerId === 'gemini') {
        const now = Date.now();
        if (now - lastStreamBodyDomEmitAt >= STREAM_BODY_DOM_EMIT_MS) {
          lastStreamBodyDomEmitAt = now;
          const text = rawLastAssistantTextById(providerId).slice(0, MAX_STREAM_BODY_TEXT);
          if (text) sendStreamBody({ provider: providerId, conversation_id: cid, text, final: false, source: 'dom' });
        }
      }
    } else if (streamBodyTurnActive) {
      // generating→idle edge: post the FINAL rendered message for every provider (reliable done strip).
      streamBodyTurnActive = false;
      const text = rawLastAssistantTextById(providerId).slice(0, MAX_STREAM_BODY_TEXT);
      if (text) sendStreamBody({ provider: providerId, conversation_id: cid, text, final: true, source: 'dom' });
    }
  }

  function createSnapshot() {
    const provider = getProvider();
    const rawButtons = Array.from(document.querySelectorAll('button'))
      .map(compactElement)
      .filter((button) => button.visible && labelOf(button));
    const buttons = rawButtons.slice(0, MAX_BUTTONS);
    const inputs = collectInputs();
    const landmarks = collectLandmarks();
    const messageStats = collectMessageStats();

    const stopButtonCandidates = rawButtons.filter(
      (button) =>
        button.testId === 'stop-button' ||
        /\b(stop|interrupt|cancel)\b|stop generating|stop response|stop streaming/i.test(labelOf(button))
    );
    const sendButtonCandidates = rawButtons.filter((button) => /\b(send|submit)\b|send message|submit prompt/i.test(labelOf(button)));
    const enabledSendButtonCandidates = sendButtonCandidates.filter((button) => !button.disabled);
    const activityIndicators = collectActivityIndicators(provider, rawButtons, landmarks);
    const conversationId = getConversationId(provider);
    const chatGptDeepResearch = collectChatGptDeepResearchSignals(provider, rawButtons, landmarks, conversationId);
    const geminiDeepResearch = collectGeminiDeepResearchSignals(provider, conversationId);
    const claudeDeepResearch = collectClaudeDeepResearchSignals(
      provider,
      conversationId,
      stopButtonCandidates,
      rawButtons
    );
    const failureState = collectChatGptFailureSignal(provider);
    const baseGenerating = stopButtonCandidates.length > 0 || activityIndicators.length > 0;
    const reportComplete =
      chatGptDeepResearch.hasCompletedResponseActions ||
      geminiDeepResearch.deepResearchReportComplete ||
      claudeDeepResearch.deepResearchReportComplete;
    const researchInProgress =
      chatGptDeepResearch.deepResearchInProgress ||
      geminiDeepResearch.deepResearchInProgress ||
      claudeDeepResearch.deepResearchInProgress;
    // researchInProgress outranks reportComplete: during a chatgpt deep research the INTRO turn's
    // response actions raise reportComplete while the research card is still up — the turn-gated
    // cardInProgress already told the two apart, so trust it for `generating`. completionSignal
    // still reports the (false) landmark; the server's completion gate holds it (lib/browser_chat).
    const generating = failureState.failureSignal ? false : researchInProgress ? true : reportComplete ? false : baseGenerating;
    const completionSignal = !!(failureState.failureSignal || reportComplete);

    return {
      version: VERSION,
      provider: provider.id,
      providerLabel: provider.label,
      timestamp: new Date().toISOString(),
      url: location.href,
      title: document.title,
      host: location.host,
      isSupportedHost: provider.id !== 'unknown',
      isConversationUrl: Boolean(conversationId),
      conversationId,
      generating,
      completionSignal,
      failureSignal: failureState.failureSignal,
      failureReason: failureState.failureReason,
      chatGptDeepResearch,
      geminiDeepResearch,
      claudeDeepResearch,
      visibleButtonCount: rawButtons.length,
      stopButtonCandidates,
      activityIndicators,
      sendButtonCandidates,
      enabledSendButtonCandidates,
      inputs,
      landmarks,
      last_user_preview: lastUserPreviewText(provider, inputs),
      ...messageStats,
      buttons,
    };
  }

  function signatureFor(snapshot) {
    return JSON.stringify({
      url: snapshot.url,
      title: snapshot.title,
      provider: snapshot.provider,
      generating: snapshot.generating,
      completionSignal: snapshot.completionSignal,
      chatGptResearchCard: snapshot.chatGptDeepResearch?.hasResearchCard,
      chatGptResearchInProgress: snapshot.chatGptDeepResearch?.deepResearchInProgress,
      geminiDeepResearchComplete: snapshot.geminiDeepResearch?.deepResearchReportComplete,
      claudeDeepResearchComplete: snapshot.claudeDeepResearch?.deepResearchReportComplete,
      failureSignal: snapshot.failureSignal,
      visibleButtonCount: snapshot.visibleButtonCount,
      messageCount: snapshot.messageCount,
      roleCounts: snapshot.roleCounts,
      lastAssistantLength: snapshot.lastAssistantPreview.length,
    });
  }

  function shouldLogVerboseSnapshot(reason) {
    return debugEnabled || reason === 'manual';
  }

  function logVerboseSnapshot(snapshot, reason) {
    console.groupCollapsed(
      `${LOG_PREFIX} ${snapshot.providerLabel} ${reason}: ${snapshot.generating ? 'generating' : 'idle'} (${snapshot.visibleButtonCount} buttons)`
    );
    console.log('Snapshot:', snapshot);
    console.table(snapshot.buttons.map((button) => ({
      label: labelOf(button),
      disabled: button.disabled,
      testId: button.testId,
      role: button.role,
    })));
    console.table(snapshot.activityIndicators.map((indicator) => ({
      label: labelOf(indicator),
      testId: indicator.testId,
      role: indicator.role,
    })));
    console.table(snapshot.inputs.map((input) => ({
      tag: input.tag,
      label: labelOf(input),
      placeholder: input.placeholder,
      valueLength: input.valueLength,
    })));
    console.table(snapshot.landmarks.map((landmark) => ({
      tag: landmark.tag,
      role: landmark.role,
      ariaLabel: landmark.ariaLabel,
      ariaLive: landmark.ariaLive,
      testId: landmark.testId,
      messageAuthorRole: landmark.messageAuthorRole,
      textPreview: landmark.textPreview,
    })));
    console.groupEnd();
  }

  function logSnapshot(reason, immediate = false) {
    if (disposed) return lastSnapshot;
    const snapshot = createSnapshot();
    scheduleBackgroundSend(snapshot, immediate);
    handleStreamBody(snapshot);
    const signature = signatureFor(snapshot);
    lastSnapshot = snapshot;

    if (signature === lastSignature && reason !== 'manual' && reason !== 'popup') {
      return snapshot;
    }

    lastSignature = signature;
    if (shouldLogVerboseSnapshot(reason)) {
      logVerboseSnapshot(snapshot, reason);
    }
    return snapshot;
  }

  function scheduleChangeLog() {
    if (disposed) return;

    const snapshot = createSnapshot();
    handleStreamBody(snapshot);
    const lastGen = lastSnapshot ? lastSnapshot.generating : false;
    const currentGen = snapshot.generating;
    const lastCid = lastSnapshot ? lastSnapshot.conversationId : '';
    const currentCid = snapshot.conversationId;

    if (currentGen !== lastGen || (currentCid && currentCid !== lastCid)) {
      window.clearTimeout(changeTimer);
      lastSnapshot = snapshot;
      lastSignature = signatureFor(snapshot);
      scheduleBackgroundSend(snapshot, true);
      if (shouldLogVerboseSnapshot('state changed')) {
        logVerboseSnapshot(snapshot, 'state changed');
      }
      return;
    }

    window.clearTimeout(changeTimer);
    changeTimer = window.setTimeout(() => logSnapshot('page changed'), CHANGE_DEBOUNCE_MS);
  }

  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.type !== 'CHAT_WATCH_INSPECT') return false;
      sendResponse({ ok: true, snapshot: logSnapshot('popup') || lastSnapshot });
      return false;
    });
  } catch (err) {
    if (!handleInvalidatedExtensionContext(err)) throw err;
  }

  observer = new MutationObserver(scheduleChangeLog);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled', 'aria-disabled', 'aria-label', 'data-testid', 'data-message-author-role'],
  });

  function bindPrivacySettingsListeners() {
    loadPrivacySettings();
    try {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (disposed || areaName !== 'local') return;
        if (
          !changes[STORAGE_KEYS.debug] &&
          !changes[STORAGE_KEYS.sendPromptPreviews] &&
          !changes[STORAGE_KEYS.streamSignals] &&
          !changes[STORAGE_KEYS.streamBody]
        ) {
          return;
        }
        applyPrivacySettings({
          [STORAGE_KEYS.debug]:
            changes[STORAGE_KEYS.debug] != null
              ? changes[STORAGE_KEYS.debug].newValue
              : debugEnabled,
          [STORAGE_KEYS.sendPromptPreviews]:
            changes[STORAGE_KEYS.sendPromptPreviews] != null
              ? changes[STORAGE_KEYS.sendPromptPreviews].newValue
              : sendPromptPreviews,
          [STORAGE_KEYS.streamSignals]:
            changes[STORAGE_KEYS.streamSignals] != null
              ? changes[STORAGE_KEYS.streamSignals].newValue
              : streamSignalsEnabled,
          [STORAGE_KEYS.streamBody]:
            changes[STORAGE_KEYS.streamBody] != null
              ? changes[STORAGE_KEYS.streamBody].newValue
              : streamBodyEnabled,
        });
      });
    } catch (err) {
      handleInvalidatedExtensionContext(err);
    }
  }

  window.__taskAppChatWatchInspect = () => logSnapshot('manual');
  bindPrivacySettingsListeners();
  logSnapshot('loaded');
})();
