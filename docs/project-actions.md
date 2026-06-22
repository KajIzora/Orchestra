# Project actions

Each project has one project-level launch action and optional task-level focus actions:

- **Open Workspace** — opens or raises the project's working environment: Cursor folders, Chrome tabs, Obsidian notes, apps/files, Mission Control desktops, and custom shell commands.
- **Task Focus** — optional per-task launch targets for focusing only the context needed by that task.

Commands run in your shell with a 5-second timeout each. Multiple targets run in parallel so windows can appear together. The final frontmost window can vary by which command finishes last.

For **Open Workspace** and **Task Focus**, if the first target is a Desktop switch,
Orchestra runs that switch first, waits briefly for macOS Spaces to settle, then
runs the remaining targets in parallel.

The legacy `POST /api/projects/:id/focus` endpoint is kept for compatibility and now runs the same canonical workspace targets as **Open Workspace**.

> **Security.** These commands run as shell commands on your Mac. The UI does not sanitize them. Orchestra is meant for localhost-only use on a machine you control — write commands deliberately.

## Examples

- `code ~/projects/video-pipeline` — VS Code opens or focuses that folder.
- `cursor ~/projects/app-ui` — same for Cursor.
- `open -a "Figma" "figma://file/abc123"` — opens a Figma file.
- `open https://github.com/me/repo/pulls` — opens a URL in the default browser.
- `open "obsidian://open?vault=Work&file=Projects/orchestra"` — opens an Obsidian note.
- `osascript -e 'tell app "iTerm" to activate'` — custom AppleScript.

## Launch target types

- **Cursor project** — opens or raises the specific local or remote SSH Cursor folder window.
- **Chrome page** — opens the URL or focuses an existing tab.
- **App / file** — opens an app, optionally with a file, folder, or URL.
- **Obsidian note** — vault + note path via an `obsidian://` URL.
- **Desktop** — switches to Desktop 1–10 using your Mission Control shortcut.
- **Custom shell** — escape hatch for custom setup; give it a short label so the UI does not have to show the full script.

Mark **Raise last** on an item to include an extra launch command for that item after the target list is built. Because commands run in parallel, exact final focus order is not guaranteed.

## Default launch command presets

Older projects may still have `launch_command` / `launch_commands`. The server treats those fields as legacy and folds them into custom workspace targets when it normalizes project state.

In target editors, generated command previews are available under **Command preview**. They are hidden by default so long scripts act as implementation details instead of the main label.

## Default command presets

Legacy command fields can still use presets such as:

- **Focus chrome web page** — Chrome AppleScript focus for a URL you enter.
- **Focus Cursor Project** — raises only that project's Cursor window (see "Single-window Cursor focus" below).
- **Focus Remote Cursor** — same single-window raise for a remote SSH folder.
- **Open App** — `open -a <app>` with optional target.
- **Open Window** — Mission Control desktop switch via `osascript`.

### Single-window Cursor focus

The **Focus Cursor Project** and **Focus Remote Cursor** presets do not run a plain
`cursor <folder>`. A plain `cursor`/`open -a Cursor` activates the *whole* Cursor app,
which pulls **every** Cursor window forward — so focusing one project also drags your
other open Cursor projects on top of whatever else you were using.

Instead these presets generate a command that raises **only** the matching window:

```
[ "$(osascript -e 'tell application "System Events"' … -e 'perform action "AXRaise" of (item 1 of theWindows)' …)" = raised ] || cursor '<folder>'
```

- It finds the Cursor window whose **title ends with the project's folder name** and
  raises just that one window with the macOS Accessibility action `AXRaise` — the
  other Cursor windows stay where they are. Cursor titles windows
  `<active file> — <folder>`, so matching the folder at the *end* of the title (not
  anywhere in it) avoids wrongly matching another project that merely has a file
  open whose name contains your folder name (e.g. `flow-matching-ot.gif`).
- If no matching window is open yet (cold start), it falls back to `cursor <folder>`
  (or `cursor --remote …`) to open it.

This applies to task focus and any legacy project command that still uses these presets.

**Requirements / caveats:**

- The app running the command (the Electron desktop app) needs **System Settings →
  Privacy & Security → Accessibility** permission. Without it the raise silently fails
  and it falls back to opening the folder.
- Matching is by the folder name at the end of the window title. If two Cursor
  windows have folders with the same name, the first match wins; if you've customized
  `window.title` so the folder name isn't at the end, the match can miss and it falls
  back to opening.
- Existing saved legacy commands are folded into custom targets when project or
  task state is normalized.

## Troubleshooting launch commands

- **`code` not on PATH.** In VS Code: Command Palette → **Shell Command: Install 'code' command in PATH**.
- **AppleScript / Automation.** Commands that drive other apps via `System Events` may prompt for Accessibility or Automation permission the first time. Simple `code <path>` / `open` commands usually do not.
- **Duplicate folders.** Two projects with the same `code ~/same-folder` share one VS Code window — that is expected.
