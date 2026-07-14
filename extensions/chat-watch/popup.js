const STORAGE_KEYS = {
  debug: 'taskAppChatWatchDebug',
  sendPromptPreviews: 'taskAppChatWatchSendPromptPreviews',
  // FollowUps §3.3: stream the assistant's message text into Orchestra. Default OFF.
  streamBody: 'taskAppChatWatchStreamBody',
};

const inspectButton = document.getElementById('inspect');
const debugToggle = document.getElementById('debug-toggle');
const promptPreviewToggle = document.getElementById('prompt-preview-toggle');
const streamBodyToggle = document.getElementById('stream-body-toggle');
const statusEl = document.getElementById('status');
const summaryEl = document.getElementById('summary');
const jsonEl = document.getElementById('json');

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function renderSummary(snapshot) {
  summaryEl.innerHTML = '';

  const dl = document.createElement('dl');
  const preview = (snapshot.last_user_preview || '').trim();
  const rows = [
    ['Provider', snapshot.providerLabel || snapshot.provider],
    ['Generating', snapshot.generating ? 'yes' : 'no'],
    ['Completion signal', snapshot.completionSignal ? 'yes' : 'no'],
    [
      'Gemini report complete',
      snapshot.provider === 'gemini'
        ? snapshot.geminiDeepResearch?.deepResearchReportComplete
          ? 'yes'
          : 'no'
        : 'n/a',
    ],
    [
      'Claude research complete',
      snapshot.provider === 'claude'
        ? snapshot.claudeDeepResearch?.deepResearchReportComplete
          ? 'yes'
          : 'no'
        : 'n/a',
    ],
    ['Conversation', snapshot.conversationId || '(not detected)'],
    ['Messages', String(snapshot.messageCount)],
    ['Buttons', String(snapshot.visibleButtonCount)],
    ['Stop buttons', String(snapshot.stopButtonCandidates.length)],
    ['Activity indicators', String((snapshot.activityIndicators || []).length)],
    ['Send buttons', String(snapshot.sendButtonCandidates.length)],
    ['Landmarks', String((snapshot.landmarks || []).length)],
    [
      'Last user preview',
      preview ? preview.slice(0, 120) : '(not sent — enable in settings above)',
    ],
    ['URL', snapshot.url],
  ];

  rows.forEach(([label, value]) => {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value;
    dl.append(dt, dd);
  });

  summaryEl.appendChild(dl);
}

async function loadSettings() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.debug,
    STORAGE_KEYS.sendPromptPreviews,
    STORAGE_KEYS.streamBody,
  ]);
  debugToggle.checked = !!stored[STORAGE_KEYS.debug];
  promptPreviewToggle.checked = !!stored[STORAGE_KEYS.sendPromptPreviews];
  streamBodyToggle.checked = !!stored[STORAGE_KEYS.streamBody];
}

async function saveSetting(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function inspectCurrentTab() {
  inspectButton.disabled = true;
  jsonEl.hidden = true;
  jsonEl.textContent = '';
  summaryEl.innerHTML = '';
  setStatus('Inspecting current tab...');

  try {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      throw new Error('No active tab found.');
    }

    if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com|claude\.ai|gemini\.google\.com)\//i.test(tab.url || '')) {
      throw new Error('This extension currently inspects ChatGPT, Claude, and Gemini tabs.');
    }

    const response = await chrome.tabs.sendMessage(tab.id, { type: 'CHAT_WATCH_INSPECT' });
    if (!response || !response.ok || !response.snapshot) {
      throw new Error('No inspector response received from the page.');
    }

    const debugOn = debugToggle.checked;
    setStatus(
      debugOn
        ? `Snapshot captured. Check the ${response.snapshot.providerLabel || 'AI chat'} tab console for tables.`
        : 'Snapshot captured. Enable debug logging above to print tables in the page console.'
    );
    renderSummary(response.snapshot);
    jsonEl.textContent = JSON.stringify(response.snapshot, null, 2);
    jsonEl.hidden = false;
  } catch (err) {
    if (err.message && err.message.includes('Receiving end does not exist')) {
      setStatus('Content script not loaded. Try refreshing the page to inject the tracker.', true);
    } else {
      setStatus(err.message || String(err), true);
    }
  } finally {
    inspectButton.disabled = false;
  }
}

debugToggle.addEventListener('change', () => {
  saveSetting(STORAGE_KEYS.debug, debugToggle.checked).catch((err) => {
    setStatus(err.message || String(err), true);
  });
});

promptPreviewToggle.addEventListener('change', () => {
  saveSetting(STORAGE_KEYS.sendPromptPreviews, promptPreviewToggle.checked).catch((err) => {
    setStatus(err.message || String(err), true);
  });
});

streamBodyToggle.addEventListener('change', () => {
  saveSetting(STORAGE_KEYS.streamBody, streamBodyToggle.checked).catch((err) => {
    setStatus(err.message || String(err), true);
  });
});

inspectButton.addEventListener('click', inspectCurrentTab);

loadSettings()
  .then(() => inspectCurrentTab())
  .catch((err) => setStatus(err.message || String(err), true));
