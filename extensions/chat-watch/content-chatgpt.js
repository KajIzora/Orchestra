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

  // Tell the MAIN-world spoofer whether stream-body sniffing is allowed. The spoofer defaults OFF
  // and only tees response bodies once it receives this with enabled:true (the privacy gate).
  function pushStreamSniffConfig() {
    try {
      window.dispatchEvent(new CustomEvent('chat-watch-stream-config', {
        detail: { enabled: !!streamSignalsEnabled },
      }));
    } catch (_) {
      /* ignore */
    }
  }

  function applyPrivacySettings(stored) {
    debugEnabled = !!stored[STORAGE_KEYS.debug];
    sendPromptPreviews = !!stored[STORAGE_KEYS.sendPromptPreviews];
    streamSignalsEnabled = !!stored[STORAGE_KEYS.streamSignals];
    pushStreamSniffConfig();
  }

  function loadPrivacySettings() {
    try {
      chrome.storage.local.get(
        [STORAGE_KEYS.debug, STORAGE_KEYS.sendPromptPreviews, STORAGE_KEYS.streamSignals],
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
  // fields only — provider, conversation_id, turn_id, marker, endpoint, method, t. Same dispatch
  // pattern as the console-log path above.
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

  function cleanup() {
    disposed = true;
    window.clearTimeout(changeTimer);
    window.clearTimeout(bgTimer);
    if (observer) observer.disconnect();
    window.removeEventListener('chat-watch-console-log', consoleLogListener);
    window.removeEventListener('chat-watch-stream-signal', streamSignalListener);
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

  function collectChatGptDeepResearchSignals(provider, buttons, landmarks, conversationId) {
    if (provider.id !== 'chatgpt') {
      return {
        hasDeepResearchChip: false,
        hasAssistantShell: false,
        hasCompletedResponseActions: false,
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

    return {
      hasDeepResearchChip,
      hasAssistantShell: hasCurrentAssistantShell,
      hasCompletedResponseActions,
      deepResearchInProgress: Boolean(
        conversationId && hasDeepResearchChip && hasCurrentAssistantShell && !hasCompletedResponseActions
      ),
    };
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
    const generating = failureState.failureSignal ? false : reportComplete ? false : baseGenerating || researchInProgress;
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
          !changes[STORAGE_KEYS.streamSignals]
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
