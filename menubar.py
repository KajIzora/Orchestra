#!/usr/bin/env python3
"""Menu bar helper for Orchestra.

Polls the backend every 30s. Shows a badge with the count of waiting tasks
across all projects, and a menu listing each waiting task.

Requires: rumps (pip install rumps), requests (pip install requests).
"""

import json
import os
import subprocess
import threading
import time
import webbrowser
from pathlib import Path
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest

try:
    import rumps
except ImportError:
    raise SystemExit(
        "rumps is required. Install with: pip3 install rumps\n"
        "(you may also want: pip3 install requests)"
    )

def _config_path():
    data_dir = os.environ.get("ORCHESTRA_DATA_DIR", "").strip()
    if data_dir:
        return Path(os.path.expanduser(data_dir)) / "config.json"
    return Path.home() / ".agent-task-tracker" / "config.json"


CONFIG_PATH = _config_path()
POLL_INTERVAL_SEC = 30
APP_DIR = Path(__file__).resolve().parent
START_SCRIPT = APP_DIR / "start.sh"
STATUS_DOT_ICON_SIZE = (14, 14)


def read_config():
    path = _config_path()
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def fetch_state(host, port, timeout=3):
    url = f"http://{host}:{port}/api/state"
    with urlrequest.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def post_json(host, port, path, timeout=3):
    url = f"http://{host}:{port}{path}"
    req = urlrequest.Request(
        url,
        data=b"{}",
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlrequest.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def waiting_minutes(since_iso):
    from datetime import datetime, timezone
    try:
        then = datetime.fromisoformat(since_iso.replace("Z", "+00:00"))
    except ValueError:
        return 0
    delta = datetime.now(timezone.utc) - then
    return max(0, int(delta.total_seconds() // 60))


def menu_bar_projects(state):
    return [project for project in state.get("projects", []) if not project.get("is_backlog")]


def has_task_focus_commands(task):
    commands = task.get("focus_commands") if isinstance(task, dict) else None
    return isinstance(commands, list) and any(isinstance(command, str) and command.strip() for command in commands)


def parse_created_ms(task):
    from datetime import datetime
    try:
        created = task.get("created_at") if isinstance(task, dict) else None
        if not created:
            return 0
        return datetime.fromisoformat(created.replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return 0


def is_task_backlog(task):
    return bool(isinstance(task, dict) and task.get("is_task_backlog"))


def visible_project_tasks(project):
    tasks = project.get("tasks", []) if isinstance(project, dict) else []
    return [task for task in tasks if not is_task_backlog(task)]


def task_has_watcher(task):
    return bool(task.get("watch_tracking") or task.get("cursor_tracking")) if isinstance(task, dict) else False


def task_tray_status(task):
    if not isinstance(task, dict):
        return "none"
    status = task.get("status")
    watch_finished = task.get("watch_finished")
    if status == "todo" and isinstance(watch_finished, dict) and watch_finished.get("needs_input"):
        return "needs_input"
    if status == "todo" and watch_finished:
        return "done"
    if status == "waiting" and task_has_watcher(task):
        return "watching"
    if status == "waiting":
        return "waiting"
    if status == "done":
        return "done"
    return "todo"


STATUS_DOT = "●"

STATUS_COLORS = {
    "needs_input": "#e06a5a",
    "watching": "#4a7dc9",
    "waiting": "#d79a2a",
    "done": "#2d9d78",
}

STATUS_RANK = {
    "needs_input": 0,
    "done": 1,
    "waiting": 2,
    "watching": 3,
    "todo": 4,
    "none": 5,
}


def status_dot_icon_path(status):
    icon_path = APP_DIR / "assets" / f"status_dot_{status}.svg"
    return str(icon_path) if icon_path.exists() else None


def status_menu_item(label, status, callback):
    icon_path = status_dot_icon_path(status)
    if icon_path:
        try:
            return rumps.MenuItem(
                label,
                callback=callback,
                icon=icon_path,
                dimensions=STATUS_DOT_ICON_SIZE,
                template=False,
            )
        except Exception:
            pass
    return rumps.MenuItem(f"{STATUS_DOT} {label}", callback=callback)


def project_tray_items(project):
    tasks = visible_project_tasks(project)
    open_tasks = [task for task in tasks if task.get("status") != "done"]
    if not open_tasks:
        latest = sorted(tasks, key=parse_created_ms, reverse=True)
        task = latest[0] if latest else None
        return [(project, task, task_tray_status(task))]
    return [(project, task, task_tray_status(task)) for task in open_tasks]


class MenuBarApp(rumps.App):
    def __init__(self):
        super().__init__("⏳", quit_button=None)
        self.state = None
        self.backend_ok = False
        self._lock = threading.Lock()
        self._rebuild_menu()
        self._start_polling()

    def _start_polling(self):
        def loop():
            while True:
                self._refresh()
                time.sleep(POLL_INTERVAL_SEC)

        t = threading.Thread(target=loop, daemon=True)
        t.start()

    def _refresh(self):
        cfg = read_config()
        if not cfg:
            with self._lock:
                self.state = None
                self.backend_ok = False
            rumps.Timer(lambda _: self._rebuild_menu(), 0.01).start()
            return
        try:
            data = fetch_state(cfg.get("host", "127.0.0.1"), cfg.get("port", 47823))
            with self._lock:
                self.state = data
                self.backend_ok = True
                self._cfg = cfg
        except (urlerror.URLError, TimeoutError, json.JSONDecodeError, OSError):
            with self._lock:
                self.state = None
                self.backend_ok = False
        rumps.Timer(lambda _: self._rebuild_menu(), 0.01).start()

    def _rebuild_menu(self):
        with self._lock:
            state = self.state
            backend_ok = self.backend_ok
            cfg = getattr(self, "_cfg", None) or read_config() or {}

        port = cfg.get("port", 47823)
        host = cfg.get("host", "127.0.0.1")
        self.menu.clear()

        if not backend_ok:
            self.title = "⏳"
            item = rumps.MenuItem("Backend not running — click to start", callback=self._on_start_backend)
            self.menu.add(item)
            self.menu.add(rumps.separator)
            self.menu.add(rumps.MenuItem("Quit", callback=rumps.quit_application))
            return

        task_items = []
        for project in sorted(menu_bar_projects(state), key=lambda p: p.get("order", 0)):
            task_items.extend(project_tray_items(project))

        open_item = rumps.MenuItem("Open Orchestra", callback=lambda _: webbrowser.open(f"http://{host}:{port}"))
        self.menu.add(open_item)

        task_items = [
            item for item in task_items
            if item[1] is not None and item[2] in STATUS_COLORS
        ]
        task_items.sort(key=lambda item: STATUS_RANK.get(item[2], 99))
        waiting_count = sum(1 for _, task, _ in task_items if task.get("status") == "waiting")
        self.title = f"⏳ {waiting_count}" if waiting_count else "⏳"

        if task_items:
            tasks_menu = rumps.MenuItem("Tasks")
            for project, task, status in task_items:
                mins = waiting_minutes(task.get("waiting_since") or "")
                suffix = f" ({mins}m)" if task.get("status") == "waiting" else ""
                label = f"[{project['name']}] {task['text']}{suffix}"
                pid = project["id"]
                tid = task.get("id")
                has_task_focus = bool(tid and has_task_focus_commands(task))
                item = status_menu_item(
                    label,
                    status,
                    lambda _, p=pid, t=tid, h=has_task_focus: self._on_focus_menu_task(host, port, p, t, h),
                )
                tasks_menu.add(item)
            self.menu.add(tasks_menu)
        else:
            disabled = rumps.MenuItem("No active tasks")
            disabled.set_callback(None)
            self.menu.add(disabled)

        self.menu.add(rumps.separator)
        self.menu.add(rumps.MenuItem("Quit", callback=rumps.quit_application))

    def _on_start_backend(self, _):
        if not START_SCRIPT.exists():
            rumps.alert("start.sh not found", str(START_SCRIPT))
            return
        try:
            subprocess.Popen(
                ["/bin/bash", str(START_SCRIPT)],
                cwd=str(APP_DIR),
                start_new_session=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            rumps.notification("Orchestra", "Starting backend…", "")
        except OSError as e:
            rumps.alert("Failed to start backend", str(e))

    def _on_focus_menu_task(self, host, port, project_id, task_id, has_task_focus):
        try:
            if has_task_focus:
                pid = urlparse.quote(str(project_id), safe="")
                tid = urlparse.quote(str(task_id), safe="")
                result = post_json(host, port, f"/api/projects/{pid}/tasks/{tid}/focus")
            else:
                pid = urlparse.quote(str(project_id), safe="")
                result = post_json(host, port, f"/api/projects/{pid}/focus")
            if not result.get("ok"):
                rumps.notification("Orchestra", "Focus failed", result.get("error") or "Unknown error")
        except (urlerror.URLError, TimeoutError, json.JSONDecodeError, OSError) as e:
            rumps.notification("Orchestra", "Focus request failed", str(e))


if __name__ == "__main__":
    MenuBarApp().run()
