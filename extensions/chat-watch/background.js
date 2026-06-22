const STORAGE_KEYS = {
  apiBase: 'taskAppChatWatchApiBase',
  token: 'taskAppChatWatchToken',
};

const DEFAULT_PORTS = [47823, 47824, 47825, 47826, 47827, 47828, 47829, 47830];
const CONFIG_FETCH_TIMEOUT_MS = 1500;

/** @type {Map<number, { lastGenerating: boolean, lastConversationId: string }>} */
const tabGenerationState = new Map();
/** @type {Promise<{ apiBase: string, token: string } | null> | null} */
let credentialsInFlight = null;

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

let cachedCreds = null;

async function loadCredentials() {
  if (cachedCreds) return cachedCreds;
  if (credentialsInFlight) return credentialsInFlight;
  credentialsInFlight = (async () => {
    const stored = await chrome.storage.local.get([STORAGE_KEYS.apiBase, STORAGE_KEYS.token]);
    if (stored[STORAGE_KEYS.apiBase] && stored[STORAGE_KEYS.token]) {
      cachedCreds = { apiBase: stored[STORAGE_KEYS.apiBase], token: stored[STORAGE_KEYS.token] };
      return cachedCreds;
    }
    for (const port of DEFAULT_PORTS) {
      const base = `http://127.0.0.1:${port}`;
      try {
        const res = await fetchWithTimeout(`${base}/api/browser-chats/config`, CONFIG_FETCH_TIMEOUT_MS);
        if (!res.ok) continue;
        const data = await res.json();
        if (data && data.token) {
          const apiBase = (data.apiBase || base).replace(/\/$/, '');
          const creds = { apiBase, token: data.token };
          await chrome.storage.local.set({
            [STORAGE_KEYS.apiBase]: apiBase,
            [STORAGE_KEYS.token]: data.token,
          });
          cachedCreds = creds;
          return creds;
        }
      } catch (err) {
        // Keep failures visible in worker DevTools for debugging.
        console.debug('[chat-watch] config probe failed', base, err && err.name ? err.name : err);
        /* try next port */
      }
    }
    return null;
  })();
  try {
    return await credentialsInFlight;
  } finally {
    credentialsInFlight = null;
  }
}

