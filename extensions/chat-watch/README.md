# Orchestra Chat Watch (Chrome extension)

Syncs **ChatGPT**, **Claude**, and **Gemini** browser tabs to [Orchestra](../../README.md) so tasks can use **Watch ChatGPT / Claude / Gemini** and return from **waiting** to open when the model finishes generating in the linked conversation.

## Requirements

1. Orchestra server running (`npm start` or the desktop app). The extension discovers the port by probing `47823`–`47830` on `127.0.0.1`.
2. Chrome (or another Chromium browser that loads unpacked MV3 extensions).

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. **Load unpacked** and select this folder: `extensions/chat-watch`.
4. Pin the extension if you want quick access to the inspector popup.

## Privacy

This extension only runs on supported AI chat sites:

- `chatgpt.com` and `chat.openai.com`
- `claude.ai`
- `gemini.google.com`

It does **not** request broad host access (no `<all_urls>`). Local Orchestra access is limited to `http://127.0.0.1/*` and `http://localhost/*` for API calls.

### What the extension reads on those pages

The content script observes the open chat page DOM to detect generating vs idle (Stop buttons, research indicators, completion landmarks, etc.). It does not read cookies, passwords, or unrelated tabs.

### What it sends to Orchestra (local server only)

Snapshots are posted to your **local** Orchestra instance (`POST /api/browser-chats/snapshot`) with header `X-Browser-Chat-Token`. Typical fields include:

| Field | Purpose |
| --- | --- |
| Tab URL | Link back to the conversation |
| Page title | Display in Orchestra |
| Provider + conversation id | Match a watched task |
| Generating / completion / failure signals | Drive wait → open behavior |
| Activity summary | Short label derived from visible status text (not full page text) |

**Prompt previews are opt-in.** By default, `last_user_preview` is **not** sent. If you enable **Send prompt previews** in the extension popup, Orchestra may receive up to **240 characters** from the latest user message (or draft input on Gemini) to help identify which chat is linked.

Tab close, completion, and explicit cancel events use the same local API (`tab-closed`, `complete`, `cancel`). Nothing is sent to third-party servers by this extension.

### Logging

By default the extension is **quiet** in the page console. Enable **Debug logging** in the popup to print snapshot tables (`[chat-watch]` prefix) while developing. You can also call `window.__taskAppChatWatchInspect()` from DevTools when debug logging is on.

## What it does

- Injects a content script on `chatgpt.com`, `chat.openai.com`, `claude.ai`, and `gemini.google.com`.
- Detects **generating** vs idle (Stop controls on ChatGPT; on Claude deep research, open conversation + no Stop response + visible “Research complete”; on Gemini deep research, `used-sources-button`, `message-content`, and `export-menu-button` together mean done).
- POSTs tab snapshots to `POST /api/browser-chats/snapshot` with header `X-Browser-Chat-Token` (token comes from `GET /api/browser-chats/config` when the server is up).
- When a tab goes from generating → idle, POSTs `POST /api/browser-chats/complete` so any task watching that `provider` + `conversation_id` clears to done.
- When ChatGPT, Claude, or Gemini fires its explicit cancel signal, POSTs `POST /api/browser-chats/cancel` so the task clears back to the blank monitor pill.
- On tab close, notifies `POST /api/browser-chats/tab-closed` so stale tab entries are removed.

## Inspector popup

Click the extension icon on an AI tab to inspect signals, toggle **Debug logging** and **Send prompt previews**, and view a JSON snapshot in the popup. With debug logging enabled, DevTools-style tables also appear in the page console.

## Optional: fixed auth token

Set environment variable `BROWSER_CHAT_TOKEN` before starting Orchestra so the token does not change on each server restart. The extension caches token + API base in `chrome.storage.local`; clear extension storage if you rotate the token.

## Files

- `manifest.json` — MV3 manifest, host permissions for AI sites and `http://127.0.0.1/*`.
- `background.js` — service worker: credentials, snapshots, completion edge detection.
- `privacy-settings.js` — shared prompt-preview limits (loaded before the content script).
- `content-chatgpt.js` — page instrumentation (name kept for history).
- `popup.html` / `popup.js` — inspector UI and privacy toggles.
- `claude-watch-signals.js` / `gemini-watch-signals.js` — provider-specific deep-research heuristics.
