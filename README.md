# Orchestra

Orchestra is a **local-only macOS app** for tracking parallel work across projects — especially tasks that are **waiting on an AI agent**, a build, or another long-running process. One user, one machine: data stays in a JSON file under your home directory.

## Quick start

**Requirements:** macOS, [Node.js](https://nodejs.org/) 22.12 or newer.

```bash
git clone https://github.com/KajIzora/Orchestra.git orchestra
cd orchestra
nvm use
npm install
npm start
```

Open the URL printed in the terminal (usually `http://127.0.0.1:47823`). If you use the optional menu-bar helper, click the ⏳ icon → **Open Orchestra**.

**Desktop window (Electron):**

```bash
npm run desktop:dev
```

This opens a native window on the same local backend. If you already started `npm start` or `./start.sh`, the desktop app attaches to that server instead of starting a second one.

Optional: copy [`.env.example`](.env.example) to `.env` to set port, host, or hook tokens. The server loads `.env` automatically when started from this repo; exported shell or launchd variables take precedence. See [Environment variables](#environment-variables).


## What Orchestra does

- Project sidebar with tasks, todo / waiting / done, and drag reorder.
- **Open Workspace** and task **Focus** — run your own launch targets to open apps, editors, URLs, and task-specific context ([details](docs/project-actions.md)).
- Optional **watching** — link a task to a Cursor hook, terminal PID, or browser tab so **waiting** clears when work finishes ([details](docs/watching-and-hooks.md)).
- Optional menu-bar badge (Python + `rumps`) showing how many tasks are waiting.

> **Important.** Open Workspace, task Focus, and some watcher features run **shell commands and scripts on your Mac** (and optionally over SSH). You choose those commands. Orchestra does not sandbox them. Only run Orchestra on a machine you trust, and bind it to localhost when possible.

## Privacy model

- **Local-first.** Task data is stored in `~/.agent-task-tracker/data.json` on your Mac. There is no Orchestra cloud account or hosted backend.
- **No built-in login.** The app is designed for `127.0.0.1` (or a host you set). Anyone who can reach the server port on your network could use the API — treat open network binding as a security risk.
- **You control integrations.** Hooks and the Chrome extension send events to your local server only. Remote SSH features read and run commands on hosts you configure.
- **Optional tokens.** Hook and browser-extension tokens can be pinned via environment variables (see `.env.example`) or auto-generated under `~/.agent-task-tracker/hook-tokens.json`.
- **Sensitive endpoints.** Config routes return hook tokens for setup; keep the server on localhost and do not expose it through tunnels you do not trust.

## What Orchestra will not do

- Sync tasks across devices or users.
- Authenticate users or enforce multi-tenant access control.
- Run in the browser on non-macOS platforms (the server is Node; the polished UI target is macOS).
- Sanitize or approve your Open Workspace / task Focus shell commands.
- Guarantee agent completion detection without the right hook, extension, or process watcher configured.

## Supported platforms

| Component | Supported |
| --------- | --------- |
| Orchestra server + web UI | macOS with Node 22.12+ |
| Menu-bar helper | macOS with Python 3 and `pip3 install rumps` (optional) |
| Electron desktop app | macOS (build with `npm run desktop:build` or `./rebuild.sh`) |
| Chrome chat watcher | Chrome on macOS (unpacked extension) |

Linux or Windows may run parts of the Node server for development, but the MVP is aimed at **macOS** as the daily driver.

## Feature tiers

### Stable (MVP core)

- Local projects and tasks, waiting/done, reorder, colors.
- Data persisted under `~/.agent-task-tracker/`.
- Browser UI via `npm start`, `./start.sh`, or `node server.js`.
- Electron desktop via `npm run desktop:dev`.
- Manual **Open Workspace** and task **Focus** launch targets you author.

### Optional / advanced

- **Browser chat watcher** — Chrome extension talking to localhost.
- **Local process watcher** — PID-based auto-clear.
- **Local agent hooks** — Cursor, Codex, Claude Code, Gemini hook forwarders and in-app installers.

### Experimental

Use only if you accept extra permissions, SSH access, or incomplete polish:

- Remote SSH watchers and remote hook installers.
- macOS **Notification Center** watcher (Full Disk Access).

## Run modes

### Browser + menu bar (recommended for first run)

```bash
./start.sh
```

Starts the Node backend and, if `rumps` is installed, the menu-bar helper. Open the UI from the menu or the URL in the terminal.

### Backend only

```bash
npm start
# same as: node server.js
```

### Desktop (Electron)

```bash
npm run desktop:dev
```

- If a backend is already running, Electron **attaches** to it.
- If not, Electron starts `server.js` for you. Quitting Electron stops only that child process — not a server you started separately with `./start.sh`.

### Dev + stable on one Mac (recommended)

Keep a **stable desktop app** for daily use and a **dev server** in the browser for agents and rapid resets. They use separate data directories and ports.

```bash
./stable-update.sh              # install /Applications/Orchestra.app → ~/.orchestra/stable, port 47824
HOST=0.0.0.0 ./stable-update.sh # same, with LAN host baked in
./dev-start.sh                    # dev backend → ~/.orchestra/dev, port 47823 (browser UI)
./dev-reset.sh                    # stop dev and optionally wipe dev data
```

Agents should use `ORCHESTRA_API_BASE=http://127.0.0.1:47823`.

### Build a distributable app

```bash
npm run desktop:build    # .dmg under dist/
npm run desktop:pack     # unpacked .app under dist/ only
./rebuild.sh             # refresh icons from assets/, then pack to dist/
HOST=0.0.0.0 ./rebuild.sh # bake a network-visible host into the built app
./rebuild.sh --install-applications   # also replace /Applications/Orchestra.app
./stable-update.sh       # preferred: stable profile + install (see dual-instance doc)
```

There is **no** `Orchestra.app` checked into this repo. Use the Electron commands above; the built bundle lives under `dist/mac-arm64/Orchestra.app` or `dist/mac/Orchestra.app`. Drag that app to Applications or the Dock if you want a system-wide shortcut.

If the desktop app bounces in the Dock with no window, check `~/.agent-task-tracker/electron-desktop.log`.

## Data and config

| Path | Purpose |
| ---- | ------- |
| `~/.agent-task-tracker/data.json` | Projects and tasks |
| `~/.agent-task-tracker/config.json` | Port/host written at startup (for menu-bar helper) |
| `~/.agent-task-tracker/hook-tokens.json` | Auto-generated hook tokens if env vars unset |
| `~/.agent-task-tracker/electron-desktop.log` | Desktop startup log |

If `data.json` is corrupted, the server renames it to `data.json.corrupt-<timestamp>` and starts fresh.

## Environment variables

Optional. Copy [`.env.example`](.env.example) to `.env` and uncomment what you need. `npm start`, `./start.sh`, and `npm run desktop:dev` load `.env` automatically from the repo root; environment variables already exported by your shell or launchd plist override `.env` values.

| Variable | Purpose |
| -------- | ------- |
| `ORCHESTRA_DATA_DIR` | State folder (`data.json`, `config.json`; default `~/.agent-task-tracker`) |
| `PORT` | HTTP port (default `47823`) |
| `HOST` | Bind address (set `127.0.0.1` to avoid LAN exposure) |
| `BROWSER_CHAT_TOKEN` | Pin Chrome extension auth token |
| `CURSOR_HOOK_TOKEN` | Pin Cursor hook token |
| `CODEX_HOOK_TOKEN` | Pin Codex hook token |
| `CLAUDE_HOOK_TOKEN` | Pin Claude Code hook token |
| `GEMINI_HOOK_TOKEN` | Pin Gemini hook token |

## Keyboard shortcuts

- `⌘1`–`⌘9` — focus project by sidebar order.
- `Enter` in new-task field — create task.
- Click task text — inline edit (`Enter` save, `Escape` cancel).

## Troubleshooting

| Problem | What to try |
| ------- | ----------- |
| Port already in use | Server picks the next free port; read the log line or `~/.agent-task-tracker/config.json`. |
| Menu-bar icon missing | `pip3 install rumps`, or use the browser URL without the helper. |
| `code` / `cursor` not found | Install the shell command from the editor (VS Code: **Shell Command: Install 'code' command in PATH**). |
| Cursor watcher empty | Open an agent chat in Cursor on that machine; install local hooks (`POST /api/cursor-hooks/install-local` or app UI). |
| Remote watcher fails | Ensure passwordless SSH works: `ssh your-host true`. |
| Desktop window blank | Read `~/.agent-task-tracker/electron-desktop.log`; rebuild with current `electron/main.cjs`. |
| Extension cannot connect | Server must be running on localhost; check `BROWSER_CHAT_TOKEN` matches extension config. |

More detail: [Project actions](docs/project-actions.md), [Watching and hooks](docs/watching-and-hooks.md), [API reference](docs/api-reference.md).

## Auto-start at login (optional)

Template: [`launchd/com.user.agenttasktracker.plist`](launchd/com.user.agenttasktracker.plist). **Not installed automatically.**

1. Copy to `~/Library/LaunchAgents/com.user.agenttasktracker.plist`.
2. Replace `REPLACE_ME` with the absolute path to this repo.
3. `launchctl load ~/Library/LaunchAgents/com.user.agenttasktracker.plist`

Unload with `launchctl unload` on the same path.

## Project layout

```
orchestra/
├── README.md
├── docs/                     # API, watching, project actions
├── start.sh                  # backend + optional menu bar
├── server.js
├── electron/                 # desktop shell
├── lib/                      # server modules
├── public/                   # web UI
├── extensions/chat-watch/    # Chrome extension
├── menubar.py
├── rebuild.sh                # icon refresh + desktop pack
└── launchd/                  # LaunchAgent template
```

## License

[MIT](LICENSE)
