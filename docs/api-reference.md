# API reference

All endpoints return JSON. Errors are `{ "error": "message" }` with an appropriate HTTP status.

The server listens on `http://127.0.0.1:<port>` (or the host/port you configured). There is no built-in login; keep the server bound to localhost.

| Method   | Path                                      | Body                              |
| -------- | ----------------------------------------- | --------------------------------- |
| `GET`    | `/api/state`                              | —                                 |
| `POST`   | `/api/projects`                           | `{ name, workspace_items?, workspace_commands?, launch_command?, launch_commands?, color?, cursor_remote_host?, cursor_remote_projects_root?, cursor_remote? }` |
| `PATCH`  | `/api/projects/:id`                       | Partial project fields            |
| `DELETE` | `/api/projects/:id`                       | —                                 |
| `POST`   | `/api/projects/reorder`                   | `{ ids: [...] }`                  |
| `POST`   | `/api/projects/:id/tasks`                 | `{ text, is_agent?, focus_items?, focus_commands? }` |
| `PATCH`  | `/api/projects/:id/tasks/:taskId`         | Partial task fields, including `focus_items` / `focus_commands` |
| `DELETE` | `/api/projects/:id/tasks/:taskId`         | —                                 |
| `POST`   | `/api/projects/:id/tasks/reorder`         | `{ ids: [...] }`                  |
| `POST`   | `/api/projects/:id/tasks/:taskId/focus`   | —                                 |
| `POST`   | `/api/projects/:id/focus`                 | —                                 |
| `POST`   | `/api/projects/:id/workspace`             | —                                 |
| `GET`    | `/api/cursor/runs`                        | — (legacy/debug transcript discovery; not used by the watcher picker) |
| `GET`    | `/api/projects/:id/cursor-runs`           | — (lists local/remote Cursor hook rows for that project) |
| `GET`    | `/api/cursor-hooks/config`                | `{ token, apiBase }` for Cursor hook forwarding |
| `GET`    | `/api/cursor-hooks/status`                | Optional `project_id` query; returns local/remote hook install status |
| `POST`   | `/api/cursor-hooks/event`                 | Header `X-Cursor-Hook-Token`: Cursor hook event payload |
| `POST`   | `/api/cursor-hooks/install-local`         | Installs/updates `~/.cursor/hooks.json` + local hook script |
| `POST`   | `/api/projects/:id/cursor-hooks/install-remote` | Installs/updates remote hook script + hooks config over SSH |
| `GET`    | `/api/claude-hooks/config`                | `{ token, apiBase }` for Claude hook forwarding |
| `GET`    | `/api/claude-hooks/status`                | Optional `project_id`; local install flag + remote host list |
| `POST`   | `/api/claude-hooks/install-local`         | Writes Claude hook script and merges into `~/.claude/settings.json` |
| `POST`   | `/api/projects/:id/claude-hooks/install-remote` | Copies settings + hook script to remote hosts over SSH |
| `POST`   | `/api/claude-hooks/event`                 | Header `X-Claude-Hook-Token`: Claude Code hook payload |
| `GET`    | `/api/codex-hooks/config`                 | `{ token, apiBase }` for Codex hook forwarding |
| `POST`   | `/api/codex-hooks/event`                  | Header `X-Codex-Hook-Token`: Codex hook payload |
| `GET`    | `/api/gemini-hooks/config`                | `{ token, apiBase }` for Gemini hook forwarding |
| `POST`   | `/api/gemini-hooks/event`                 | Header `X-Gemini-Hook-Token`: Gemini hook payload |
| `GET`    | `/api/processes/local`                    | Query: `include_all?`, `query?` |
| `GET`    | `/api/projects/:id/processes/local`      | Query: `include_all?`, `query?`; cwd filter from project workspaces |
| `GET`    | `/api/projects/:id/processes/remote`      | Query: `include_all?`, `query?`; remote cwd filter |
| `POST`   | `/api/projects/:id/tasks/:taskId/watch-link` | See [Watching and hooks](watching-and-hooks.md) |
| `POST`   | `/api/projects/:id/tasks/:taskId/watch-unlink` | — clears `watch_tracking` |
| `GET`    | `/api/browser-chats/config`               | `{ token, apiBase }` for the Chrome extension |
| `GET`    | `/api/browser-chats?provider=`             | Extension tab snapshots |
| `POST`   | `/api/browser-chats/snapshot`             | Header `X-Browser-Chat-Token` |
| `POST`   | `/api/browser-chats/complete`             | Header `X-Browser-Chat-Token` |
| `POST`   | `/api/browser-chats/cancel`               | Header `X-Browser-Chat-Token`; ChatGPT/Claude/Gemini explicit cancel clear |

When `workspace_items` is supplied on project create/update, the server normalizes those rows and regenerates `workspace_commands`. Project `launch_command` / `launch_commands` are legacy compatibility fields; when supplied, they are folded into custom workspace targets unless an equivalent target already exists.

Tasks may include `focus_items` for task-scoped focus actions. The server derives legacy `focus_commands` from those rows for old clients. Tasks may also include `watch_tracking` (cursor, process, notification, or browser_chat), and legacy `cursor_tracking` for compatibility.

Status transitions are enforced server-side: moving a task to `waiting` stamps `waiting_since`; moving to `done` stamps `completed_at`; leaving either clears the stamp. Leaving `waiting` or marking `done` clears watcher tracking.