async function postJson(apiBase, path, body, token) {
  try {
    const res = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Browser-Chat-Token': token,
      },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch (err) {
    console.debug('[chat-watch] post failed', `${apiBase}${path}`, err && err.name ? err.name : err);
    return false;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  loadCredentials().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  loadCredentials().catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabGenerationState.delete(tabId);
  chrome.storage.local.get([STORAGE_KEYS.apiBase, STORAGE_KEYS.token]).then(async (stored) => {
    const apiBase = stored[STORAGE_KEYS.apiBase];
    const token = stored[STORAGE_KEYS.token];
    if (!apiBase || !token) return;
    try {
      await fetch(`${apiBase}/api/browser-chats/tab-closed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Browser-Chat-Token': token,
        },
        body: JSON.stringify({ tab_id: tabId }),
      });
    } catch {
      /* ignore */
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return false;
  }
  const tabId = sender.tab && sender.tab.id;
  if (!tabId) {
    sendResponse({ ok: false, error: 'no tab' });
    return false;
  }

  if (message.type === 'PAGE_CONSOLE_LOG') {
    (async () => {
      if (!(await isDebugLoggingEnabled())) {
        sendResponse({ ok: true });
        return;
      }
      const creds = await loadCredentials();
      if (!creds) {
        sendResponse({ ok: false, error: 'Orchestra not reachable' });
        return;
      }
      const payload = message.payload || {};
      const tabInfo = await getTabInfo(tabId);
      await postJson(creds.apiBase, '/api/browser-chats/probe-log', {
        type: 'console',
        method: payload.method,
        text: payload.text,
        timestamp: payload.timestamp,
        tabId: tabId,
        tabTitle: tabInfo.title || '',
        tabUrl: tabInfo.url || ''
      }, creds.token);
      sendResponse({ ok: true });
    })();
    return true; // async response
  }

  if (message.type !== 'CHAT_UPDATE') {
    return false;
  }

  (async () => {
    const creds = await loadCredentials();
    if (!creds) {
      sendResponse({ ok: false, error: 'Orchestra not reachable' });
      return;
    }
    const p = message.payload || {};
    const provider = p.provider;
    if (provider !== 'chatgpt' && provider !== 'claude' && provider !== 'gemini') {
      sendResponse({ ok: false, error: 'unknown provider' });
      return;
    }

    const conversation_id = typeof p.conversation_id === 'string' ? p.conversation_id.trim().toLowerCase() : '';
    const snapshotBody = {
      tab_id: tabId,
      provider,
      conversation_id,
      url: typeof p.url === 'string' ? p.url : '',
      title: typeof p.title === 'string' ? p.title : '',
      last_user_preview: typeof p.last_user_preview === 'string' ? p.last_user_preview : '',
      generating: !!p.generating,
      completion_signal: !!p.completion_signal,
      failure_signal: !!p.failure_signal,
      failure_reason: typeof p.failure_reason === 'string' ? p.failure_reason : '',
      activity_summary: typeof p.activity_summary === 'string' ? p.activity_summary : '',
    };

    let snapOk = await postJson(creds.apiBase, '/api/browser-chats/snapshot', snapshotBody, creds.token);
    if (!snapOk) {
      cachedCreds = null;
      await chrome.storage.local.remove([STORAGE_KEYS.apiBase, STORAGE_KEYS.token]);
      const freshCreds = await loadCredentials();
      if (!freshCreds) {
        sendResponse({ ok: false, error: 'snapshot rejected' });
        return;
      }
      snapOk = await postJson(freshCreds.apiBase, '/api/browser-chats/snapshot', snapshotBody, freshCreds.token);
      if (!snapOk) {
        sendResponse({ ok: false, error: 'snapshot rejected' });
        return;
      }
      creds.apiBase = freshCreds.apiBase;
      creds.token = freshCreds.token;
    }

    let prev = tabGenerationState.get(tabId) || { lastGenerating: false, lastConversationId: '' };
    const convChanged =
      conversation_id &&
      prev.lastConversationId &&
      conversation_id !== prev.lastConversationId;
    if (convChanged) {
      prev = { lastGenerating: false, lastConversationId: conversation_id };
    } else if (conversation_id) {
      prev = { ...prev, lastConversationId: conversation_id };
    }
    const gen = !!p.generating;
    const failed = !!p.failure_signal;
    const completionSignal = !!p.completion_signal;
    const shouldNotifyComplete =
      !!conversation_id &&
      (failed || completionSignal || (prev.lastGenerating && !gen));
    if (shouldNotifyComplete) {
      await postJson(
        creds.apiBase,
        '/api/browser-chats/complete',
        { provider, conversation_id },
        creds.token
      );
    }
    tabGenerationState.set(tabId, { lastGenerating: gen, lastConversationId: prev.lastConversationId || conversation_id });
    sendResponse({ ok: true });
  })();

  return true;
});

// Web request monitoring to detect Gemini background generation completion
const geminiFilter = { urls: ["https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate*"] };

async function handleGeminiStreamComplete(details) {
  const tabId = details.tabId;
  if (!tabId) return;

  const state = tabGenerationState.get(tabId);
  if (!state || !state.lastGenerating) {
    return;
  }

  // Set state to not generating immediately to avoid duplicate notifications
  state.lastGenerating = false;
  tabGenerationState.set(tabId, state);

  const creds = await loadCredentials();
  if (!creds) return;

  // Retrieve the tab to parse conversation_id from its URL
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab || !tab.url) {
      // Fallback to last known conversation ID from state
      if (state.lastConversationId) {
        postJson(
          creds.apiBase,
          '/api/browser-chats/complete',
          { provider: 'gemini', conversation_id: state.lastConversationId },
          creds.token
        );
      }
      return;
    }

    try {
      const url = new URL(tab.url);
      const match = url.pathname.match(/\/app\/([^/?#]+)/i);
      const conversationId = match ? match[1].toLowerCase() : state.lastConversationId;
      if (conversationId) {
        postJson(
          creds.apiBase,
          '/api/browser-chats/complete',
          { provider: 'gemini', conversation_id: conversationId },
          creds.token
        );
      }
    } catch (_) {
      if (state.lastConversationId) {
        postJson(
          creds.apiBase,
          '/api/browser-chats/complete',
          { provider: 'gemini', conversation_id: state.lastConversationId },
          creds.token
        );
      }
    }
  });
}

chrome.webRequest.onCompleted.addListener(handleGeminiStreamComplete, geminiFilter);
chrome.webRequest.onErrorOccurred.addListener(handleGeminiStreamComplete, geminiFilter);

// Web request monitoring to detect Claude background generation completion
const claudeFilter = { urls: ["https://claude.ai/api/organizations/*/chat_conversations/*/completion*"] };

async function handleClaudeStreamComplete(details) {
  const tabId = details.tabId;
  if (!tabId) return;

  const state = tabGenerationState.get(tabId);
  if (!state || !state.lastGenerating) {
    return;
  }

  // Set state to not generating immediately to avoid duplicate notifications
  state.lastGenerating = false;
  tabGenerationState.set(tabId, state);

  const creds = await loadCredentials();
  if (!creds) return;

  // Extract conversation ID from request URL
  try {
    const urlStr = details.url || '';
    const match = urlStr.match(/https:\/\/claude\.ai\/api\/organizations\/[^/]+\/chat_conversations\/([^/]+)\/completion/i);
    const conversationId = match ? match[1].toLowerCase() : state.lastConversationId;
    if (conversationId) {
      postJson(
        creds.apiBase,
        '/api/browser-chats/complete',
        { provider: 'claude', conversation_id: conversationId },
        creds.token
      );
    }
  } catch (err) {
    console.debug('[chat-watch] failed to parse Claude completion URL', err);
    if (state.lastConversationId) {
      postJson(
        creds.apiBase,
        '/api/browser-chats/complete',
        { provider: 'claude', conversation_id: state.lastConversationId },
        creds.token
      );
    }
  }
}

chrome.webRequest.onCompleted.addListener(handleClaudeStreamComplete, claudeFilter);
chrome.webRequest.onErrorOccurred.addListener(handleClaudeStreamComplete, claudeFilter);

// Web request monitoring to detect ChatGPT background generation completion
const chatgptFilter = {
  urls: [
    "https://chatgpt.com/backend-api/conversation*",
    "https://chatgpt.com/backend-api/f/conversation*",
    "https://chat.openai.com/backend-api/conversation*",
    "https://chat.openai.com/backend-api/f/conversation*"
  ]
};

async function handleChatgptStreamComplete(details) {
  if (details.method !== 'POST') return;
  const tabId = details.tabId;
  if (!tabId) return;

  const state = tabGenerationState.get(tabId);
  if (!state || !state.lastGenerating) {
    return;
  }

  // Set state to not generating immediately to avoid duplicate notifications
  state.lastGenerating = false;
  tabGenerationState.set(tabId, state);

  const creds = await loadCredentials();
  if (!creds) return;

  // Retrieve the tab to parse conversation_id from its URL
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab || !tab.url) {
      // Fallback to last known conversation ID from state
      if (state.lastConversationId) {
        postJson(
          creds.apiBase,
          '/api/browser-chats/complete',
          { provider: 'chatgpt', conversation_id: state.lastConversationId },
          creds.token
        );
      }
      return;
    }

    try {
      const url = new URL(tab.url);
      const match = url.pathname.match(/\/c\/([^/?#]+)/i);
      const conversationId = match ? match[1].toLowerCase() : state.lastConversationId;
      if (conversationId) {
        postJson(
          creds.apiBase,
          '/api/browser-chats/complete',
          { provider: 'chatgpt', conversation_id: conversationId },
          creds.token
        );
      }
    } catch (_) {
      if (state.lastConversationId) {
        postJson(
          creds.apiBase,
          '/api/browser-chats/complete',
          { provider: 'chatgpt', conversation_id: state.lastConversationId },
          creds.token
        );
      }
    }
  });
}

chrome.webRequest.onCompleted.addListener(handleChatgptStreamComplete, chatgptFilter);
chrome.webRequest.onErrorOccurred.addListener(handleChatgptStreamComplete, chatgptFilter);

// ── Probe Logging Helper Functions & Tab Caching ──

const tabInfoCache = new Map();

async function isDebugLoggingEnabled() {
  const stored = await chrome.storage.local.get('taskAppChatWatchDebug');
  return !!stored['taskAppChatWatchDebug'];
}

async function getTabInfo(tabId) {
  if (tabInfoCache.has(tabId)) {
    return tabInfoCache.get(tabId);
  }
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve({ title: '', url: '' });
      } else {
        const info = { title: tab.title || '', url: tab.url || '' };
        tabInfoCache.set(tabId, info);
        resolve(info);
      }
    });
  });
}

// Track tab updates to keep tabInfoCache fresh
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tab.url && (tab.url.includes('chatgpt.com') || tab.url.includes('chat.openai.com') || tab.url.includes('claude.ai') || tab.url.includes('gemini.google.com'))) {
    const title = tab.title || '';
    const url = changeInfo.url || tab.url || '';
    tabInfoCache.set(tabId, { title, url });

    if (changeInfo.url && (await isDebugLoggingEnabled())) {
      const creds = await loadCredentials();
      if (creds) {
        await postJson(creds.apiBase, '/api/browser-chats/probe-log', {
          type: 'navigation',
          url: changeInfo.url,
          tabId,
          tabTitle: title,
          tabUrl: changeInfo.url,
          timestamp: new Date().toISOString()
        }, creds.token);
      }
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabInfoCache.delete(tabId);
});

// Intercept web requests for probe logging
const llmRequestFilter = {
  urls: [
    "https://chatgpt.com/*",
    "https://chat.openai.com/*",
    "https://claude.ai/*",
    "https://gemini.google.com/*"
  ]
};

chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    if (details.type !== 'xmlhttprequest' && details.type !== 'other') return;
    if (details.url.startsWith('http://127.0.0.1') || details.url.startsWith('http://localhost')) return;
    if (!(await isDebugLoggingEnabled())) return;

    const creds = await loadCredentials();
    if (!creds) return;

    const tabInfo = await getTabInfo(details.tabId);
    await postJson(creds.apiBase, '/api/browser-chats/probe-log', {
      type: 'web_request',
      event: 'request_before',
      method: details.method,
      url: details.url,
      requestId: details.requestId,
      resourceType: details.type,
      tabId: details.tabId,
      tabTitle: tabInfo.title || '',
      tabUrl: tabInfo.url || '',
      timestamp: new Date().toISOString()
    }, creds.token);
  },
  llmRequestFilter
);

chrome.webRequest.onCompleted.addListener(
  async (details) => {
    if (details.type !== 'xmlhttprequest' && details.type !== 'other') return;
    if (details.url.startsWith('http://127.0.0.1') || details.url.startsWith('http://localhost')) return;
    if (!(await isDebugLoggingEnabled())) return;

    const creds = await loadCredentials();
    if (!creds) return;

    const tabInfo = await getTabInfo(details.tabId);
    await postJson(creds.apiBase, '/api/browser-chats/probe-log', {
      type: 'web_request',
      event: 'request_response',
      method: details.method,
      url: details.url,
      requestId: details.requestId,
      resourceType: details.type,
      statusCode: details.statusCode,
      tabId: details.tabId,
      tabTitle: tabInfo.title || '',
      tabUrl: tabInfo.url || '',
      timestamp: new Date().toISOString()
    }, creds.token);
  },
  llmRequestFilter
);

chrome.webRequest.onErrorOccurred.addListener(
  async (details) => {
    if (details.type !== 'xmlhttprequest' && details.type !== 'other') return;
    if (details.url.startsWith('http://127.0.0.1') || details.url.startsWith('http://localhost')) return;
    if (!(await isDebugLoggingEnabled())) return;

    const creds = await loadCredentials();
    if (!creds) return;

    const tabInfo = await getTabInfo(details.tabId);
    await postJson(creds.apiBase, '/api/browser-chats/probe-log', {
      type: 'web_request',
      event: 'request_error',
      method: details.method,
      url: details.url,
      requestId: details.requestId,
      resourceType: details.type,
      error: details.error,
      tabId: details.tabId,
      tabTitle: tabInfo.title || '',
      tabUrl: tabInfo.url || '',
      timestamp: new Date().toISOString()
    }, creds.token);
  },
  llmRequestFilter
);

// === stream-signal: attribution + extra_signals (v3-browser-signals) ===
//
// The MAIN-world spoofer (extensions/chat-watch/spoofer.js) tees streamed response BODIES — which
// chrome.webRequest cannot read — and emits structural-only `chat-watch-stream-signal` events that
// the content script forwards here as `STREAM_SIGNAL`. Two jobs, both append-only (a second message
// listener so the existing CHAT_UPDATE/PAGE_CONSOLE_LOG handler is untouched):
//
//   (a) Attribution upgrade (the findings/10 §4 fix): when a stream signal carries a real
//       conversation_id (S1 ChatGPT stream_handoff frames, S5 Gemini c_<id>), record it as the
//       tab's AUTHORITATIVE conversation id — replacing the fragile tab-URL + lastConversationId
//       guess for ChatGPT/Gemini. Claude already carries its id in the request URL, so it doesn't
//       need this. We only sharpen attribution; the generating→done clock is unchanged.
//   (b) Recorder forward: POST the structural signal to /api/browser-chats/stream-signal so the
//       recorder can capture every observed stream signal into extra_signals (capture-everything).
//
// PRIVACY: the spoofer only reads bodies when the user opts in (taskAppChatWatchStreamSignals), and
// the payload here is structural ONLY (provider, conversation_id, turn_id, marker, endpoint family,
// method, t) — never message content.
// (The STREAM_SIGNAL listener implementing this is below the driver fence — see its end fence.)

// === driver command handler (v3-browser-driver) ===
//
// TEST-ONLY. Polls the dev server's /api/browser-chats/drive queue for "drive
// this tab" commands and relays each to the target tab's driver.js via
// chrome.tabs.sendMessage as a CHAT_DRIVE message. Command shape from the
// server: { id, tabId, provider, prompt, deepResearch }.
//
// GUARDRAIL: this only *sends prompts*. It never posts /complete and never
// inspects responses — production done-tracking stays the webRequest edge above.
//
// INERT BY DEFAULT: the poll loop does nothing unless the `taskAppChatWatchDriver`
// storage flag is on (the same flag driver.js checks). With the flag off — the
// normal/shipped state — we never poll, never drain, never message a tab.
//
// Command source: chose the dev-server /drive endpoint (GET drain) over a
// chrome.storage queue because the wave runner (scripts/browser_chat_drive.js)
// already talks to the dev server, so the harness enqueues with a single POST and
// the background drains it — no extra cross-context plumbing.
(() => {
  const DRIVER_FLAG = 'taskAppChatWatchDriver';
  const DRIVE_POLL_MS = 1000;

  function isDriverEnabled() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([DRIVER_FLAG], (stored) => {
          try { void chrome.runtime.lastError; } catch (_) {}
          resolve(!!(stored && stored[DRIVER_FLAG]));
        });
      } catch (_) {
        resolve(false);
      }
    });
  }

  // Resolve the target tab for a command. Prefer an explicit tabId; otherwise
  // pick the most-recently-accessed tab for the requested provider.
  function resolveTargetTab(command) {
    return new Promise((resolve) => {
      if (Number.isInteger(command.tabId) && command.tabId > 0) {
        chrome.tabs.get(command.tabId, (tab) => {
          if (chrome.runtime.lastError || !tab) resolve(null);
          else resolve(tab.id);
        });
        return;
      }
      const urlPatterns = {
        chatgpt: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
        claude: ['https://claude.ai/*'],
        gemini: ['https://gemini.google.com/*'],
      }[command.provider];
      if (!urlPatterns) { resolve(null); return; }
      chrome.tabs.query({ url: urlPatterns }, (tabs) => {
        if (chrome.runtime.lastError || !tabs || !tabs.length) { resolve(null); return; }
        const sorted = tabs.slice().sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
        resolve(sorted[0].id);
      });
    });
  }

  function sendMessageToTab(tabId, message) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message || 'sendMessage failed' });
        } else {
          resolve(response || { ok: false, error: 'no response from driver' });
        }
      });
    });
  }

  function sendDriveToTab(tabId, command) {
    // Deep research is toggled separately via chrome.debugger (trusted keys)
    // BEFORE this runs, so the content script just types the prompt + sends.
    return sendMessageToTab(tabId, {
      type: 'CHAT_DRIVE',
      prompt: command.prompt,
      deepResearch: false,
      modeOnly: !!command.modeOnly,
    });
  }

  // ── chrome.debugger TRUSTED keyboard deep-research toggle ────────────────────
  // The provider tools menus only respond to TRUSTED input; a content script's
  // synthetic dispatchEvent is ignored (verified live: synthetic Tab doesn't even
  // move focus). The extension's chrome.debugger API sends trusted CDP Input
  // events, per-tab, WITHOUT the tab needing to be frontmost — so this works for
  // background tabs and enables concurrent waves (arm each tab in turn; the long
  // generations overlap).
  //
  // KEYBOARD-ONLY sequence (the user's): focus the composer (content script),
  // then trusted Tab -> wait -> Tab -> wait -> Enter via Input.dispatchKeyEvent.
  // No clicks. We verify via the content script's CHECK_DEEP_RESEARCH afterward.
  const DEBUGGER_PROTOCOL = '1.3';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function debuggerAttach(tabId) {
    return new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL, () => {
        const err = chrome.runtime.lastError;
        if (err && !/already attached/i.test(err.message || '')) reject(new Error(err.message));
        else resolve();
      });
    });
  }

  function debuggerDetach(tabId) {
    return new Promise((resolve) => {
      chrome.debugger.detach({ tabId }, () => { try { void chrome.runtime.lastError; } catch (_) {} resolve(); });
    });
  }

  function sendCmd(tabId, method, params) {
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(`${method}: ${err.message}`));
        else resolve(result);
      });
    });
  }

  // Trusted key press via CDP. keyDown (+char for Enter) then keyUp.
  // opts.shift adds the Shift modifier (CDP modifier bit 8).
  async function cdpKey(tabId, key, opts = {}) {
    const map = {
      Tab: { windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab' },
      Enter: { windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter', text: '\r' },
      ArrowDown: { windowsVirtualKeyCode: 40, code: 'ArrowDown', key: 'ArrowDown' },
      ArrowUp: { windowsVirtualKeyCode: 38, code: 'ArrowUp', key: 'ArrowUp' },
    }[key] || {};
    const modifiers = opts.shift ? 8 : 0; // 8 = Shift
    await sendCmd(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers, ...map });
    if (map.text) await sendCmd(tabId, 'Input.dispatchKeyEvent', { type: 'char', modifiers, ...map });
    await sendCmd(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...map });
  }

  // Trusted text typing via CDP char events (one char at a time).
  async function cdpType(tabId, text) {
    for (const ch of String(text)) {
      await sendCmd(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch });
      await sendCmd(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    }
  }

  async function isDeepResearchEngaged(tabId, provider) {
    const r = await sendMessageToTab(tabId, { type: 'CHECK_DEEP_RESEARCH', provider });
    return !!(r && r.engaged);
  }

  async function readActiveElement(tabId, provider) {
    const r = await sendMessageToTab(tabId, { type: 'ACTIVE_ELEMENT', provider });
    if (!r || !r.ok) return 'unknown';
    return `${r.tag}[${r.ariaLabel || r.text || r.testId || r.role || ''}]${r.isComposer ? ' (composer)' : ''}`;
  }

  // TEST PROBE (Gemini/Claude): trusted Tab -> wait -> Tab, then report where
  // focus lands after each. No Enter, no selection — just observe the focus path.
  async function debuggerProbeTabFocus(tabId, provider) {
    let attached = false;
    try {
      await sendMessageToTab(tabId, { type: 'FOCUS_COMPOSER', provider });
      await sleep(150);
      await debuggerAttach(tabId);
      attached = true;

      const start = await readActiveElement(tabId, provider);
      await cdpKey(tabId, 'Tab');
      await sleep(400);
      const afterTab1 = await readActiveElement(tabId, provider);
      await cdpKey(tabId, 'Tab');
      await sleep(400);
      const afterTab2 = await readActiveElement(tabId, provider);

      const summary = `focus probe (${provider}): start=${start} | afterTab1=${afterTab1} | afterTab2=${afterTab2}`;
      console.log(`[chat-driver/probe] ${summary}`);
      return { ok: true, engaged: false, sent: false, error: summary };
    } catch (err) {
      return { ok: false, engaged: false, sent: false, error: String(err && err.message ? err.message : err) };
    } finally {
      if (attached) await debuggerDetach(tabId);
    }
  }

  // ── Per-provider DR-engage keystroke sequences (TRUSTED, validated live) ──────
  // Each navigates from the composer to the provider's Deep-research control,
  // selects it, and returns focus to the composer. No typing/sending here — the
  // caller types the prompt afterward. Assumes the debugger is already attached.
  async function engageDeepResearchKeys(tabId, provider) {
    if (provider === 'chatgpt') {
      // Shift+Tab (to +) -> Enter (open menu) -> ArrowDown x3 -> Enter (select).
      await cdpKey(tabId, 'Tab', { shift: true });
      await sleep(400);
      await cdpKey(tabId, 'Enter');
      await sleep(700);
      for (let i = 0; i < 3; i += 1) { await cdpKey(tabId, 'ArrowDown'); await sleep(200); }
      await cdpKey(tabId, 'Enter');
      await sleep(700);
      return;
    }
    if (provider === 'claude') {
      // Tab (to +) -> Enter (select +) -> ArrowDown x6 -> Enter -> Shift+Tab (back).
      await cdpKey(tabId, 'Tab');
      await sleep(400);
      await cdpKey(tabId, 'Enter');
      await sleep(700);
      for (let i = 0; i < 6; i += 1) { await cdpKey(tabId, 'ArrowDown'); await sleep(250); }
      await cdpKey(tabId, 'Enter');
      await sleep(700);
      await cdpKey(tabId, 'Tab', { shift: true });
      await sleep(400);
      return;
    }
    if (provider === 'gemini') {
      // Tab (to +) -> Enter (open +) -> Tab x6 -> Enter -> Shift+Tab x7 (back).
      await cdpKey(tabId, 'Tab');
      await sleep(400);
      await cdpKey(tabId, 'Enter');
      await sleep(700);
      for (let i = 0; i < 6; i += 1) { await cdpKey(tabId, 'Tab'); await sleep(250); }
      await cdpKey(tabId, 'Enter');
      await sleep(700);
      for (let i = 0; i < 7; i += 1) { await cdpKey(tabId, 'Tab', { shift: true }); await sleep(250); }
      await sleep(150);
      return;
    }
    throw new Error(`no DR-engage sequence for provider ${provider}`);
  }

  // Engage deep research via TRUSTED keyboard (per-provider sequence), then:
  //   - if opts.prompt: type it and press Enter to send;
  //   - else if opts.dummyText: type dummy text and DO NOT press Enter (probe).
  // All keystrokes are trusted CDP events, so this works on a background tab.
  // Returns { ok, engaged, sent, error }.
  async function debuggerDriveDeepResearch(tabId, provider, opts = {}) {
    let attached = false;
    try {
      const alreadyOn = await isDeepResearchEngaged(tabId, provider);

      // Focus the composer (known starting point) before navigating.
      await sendMessageToTab(tabId, { type: 'FOCUS_COMPOSER', provider });
      await sleep(150);

      await debuggerAttach(tabId);
      attached = true;

      if (!alreadyOn) {
        await engageDeepResearchKeys(tabId, provider);
      }

      const engaged = await isDeepResearchEngaged(tabId, provider);
      if (!engaged) {
        return { ok: false, engaged: false, sent: false, error: `deep research did not engage for ${provider}` };
      }

      let sent = false;
      let confirmed = null;
      if (typeof opts.prompt === 'string' && opts.prompt.trim()) {
        // Type the real prompt into the composer and send.
        await sendMessageToTab(tabId, { type: 'FOCUS_COMPOSER', provider });
        await sleep(150);
        await cdpType(tabId, opts.prompt);
        await sleep(400);
        await cdpKey(tabId, 'Enter'); // send
        await sleep(400);
        sent = true;

        // Gemini/Claude show a plan first and need a second click to actually
        // start the research run (Gemini "Start research", Claude "Confirm").
        // These are real <button>s, so the content script polls + clicks them
        // (no trusted input needed). ChatGPT has no such step.
        if (provider === 'gemini' || provider === 'claude') {
          const r = await sendMessageToTab(tabId, { type: 'CONFIRM_RESEARCH', provider, timeoutMs: 60000 });
          confirmed = !!(r && r.clicked);
        }
      } else if (typeof opts.dummyText === 'string') {
        // Probe mode: report where the sequence left focus, then ensure the
        // composer is focused (ChatGPT's sequence doesn't end there), type dummy
        // text, NO Enter.
        const where = await readActiveElement(tabId, provider);
        await sendMessageToTab(tabId, { type: 'FOCUS_COMPOSER', provider });
        await sleep(150);
        await cdpType(tabId, opts.dummyText);
        await sleep(300);
        const summary = `${provider} experiment: focus-after-sequence=${where}; DR engaged=${engaged}; typed dummy text into composer (no Enter)`;
        console.log(`[chat-driver/experiment] ${summary}`);
        return { ok: true, engaged: true, sent: false, error: summary };
      }

      return { ok: true, engaged: true, sent, confirmed, error: '' };
    } catch (err) {
      return { ok: false, engaged: false, sent: false, error: String(err && err.message ? err.message : err) };
    } finally {
      if (attached) await debuggerDetach(tabId);
    }
  }

  async function reportDriveResult(creds, command, tabId, result) {
    await postJson(creds.apiBase, '/api/browser-chats/drive/result', {
      id: command.id,
      tab_id: tabId,
      provider: command.provider,
      ok: !!(result && result.ok),
      submit_method: result && result.submitMethod ? result.submitMethod : '',
      deep_research_enabled: !!(result && result.deepResearchEnabled),
      error: result && result.error ? result.error : '',
    }, creds.token);
  }

  async function pollDriveQueueOnce() {
    if (!(await isDriverEnabled())) return;
    const creds = await loadCredentials();
    if (!creds) return;

    let data;
    try {
      const res = await fetch(`${creds.apiBase}/api/browser-chats/drive/pending`, {
        headers: { 'X-Browser-Chat-Token': creds.token },
      });
      if (!res.ok) return;
      data = await res.json();
    } catch (_) {
      return;
    }
    const commands = (data && data.commands) || [];
    for (const command of commands) {
      const tabId = await resolveTargetTab(command);
      if (!tabId) {
        await reportDriveResult(creds, command, null, { ok: false, error: 'no target tab' });
        continue;
      }
      await processDriveCommand(creds, command, tabId);
    }
  }

  // One drive command end-to-end:
  //  - modeOnly: toggle DR via trusted keys, stop, report (nothing sent).
  //  - deepResearch + prompt: ONE trusted keyboard flow — Shift+Tab -> Enter ->
  //    type "deep research" -> Enter (select) -> type prompt -> Enter (send).
  //  - plain prompt (no DR): relay CHAT_DRIVE so the content script types + sends.
  async function processDriveCommand(creds, command, tabId) {
    // modeOnly: engage DR via the per-provider trusted sequence, type dummy text,
    // no Enter (the toggle test). Same sequence used by the spec path below.
    if (command.modeOnly) {
      const dr = await debuggerDriveDeepResearch(tabId, command.provider, { dummyText: 'dummy text from driver' });
      await reportDriveResult(creds, command, tabId, {
        ok: !!dr.engaged,
        submitMethod: 'none',
        deepResearchEnabled: !!dr.engaged,
        error: dr.error || (dr.engaged ? '' : 'deep research did not engage'),
      });
      return;
    }

    // deepResearch + prompt: engage DR via the per-provider trusted sequence, then
    // type the real prompt and Enter to send — all trusted, works per provider.
    if (command.deepResearch) {
      const dr = await debuggerDriveDeepResearch(tabId, command.provider, { prompt: command.prompt });
      // Gemini/Claude need the post-send confirm/start click; chatgpt does not.
      const needsConfirm = command.provider === 'gemini' || command.provider === 'claude';
      const confirmOk = needsConfirm ? dr.confirmed === true : true;
      const confirmNote = needsConfirm
        ? `; research ${dr.confirmed ? 'started (confirm clicked)' : 'NOT started (confirm/start button not clicked)'}`
        : '';
      await reportDriveResult(creds, command, tabId, {
        ok: !!(dr.engaged && dr.sent && confirmOk),
        submitMethod: dr.sent ? 'trusted_enter' : 'none',
        deepResearchEnabled: !!dr.engaged,
        error:
          (dr.error || (!dr.engaged ? 'deep research did not engage' : (!dr.sent ? 'prompt not sent' : ''))) +
          confirmNote,
      });
      return;
    }

    // Plain prompt, no deep research: content script types + sends.
    const sendRes = await sendDriveToTab(tabId, command);
    await reportDriveResult(creds, command, tabId, {
      ...sendRes,
      deepResearchEnabled: false,
      error: sendRes && sendRes.error ? sendRes.error : '',
    });
  }

  // Lightweight polling loop. setInterval in an MV3 service worker is best-effort
  // (the worker may sleep), which is fine for a test driver: each wake drains
  // whatever's queued.
  setInterval(() => { pollDriveQueueOnce().catch(() => {}); }, DRIVE_POLL_MS);
})();
// === end driver command handler (v3-browser-driver) ===

/** @type {Map<number, string>} tabId -> authoritative conversation id from the stream body. */
const tabStreamConversationId = new Map();

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStreamConversationId.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'STREAM_SIGNAL') return false;
  const tabId = sender.tab && sender.tab.id;
  if (!tabId) {
    sendResponse({ ok: false, error: 'no tab' });
    return false;
  }

  const p = message.payload || {};
  const provider = p.provider;
  if (provider !== 'chatgpt' && provider !== 'claude' && provider !== 'gemini') {
    sendResponse({ ok: false, error: 'unknown provider' });
    return false;
  }
  const conversation_id =
    typeof p.conversation_id === 'string' ? p.conversation_id.trim().toLowerCase() : '';

  // (a) Promote the stream conversation_id to the tab's authoritative id for ChatGPT/Gemini.
  if (conversation_id && (provider === 'chatgpt' || provider === 'gemini')) {
    tabStreamConversationId.set(tabId, conversation_id);
    const state = tabGenerationState.get(tabId);
    if (state) {
      state.lastConversationId = conversation_id;
      tabGenerationState.set(tabId, state);
    }
  }

  // (b) Forward the structural signal to the recorder endpoint.
  (async () => {
    const creds = await loadCredentials();
    if (!creds) {
      sendResponse({ ok: false, error: 'Orchestra not reachable' });
      return;
    }
    await postJson(
      creds.apiBase,
      '/api/browser-chats/stream-signal',
      {
        tab_id: tabId,
        provider,
        conversation_id,
        turn_id: typeof p.turn_id === 'string' ? p.turn_id : '',
        marker: typeof p.marker === 'string' ? p.marker : '',
        endpoint: typeof p.endpoint === 'string' ? p.endpoint : '',
        method: typeof p.method === 'string' ? p.method : '',
        t: typeof p.t === 'number' ? p.t : Date.now(),
      },
      creds.token
    );
    sendResponse({ ok: true });
  })();
  return true; // async response
});
// === end stream-signal fence (v3-browser-signals) ===
