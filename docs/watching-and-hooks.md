# Watching and hooks

Orchestra can mark tasks **waiting** and optionally attach a **watcher** that clears waiting when the agent or process finishes.

## Basic flow

1. Click **waiting** to mark waiting without a watcher (click again to clear).
2. (Optional) Set **Remote watch host** and **Remote Cursor projects root** in project settings for SSH features.
3. Click **watching** on a non-done task and pick a source (Cursor, terminal process, browser chat, and more).
4. The task shows a badge (`Cursor`, `Process`, `ChatGPT`, and so on) and auto-clears when the watcher completes.
5. Choose **Waiting only (no watcher)** to stay waiting without auto-clear, or click **×** on the badge to stop auto-clear while staying waiting.

## Cursor watching (hooks)

Cursor watching is **hook-based**. Install local or remote Cursor hooks first; the picker lists recent hook events and hides transcript-only chats.

1. Get token + base URL: `GET /api/cursor-hooks/config` → `{ token, apiBase }`.
2. In your hook script, set `CURSOR_HOOK_TOKEN` (from that endpoint or from `.env`) and `CURSOR_HOOK_API_BASE` (for example `http://127.0.0.1:47823`).
3. Recommended hook events: `beforeSubmitPrompt`, `sessionStart`, `stop` or `sessionEnd`.

Minimal forwarder:

```bash
#!/bin/bash
set +e
payload="$(cat)"
curl -sS -X POST "${CURSOR_HOOK_API_BASE}/api/cursor-hooks/event" \
  -H "Content-Type: application/json" \
  -H "X-Cursor-Hook-Token: ${CURSOR_HOOK_TOKEN}" \
  -d "$payload" >/dev/null 2>&1 || true
exit 0
```

Example `~/.cursor/hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [{ "command": "~/hooks/cursor-forward.sh" }],
    "sessionStart": [{ "command": "~/hooks/cursor-forward.sh" }],
    "stop": [{ "command": "~/hooks/cursor-forward.sh" }]
  }
}
```

Use `POST /api/cursor-hooks/install-local` or `POST /api/projects/:id/cursor-hooks/install-remote` from the app to install scripts. Remote hook polling needs passwordless SSH (for example `ssh my-host true`).

## Process watching

Uses PID checks (`ps -p <pid>` locally or over SSH). With **Cursor Workspaces** configured, terminal pickers can filter to processes whose cwd is under those paths (`lsof` locally; `lsof` over SSH on remotes).

## Browser chat watching

Uses the **Orchestra Chat Watch** Chrome extension (`extensions/chat-watch/`). Install the unpacked extension, keep Orchestra running, and pick a tab or paste a chat URL. Optional: set `BROWSER_CHAT_TOKEN` in the environment. See the extension README for privacy details.

Supported providers in the UI include ChatGPT, Claude, and Gemini in the browser.

## Claude Code hooks

- `POST /api/claude-hooks/install-local` — merges hook entries into `~/.claude/settings.json`.
- `POST /api/projects/:id/claude-hooks/install-remote` — installs on SSH hosts in the project remote list. Set `CLAUDE_HOOK_API_BASE` / `CLAUDE_HOOK_TOKEN` on remotes so events reach `POST /api/claude-hooks/event`.

## Codex and Gemini hooks

Same pattern: config endpoints return `{ token, apiBase }`; hook scripts use `CODEX_HOOK_TOKEN` or `GEMINI_HOOK_TOKEN`. Install via the in-app hook installers or your own forwarder scripts.

## macOS Notification Center watcher (experimental)

An API path can watch ChatGPT/Claude via Notification Center (`kind: "notification"`). This reads the Notification Center database and requires **Full Disk Access**. Treat it as experimental; prefer browser extension or hook-based watching when possible.

## Remote SSH watching (experimental)

Remote Cursor runs, remote terminal processes, and remote hook installers run commands over SSH on hosts you configure. Only enable this if you understand what the server can read and execute on those machines.

## Maintainer probes

Scripts such as `npm run cowork:probe` and `*-diff-probe` read local agent files for debugging. They are for development, not part of the normal user workflow.
