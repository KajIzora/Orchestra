(() => {
  const COLORS = [
    'teal',
    'purple',
    'coral',
    'blue',
    'amber',
    'gray',
    'rose',
    'emerald',
    'indigo',
    'magenta',
    'lime',
    'orange',
    'cyan',
    'slate',
  ];
  const WORKSPACE_ITEM_TYPES = [
    { value: 'cursor_project', label: 'Cursor project' },
    { value: 'chrome_page', label: 'Chrome page' },
    { value: 'app_file', label: 'App / file' },
    { value: 'obsidian_note', label: 'Obsidian note' },
    { value: 'desktop', label: 'Desktop' },
    { value: 'shell', label: 'Shell command' },
  ];
  const DEFAULT_WORKSPACE_ITEM_TYPES = WORKSPACE_ITEM_TYPES.filter((item) => item.value !== 'obsidian_note');

  /** Synthetic stop rows from Claude Code / Cursor — not real task titles. */
  function isUserRequestInterruptedPickerLabel(text) {
    const norm = String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (!norm) return false;
    return norm === '[request interrupted by user]' || norm.startsWith('[request interrupted by user ');
  }

  // Preference keys must be declared before `state` — several fields call the readers
  // during object init, and those readers close over these consts.
  const BACKLOG_OPEN_KEY = 'orchestra.backlog-open';
  const LEGACY_BACKLOG_OPEN_KEY = 'task-app.backlog-open';
  const TASK_PROGRESS_HIDDEN_IDS_KEY = 'orchestra.task-progress-hidden-task-ids';
  const PROJECT_WAITING_BADGES_HIDDEN_KEY = 'orchestra.project-waiting-badges-hidden';
  const SHOW_TASK_BACKLOG_KEY = 'orchestra.show-task-backlog';

  const state = {
    data: { version: 1, projects: [] },
    selectedProjectId: null,
    editingTaskId: null,
    /** In-memory text while a task is open in the editor (survives full list re-renders). */
    editingTaskDraft: null,
    /** Note-token bodies stripped out of the editor draft, restored (by position) on save. */
    editingTaskNoteBodies: null,
    /** Set while an inline "Provider: Title" input is open so refreshes don't destroy it. */
    editingTitleTaskId: null,
    /** Set while the task list DOM is torn down so blur does not commit inline edit. */
    suppressTaskEditBlur: false,
    projectSortables: [],
    spellcheckContextMenuOpen: false,
    pendingSpellcheckBlurFinish: null,
    backlogOpen: readBacklogOpenPreference(),
    /** Hide yellow waiting-count badges next to project names in the sidebar. */
    projectWaitingBadgesHidden: readProjectWaitingBadgesHiddenPreference(),
    /** @type {Set<string>} task ids whose waiting / watching / watcher UI is collapsed */
    taskProgressHiddenIds: readTaskProgressHiddenIds(),
    /** When false, tasks with is_task_backlog are omitted from the list. */
    showTaskBacklog: readShowTaskBacklogPreference(),
    projectsSidebarVisible: true,
    taskSortable: null,
    /** Cleared when sidebar selection changes so the edit form does not linger with wrong project. */
    paneProjectId: null,
    /** Stack of recently deleted tasks to support undoing task deletion. */
    deletedTasksStack: [],
    /** The single row selected in the task list (drives the gray left bar + ⌘ shortcuts). */
    selectedTaskId: null,
    /** Signature of the projects data as of the last full task-list render — see refresh(). */
    taskListRenderSig: null,
  };

  const els = {
    app: document.querySelector('.app'),
    projectList: document.getElementById('project-list'),
    emptyState: document.getElementById('empty-state'),
    projectView: document.getElementById('project-view'),
    projectName: document.getElementById('project-name'),
    projectTaskSummaryDisplay: document.getElementById('project-task-summary-display'),
    toggleTaskBacklogBtn: document.getElementById('toggle-task-backlog-btn'),
    toggleAllProgressBtn: document.getElementById('toggle-all-progress-btn'),
    focusBtn: document.getElementById('focus-btn'),
    workspaceBtn: document.getElementById('workspace-btn'),
    editProjectBtn: document.getElementById('edit-project-btn'),
    deleteProjectBtn: document.getElementById('delete-project-btn'),
    editProjectForm: document.getElementById('edit-project-form'),
    taskList: document.getElementById('task-list'),
    newTaskForm: document.getElementById('new-task-form'),
    newTaskMonitor: document.getElementById('new-task-monitor'),
    taskSummary: document.getElementById('task-summary'),
    projectsToggleBtn: document.getElementById('projects-toggle-btn'),
    sidebarResizer: document.querySelector('.sidebar-resizer'),
    toggleProjectWaitingBadgesBtn: document.getElementById('toggle-project-waiting-badges-btn'),
    newProjectBtn: document.getElementById('new-project-btn'),
    newProjectForm: document.getElementById('new-project-form'),
    toast: document.getElementById('toast'),
    cursorRunModal: document.getElementById('cursor-run-modal'),
    cursorRunList: document.getElementById('cursor-run-list'),
    cursorWaitManual: document.getElementById('cursor-wait-manual'),
    cursorWaitSetDone: document.getElementById('cursor-wait-set-done'),
    cursorWaitStuck: document.getElementById('cursor-wait-stuck'),
    cursorWaitBacklog: document.getElementById('cursor-wait-backlog'),
    cursorWaitFocus: document.getElementById('cursor-wait-focus'),
    cursorWaitContext: document.getElementById('cursor-wait-context'),
    cursorWaitAddTitle: document.getElementById('cursor-wait-add-title'),
    addTitleModal: document.getElementById('add-title-modal'),
    addTitleForm: document.querySelector('#add-title-modal form'),
    addTitleProvider: document.getElementById('add-title-provider'),
    addTitleText: document.getElementById('add-title-text'),
    addTitlePlatform: document.getElementById('add-title-platform'),
    addTitleLocation: document.getElementById('add-title-location'),
    addTitleSave: document.getElementById('add-title-save'),
    addTitleCancel: document.getElementById('add-title-cancel'),
    contextNoteModal: document.getElementById('context-note-modal'),
    contextNoteSubtitle: document.getElementById('context-note-subtitle'),
    contextNoteView: document.getElementById('context-note-view'),
    contextNoteTextarea: document.getElementById('context-note-textarea'),
    contextNoteEdit: document.getElementById('context-note-edit'),
    contextNoteSave: document.getElementById('context-note-save'),
    contextNoteCancel: document.getElementById('context-note-cancel'),
    contextNoteClose: document.getElementById('context-note-close'),
    cursorModalCancel: document.getElementById('cursor-modal-cancel'),
    cursorModalTabs: document.querySelectorAll('[data-cursor-modal-tab]'),
    cursorWatchPanel: document.getElementById('cursor-watch-panel'),
    cursorSettingsPanel: document.getElementById('cursor-settings-panel'),
    watchSourceChoices: document.getElementById('watch-source-choices'),
    watchSubsourceToggle: document.getElementById('watch-subsource-toggle'),
    watchSearch: document.getElementById('watch-search'),
    launchPresetModal: document.getElementById('launch-preset-modal'),
    launchPresetFields: document.getElementById('launch-preset-fields'),
    launchPresetUse: document.getElementById('launch-preset-use'),
    launchPresetCancel: document.getElementById('launch-preset-cancel'),
    shellCommandModal: document.getElementById('shell-command-modal'),
    shellCommandTextarea: document.getElementById('shell-command-textarea'),
    shellCommandHighlight: document.getElementById('shell-command-highlight'),
    shellCommandUse: document.getElementById('shell-command-use'),
    shellCommandCancel: document.getElementById('shell-command-cancel'),
    taskFocusModal: document.getElementById('task-focus-modal'),
    taskFocusForm: document.querySelector('#task-focus-modal form'),
    taskFocusTaskText: document.getElementById('task-focus-task-text'),
    taskFocusAddCommand: document.getElementById('task-focus-add-command'),
    taskFocusClear: document.getElementById('task-focus-clear'),
    taskFocusCancel: document.getElementById('task-focus-cancel'),
    installAllHooksBtn: document.getElementById('install-all-hooks-btn'),
    installAllHooksStatus: document.getElementById('install-all-hooks-status'),
    installLocalHooksBtn: document.getElementById('install-local-hooks-btn'),
    installRemoteHooksBtn: document.getElementById('install-remote-hooks-btn'),
    testHooksBtn: document.getElementById('test-hooks-btn'),
    hookStatusText: document.getElementById('hook-status-text'),
    installLocalClaudeHooksBtn: document.getElementById('install-local-claude-hooks-btn'),
    installRemoteClaudeHooksBtn: document.getElementById('install-remote-claude-hooks-btn'),
    testClaudeHooksBtn: document.getElementById('test-claude-hooks-btn'),
    claudeHookStatusText: document.getElementById('claude-hook-status-text'),
    installLocalGeminiHooksBtn: document.getElementById('install-local-gemini-hooks-btn'),
    installRemoteGeminiHooksBtn: document.getElementById('install-remote-gemini-hooks-btn'),
    testGeminiHooksBtn: document.getElementById('test-gemini-hooks-btn'),
    geminiHookStatusText: document.getElementById('gemini-hook-status-text'),
    installLocalCodexHooksBtn: document.getElementById('install-local-codex-hooks-btn'),
    installRemoteCodexHooksBtn: document.getElementById('install-remote-codex-hooks-btn'),
    testCodexHooksBtn: document.getElementById('test-codex-hooks-btn'),
    codexHookStatusText: document.getElementById('codex-hook-status-text'),
  };

  /** @type {{ projectId: string, taskId: string, source?: string } | null} */
  let cursorModalContext = null;
  let cursorModalLoadToken = 0;
  let cursorModalAutoRefreshTimer = null;
  let cursorModalAutoRefreshInFlight = false;
  let cursorModalAutoRefreshGeneration = 0;
  /** @type {{ input: HTMLInputElement, preset: string|null } | null } */
  let launchPresetContext = null;
  /** @type {{ input: HTMLInputElement|HTMLTextAreaElement, returnToTaskFocus: boolean } | null } */
  let shellCommandEditorContext = null;
  /** @type {{ projectId: string, taskId: string } | null } */
  let taskFocusContext = null;
  /** @type {{ projectId: string, taskId: string } | null } */
  let addTitleContext = null;
  // The surface currently selected in the "Add Header" modal's Platform picker
  // ('' | 'cli' | 'desktop' | 'plugin'). Initialized from task.surface_kind on open.
  let addTitleSurface = '';
  /** @type {{ projectId: string, taskId: string } | null } */
  let contextNoteContext = null;
  const WATCH_PREFERENCE_STORAGE_PREFIX = 'orchestra.watch-preference';
  const LEGACY_WATCH_PREFERENCE_PREFIX = 'task-app.watch-preference';
  const TASK_WATCH_PREFERENCE_PREFIX = 'orchestra.task-watch-preference';
  const TASK_ACTIVE_KIND_PREFIX = 'orchestra.task-active-kind';
  const WATCH_GROUPS = {
    cursor: {
      label: 'Cursor',
      defaultValue: 'cursor',
      options: [
        { value: 'cursor', label: 'Cursor', source: 'provider-cursor' },
      ],
    },
    openai: {
      label: 'ChatGPT',
      defaultValue: 'openai',
      options: [
        { value: 'openai', label: 'ChatGPT', source: 'provider-openai' },
      ],
    },
    claude: {
      label: 'Claude',
      defaultValue: 'claude',
      options: [
        { value: 'claude', label: 'Claude', source: 'provider-claude' },
      ],
    },
    gemini: {
      label: 'Gemini',
      defaultValue: 'gemini',
      options: [
        { value: 'gemini', label: 'Gemini', source: 'provider-gemini' },
      ],
    },
    grok: {
      label: 'Grok',
      defaultValue: 'grok',
      options: [
        { value: 'grok', label: 'Grok', source: 'provider-grok' },
      ],
    },
    process: {
      label: 'Process',
      toggleLabel: 'Process source',
      defaultValue: 'local',
      options: [
        { value: 'local', label: 'Local', source: 'process-local' },
        { value: 'remote', label: 'Remote', source: 'process-remote' },
      ],
    },
  };

  const SIDEBAR_WIDTH_KEY = 'orchestra.sidebar-width';
  const SIDEBAR_WIDTH_DEFAULT = 280;
  const SIDEBAR_WIDTH_MIN = 200;
  const SIDEBAR_WIDTH_MAX = 480;

  function clampSidebarWidth(px) {
    return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, px));
  }

  function readSidebarWidthPreference() {
    try {
      const n = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY), 10);
      return Number.isFinite(n) ? clampSidebarWidth(n) : SIDEBAR_WIDTH_DEFAULT;
    } catch {
      return SIDEBAR_WIDTH_DEFAULT;
    }
  }

  function writeSidebarWidthPreference(px) {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(px)));
    } catch {
      // Ignore storage failures; the width still applies for this session.
    }
  }

  function readBacklogOpenPreference() {
    try {
      const v = localStorage.getItem(BACKLOG_OPEN_KEY);
      if (v != null) return v !== 'false';
      return localStorage.getItem(LEGACY_BACKLOG_OPEN_KEY) !== 'false';
    } catch {
      return true;
    }
  }

  function writeBacklogOpenPreference(isOpen) {
    try {
      localStorage.setItem(BACKLOG_OPEN_KEY, isOpen ? 'true' : 'false');
    } catch {
      // Ignore storage failures; the folder still works for the current session.
    }
  }

  function readTaskProgressHiddenIds() {
    try {
      const raw = localStorage.getItem(TASK_PROGRESS_HIDDEN_IDS_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? arr.filter((id) => typeof id === 'string') : []);
    } catch {
      return new Set();
    }
  }

  function writeTaskProgressHiddenIds(ids) {
    try {
      localStorage.setItem(TASK_PROGRESS_HIDDEN_IDS_KEY, JSON.stringify([...ids]));
    } catch {
      // Ignore storage failures.
    }
  }

  function readProjectWaitingBadgesHiddenPreference() {
    try {
      return localStorage.getItem(PROJECT_WAITING_BADGES_HIDDEN_KEY) === 'true';
    } catch {
      return false;
    }
  }

  function writeProjectWaitingBadgesHiddenPreference(hidden) {
    try {
      localStorage.setItem(PROJECT_WAITING_BADGES_HIDDEN_KEY, hidden ? 'true' : 'false');
    } catch {
      // Ignore storage failures.
    }
  }

  function readShowTaskBacklogPreference() {
    try {
      return localStorage.getItem(SHOW_TASK_BACKLOG_KEY) === 'true';
    } catch {
      return false;
    }
  }

  function writeShowTaskBacklogPreference(show) {
    try {
      localStorage.setItem(SHOW_TASK_BACKLOG_KEY, show ? 'true' : 'false');
    } catch {
      // Ignore storage failures.
    }
  }

  function applyTaskBacklogHeaderButton() {
    if (!els.toggleTaskBacklogBtn) return;
    const show = state.showTaskBacklog;
    els.toggleTaskBacklogBtn.textContent = show ? 'Hide Backlog' : 'Show Backlog';
    els.toggleTaskBacklogBtn.setAttribute('aria-pressed', String(show));
    els.toggleTaskBacklogBtn.title = show
      ? 'Hide task-backlog items (tasks with the purple backlog pill stay in the project but off this list)'
      : 'Show tasks marked with the backlog pill (purple)';
  }

  // The visible task set (what the list shows, respecting the backlog filter).
  function visibleProjectTasks(project) {
    const showBacklog = state.showTaskBacklog;
    return project.tasks.filter((t) => showBacklog || !t.is_task_backlog);
  }

  // Header button: "Show all progress" when any visible task is collapsed, else "Hide all progress".
  function applyToggleAllProgressButton(project) {
    const btn = els.toggleAllProgressBtn;
    if (!btn) return;
    const tasks = project ? visibleProjectTasks(project) : [];
    if (tasks.length === 0) {
      btn.hidden = true;
      return;
    }
    btn.hidden = false;
    const anyHidden = tasks.some((t) => state.taskProgressHiddenIds.has(t.id));
    btn.textContent = anyHidden ? 'Show all progress' : 'Hide all progress';
    btn.dataset.mode = anyHidden ? 'show' : 'hide';
    btn.title = anyHidden
      ? 'Show waiting / working / watcher progress on every task in this project'
      : 'Hide waiting / working / watcher progress on every task in this project';
  }

  function syncProjectWaitingBadgesToggle() {
    const btn = els.toggleProjectWaitingBadgesBtn;
    if (!btn) return;
    const hidden = state.projectWaitingBadgesHidden;
    btn.textContent = hidden ? 'show progress' : 'hide progress';
    btn.setAttribute('aria-pressed', String(hidden));
    btn.className = `pill pill-toggle project-waiting-badges-toggle ${hidden ? '' : 'off'}`;
    btn.title = hidden
      ? 'Show waiting-task counts next to each project in this list'
      : 'Hide waiting-task counts next to each project in this list';
  }

  function applyProjectsSidebarVisibility() {
    const isVisible = state.projectsSidebarVisible;
    els.app.classList.toggle('projects-sidebar-hidden', !isVisible);
    els.app.classList.toggle('project-waiting-badges-hidden', state.projectWaitingBadgesHidden);
    els.projectsToggleBtn.textContent = isVisible ? '<' : '>';
    els.projectsToggleBtn.setAttribute('aria-expanded', String(isVisible));
    els.projectsToggleBtn.setAttribute('aria-label', isVisible ? 'Hide projects' : 'Show projects');
    els.projectsToggleBtn.title = isVisible ? 'Hide projects' : 'Show projects';
    syncProjectWaitingBadgesToggle();
  }

  // --- API helpers ---

  async function api(method, path, body) {
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(path, init);
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        const head = text.trimStart().slice(0, 20).toLowerCase();
        if (head.startsWith('<!') || head.startsWith('<html')) {
          throw new Error(
            'Server returned HTML instead of JSON. Open the app from the Orchestra URL printed in the terminal (http://127.0.0.1:…), restart the server after updates, and do not open public/index.html from disk.'
          );
        }
        throw new Error(`${method} ${path} returned non-JSON (${res.status}). Is the Orchestra backend running?`);
      }
    }
    if (!res.ok) {
      const msg = (data && data.error) || `${method} ${path} failed (${res.status})`;
      throw new Error(msg);
    }
    return data;
  }

  /**
   * Mirrors server stripShellOrnamentArgs for display (browser bundle has no lib require).
   * @param {string} rest
   */
  function stripShellNoiseForDisplay(rest) {
    let r = String(rest || '').trim();
    if (/^-c(\s|$)/i.test(r)) return r;
    for (let i = 0; i < 32; i += 1) {
      const before = r;
      r = r.replace(/^--init-file=\S+(?:\s+|$)/, '');
      r = r.replace(/^--rcfile=\S+(?:\s+|$)/, '');
      r = r.replace(/^--init-file\s+\S+(?:\s+|$)/, '');
      r = r.replace(/^--rcfile\s+\S+(?:\s+|$)/, '');
      r = r.replace(/^--norc(?:\s+|$)/, '');
      r = r.replace(/^--noprofile(?:\s+|$)/, '');
      r = r.replace(/^--nologin(?:\s+|$)/, '');
      r = r.replace(/^--login(?:\s+|$)/, '');
      r = r.replace(/^--no-rcs(?:\s+|$)/, '');
      r = r.replace(/^-li\b(?:\s+|$)/i, '');
      r = r.replace(/^-il\b(?:\s+|$)/i, '');
      r = r.replace(/^-l\b(?:\s+|$)/i, '');
      r = r.replace(/^-i\b(?:\s+|$)/i, '');
      r = r.replace(/^\+l\b(?:\s+|$)/i, '');
      r = r.replace(/^\+i\b(?:\s+|$)/i, '');
      r = r.replace(/^--(?:\s+|$)/, '');
      if (r === before) break;
    }
    return r.trim();
  }

  /**
   * Picker display: drop absolute argv0 and strip shell init/interactive noise.
   * By default labels are capped; callers can request the full cleaned command.
   * Presets like Isaac keep watch_label.
   * @param {string} command
   * @param {{ truncate?: boolean }} [options]
   */
  function processCommandDisplayLabel(command, options = {}) {
    const truncate = options.truncate !== false;
    const raw = String(command || '').trim();
    const shells = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'csh', 'tcsh']);
    const firstSp = raw.indexOf(' ');
    const argv0 = firstSp === -1 ? raw : raw.slice(0, firstSp);
    const argv0Base = argv0.includes('/') ? argv0.slice(argv0.lastIndexOf('/') + 1) : argv0;
    const argv0Norm = argv0Base.replace(/^-+/, '').toLowerCase();

    let body;
    if (!raw.startsWith('/')) {
      if (shells.has(argv0Norm)) {
        const rest = firstSp === -1 ? '' : raw.slice(firstSp + 1).trim();
        const cleaned = stripShellNoiseForDisplay(rest);
        body = cleaned || argv0Base;
      } else {
        body = raw;
      }
    } else if (firstSp === -1) {
      const slash = raw.lastIndexOf('/');
      body = slash >= 0 ? raw.slice(slash + 1) : raw;
    } else {
      const rest = raw.slice(firstSp + 1).trim();
      body = rest ? stripShellNoiseForDisplay(rest) : raw.slice(raw.lastIndexOf('/') + 1);
    }
    const out = body.replace(/\s+/g, ' ').trim();
    if (!truncate) return out || String(command || '').trim();
    if (out.length <= 96) return out || String(command || '').trim();
    return `${out.slice(0, 44)}…${out.slice(-48)}`;
  }

  // Watcher bookkeeping the server stamps on every ~2s poll while an agent is tracked. None of
  // these are rendered anywhere in the task list, so a refresh whose only delta is these fields
  // must NOT count as "the data changed" — otherwise the 2s linked-waiting refresh rebuilds the
  // whole list on every tick while an agent runs, and a rebuild destroys transient DOM state the
  // live cells depend on (an open history's scroll position dies on detach, in-flight scroll and
  // drag gestures are interrupted).
  const VOLATILE_TRACKING_KEYS = new Set([
    'last_seen_at',
    'last_checked_at',
    'last_seen_rec_id',
    'last_error',
    'completion_hint_at',
    'clear_signal_at',
    'continuation_hold_at',
  ]);

  function taskListRenderSignature() {
    return JSON.stringify(state.data.projects, (key, value) =>
      VOLATILE_TRACKING_KEYS.has(key) ? undefined : value
    );
  }

  async function refresh(options = {}) {
    state.data = await api('GET', '/api/state');
    if (!state.selectedProjectId || !state.data.projects.find((p) => p.id === state.selectedProjectId)) {
      state.selectedProjectId = getDefaultProjectId();
    }
    const editingInline = !!state.editingTaskId || !!state.editingTitleTaskId;
    // A preserve-list refresh (the 2s poll) skips the task-list rebuild when nothing it renders
    // has changed — the skip path still refreshes the summary line and waiting pill labels, and
    // the live cells are driven separately (live-feed poll + 1s ticker). Any real change (status
    // flip, gate, text edit, new task, reorder…) changes the signature and rebuilds as before.
    const skipTaskList =
      !!options.preserveTaskList &&
      (editingInline || taskListRenderSignature() === state.taskListRenderSig);
    render({ skipTaskList });
  }

  function toast(message, isError = false) {
    els.toast.textContent = message;
    els.toast.classList.toggle('error', isError);
    els.toast.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      els.toast.hidden = true;
    }, isError ? 5000 : 2500);
  }

  // --- Rendering ---

  // Minimalist robot — marks an "auto" watch (an agent the app watches for you).
  const ROBOT_ICON_SVG =
    '<svg class="pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>';
  // Alert — the coral "needs input" pill when a tracked agent stopped blocked on you and we can't
  // tell the gate kind apart (the generic fallback).
  const ALERT_ICON_SVG =
    '<svg class="pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><line x1="12" x2="12" y1="7.5" y2="13"/><line x1="12" x2="12.01" y1="16.5" y2="16.5"/></svg>';
  // Question — a speech bubble with a "?": the agent stopped to ASK you something (AskUserQuestion /
  // request_user_input). Distinct from the permission gate.
  const QUESTION_ICON_SVG =
    '<svg class="pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 15.5a2 2 0 0 1-2 2H8l-4 3.5v-14a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/><path d="M9.2 9.2a2.8 2.8 0 0 1 5.3 1c0 1.9-2.8 2.5-2.8 2.5" stroke-width="1.9"/><line x1="11.7" x2="11.71" y1="16" y2="16"/></svg>';
  // Permission — a shield with a check: the agent stopped waiting for you to APPROVE an action
  // (a command / write / patch). Distinct from a question.
  const PERMISSION_ICON_SVG =
    '<svg class="pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5l7.5 2.7v5.6c0 4.6-3.2 7.9-7.5 9.2-4.3-1.3-7.5-4.6-7.5-9.2V5.2z"/><path d="M9 11.8l2.1 2.1L15 10" stroke-width="1.9"/></svg>';
  // Check — the green "done" pill shown when a tracked agent has finished.
  const CHECK_ICON_SVG =
    '<svg class="pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  // Eye — the idle "monitor" pill before you've chosen auto or manual.
  const EYE_ICON_SVG =
    '<svg class="pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>';
  // Hourglass — marks a "manual" wait (you must remember to check it yourself).
  const HOURGLASS_ICON_SVG =
    '<svg class="pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/></svg>';
  // Gutter eye — the left-column hide/show toggle for a task's progress. `eye` while progress
  // is showing (click to hide), `eye-off` while hidden (click to show). Sized via `.task-hide svg`.
  const HIDE_EYE_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>';
  const HIDE_EYEOFF_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>';
  // Note lines — the "context" pill: a page you write for yourself to re-orient when switching back.
  const CONTEXT_ICON_SVG =
    '<svg class="pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16"/><path d="M4 10h16"/><path d="M4 15h10"/><path d="M4 20h7"/></svg>';

  // --- Auto-generated agent header (one clean line above a tracked task) ---

  // Platform mark SVGs — geometric brand placeholders that sit in the checkbox column, tinted to the
  // platform's brand color via the parent span's `color` (each path uses currentColor). Keyed by the
  // task's provider_kind. Swap in real brand logos here at the same size + tint.
  const PLATFORM_MARK_SVGS = {
    claude:
      '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"/></svg>',
    openai:
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5l8.5 4.9v9.2L12 21.5 3.5 16.6V7.4z"/></svg>',
    cursor:
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 3l14.5 8.2-6.4 1.4-2.8 6.6z"/></svg>',
    gemini:
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2c.5 5 4.5 9 10 10-5.5 1-9.5 5-10 10-.5-5-4.5-9-10-10 5.5-1 9.5-5 10-10z"/></svg>',
    process:
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7.5 9.5l3 2.5-3 2.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 15h4" stroke-linecap="round"/></svg>',
    grok:
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M16.8 5.6 7.2 18.4"/></svg>',
  };
  // The CSS custom property carrying each platform's brand tint (see :root in style.css).
  const PLATFORM_TINT_VARS = {
    claude: 'var(--plat-claude)',
    openai: 'var(--plat-codex)',
    cursor: 'var(--plat-cursor)',
    gemini: 'var(--plat-gemini)',
    grok: 'var(--plat-grok)',
    process: 'var(--plat-terminal)',
  };
  function platformMarkSvg(kind) {
    return PLATFORM_MARK_SVGS[kind] || '';
  }
  function platformTintVar(kind) {
    return PLATFORM_TINT_VARS[kind] || 'var(--plat-terminal)';
  }

  // Location icons (CLI / Desktop / Plugin / Browser) — an icon, not a word, for WHERE the agent
  // runs. Stroked in --text-muted via currentColor. Terminal processes omit the location icon.
  const HDR_LOCATION_ICON_SVGS = {
    cli:
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7.5 9.5l3 2.5-3 2.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 15h4" stroke-linecap="round"/></svg>',
    desktop:
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="4" y="5" width="16" height="13" rx="1.8"/><path d="M4 9h16" stroke-linecap="round"/></svg>',
    plugin:
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 4.5a1.8 1.8 0 0 1 3.6 0V6h2.9a1 1 0 0 1 1 1v2.9h1.5a1.8 1.8 0 0 1 0 3.6h-1.5V17a1 1 0 0 1-1 1h-2.9v-1.5a1.8 1.8 0 0 0-3.6 0V18H7.1a1 1 0 0 1-1-1v-2.9H4.6a1.8 1.8 0 0 1 0-3.6h1.5V7a1 1 0 0 1 1-1H10z"/></svg>',
    browser:
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18"/></svg>',
  };
  const HDR_LOCATION_LABELS = { cli: 'CLI', desktop: 'Desktop', plugin: 'Plugin', browser: 'Browser' };
  function hdrLocationIconSvg(kind) {
    return HDR_LOCATION_ICON_SVGS[kind] || '';
  }

  // Render a pill as an icon followed by a text label (kept in its own span so the
  // label can be updated later without dropping the icon).
  function setPillContent(btn, iconSvg, label) {
    btn.innerHTML = iconSvg;
    const span = document.createElement('span');
    span.className = 'pill-label';
    span.textContent = label;
    btn.appendChild(span);
  }

  // A task is "auto-watched" when it has a real linked watcher source, vs a plain
  // manual wait (status waiting with no watcher attached).
  function taskHasWatcher(task) {
    const wt = getTaskWatchTracking(task);
    return !!(wt && (wt.transcript_path || wt.pid || wt.provider || wt.conversation_id));
  }

  function waitingCount(project) {
    return project.tasks.filter((t) => t.status === 'waiting').length;
  }

  function isBacklogProject(project) {
    return !!project?.is_backlog;
  }

  function getActiveProjects() {
    return state.data.projects.filter((project) => !isBacklogProject(project));
  }

  function getBacklogProjects() {
    return state.data.projects.filter(isBacklogProject);
  }

  function getDefaultProjectId() {
    return getActiveProjects()[0]?.id || state.data.projects[0]?.id || null;
  }

  function formatWaiting(sinceIso) {
    if (!sinceIso) return '';
    const ms = Date.now() - new Date(sinceIso).getTime();
    const mins = Math.max(0, Math.floor(ms / 60000));
    if (mins < 1) return 'waiting · <1m';
    if (mins < 60) return `waiting · ${mins}m`;
    const hours = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem === 0 ? `waiting · ${hours}h` : `waiting · ${hours}h${rem}m`;
  }

  function render(options = {}) {
    applyProjectsSidebarVisibility();
    renderSidebar();
    renderPane(options);
  }

  function renderSidebar() {
    els.projectList.innerHTML = '';
    const activeProjects = getActiveProjects();
    const backlogProjects = getBacklogProjects();

    const renderProjectItem = (container, project, idx = null) => {
      const li = document.createElement('li');
      li.className = 'project-item';
      li.dataset.id = project.id;
      if (project.id === state.selectedProjectId) li.classList.add('selected');
      if (isBacklogProject(project)) li.classList.add('backlog');

      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = `var(--color-${project.color || 'teal'})`;

      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = project.name;

      li.append(dot, label);

      // Roll up task states, shown most-urgent first: needs-input (coral — an agent
      // is blocked on you), done (green — an agent finished), manual waits (yellow),
      // and auto tracks (blue, hands-off).
      let needsInputCount = 0;
      let doneCount = 0;
      let manualWaiting = 0;
      let autoWatching = 0;
      for (const t of project.tasks) {
        if (t.status === 'todo' && t.watch_finished) {
          if (t.watch_finished.needs_input) needsInputCount += 1;
          else doneCount += 1;
          continue;
        }
        if (t.status !== 'waiting') continue;
        if (taskHasWatcher(t)) autoWatching += 1;
        else manualWaiting += 1;
      }
      if (needsInputCount > 0) {
        const badge = document.createElement('span');
        badge.className = 'badge needsinput';
        badge.textContent = needsInputCount;
        badge.title = `${needsInputCount} task${needsInputCount === 1 ? '' : 's'} need your input (question or permission)`;
        li.appendChild(badge);
      }
      if (doneCount > 0) {
        const badge = document.createElement('span');
        badge.className = 'badge finished';
        badge.textContent = doneCount;
        badge.title = `${doneCount} task${doneCount === 1 ? '' : 's'} finished — needs your attention`;
        li.appendChild(badge);
      }
      if (manualWaiting > 0) {
        const badge = document.createElement('span');
        badge.className = 'badge manual';
        badge.textContent = manualWaiting;
        badge.title = `${manualWaiting} task${manualWaiting === 1 ? '' : 's'} waiting for you to check`;
        li.appendChild(badge);
      }
      if (autoWatching > 0) {
        const badge = document.createElement('span');
        badge.className = 'badge auto';
        badge.textContent = autoWatching;
        badge.title = `${autoWatching} task${autoWatching === 1 ? '' : 's'} tracking an agent`;
        li.appendChild(badge);
      }

      if (idx !== null && idx < 9) {
        const shortcut = document.createElement('span');
        shortcut.className = 'shortcut';
        shortcut.textContent = `⌘${idx + 1}`;
        li.appendChild(shortcut);
      }

      li.addEventListener('click', () => {
        state.selectedProjectId = project.id;
        render();
      });

      container.appendChild(li);
    };

    const activeSection = document.createElement('li');
    activeSection.className = 'project-section';
    const activeList = document.createElement('ul');
    activeList.className = 'project-list-section active-project-list';
    activeList.dataset.projectBucket = 'active';
    activeSection.appendChild(activeList);
    els.projectList.appendChild(activeSection);
    activeProjects.forEach((project, idx) => renderProjectItem(activeList, project, idx));

    const folder = document.createElement('li');
    folder.className = 'project-folder';
    if (!state.backlogOpen) folder.classList.add('collapsed');

    const folderButton = document.createElement('button');
    folderButton.type = 'button';
    folderButton.className = 'project-folder-toggle';
    folderButton.setAttribute('aria-expanded', String(state.backlogOpen));
    folderButton.innerHTML = `<span class="project-folder-caret">${state.backlogOpen ? '▾' : '▸'}</span><span>Back Log Project folder</span><span class="project-folder-count">${backlogProjects.length}</span>`;
    folderButton.addEventListener('click', () => {
      state.backlogOpen = !state.backlogOpen;
      writeBacklogOpenPreference(state.backlogOpen);
      renderSidebar();
    });

    const backlogList = document.createElement('ul');
    backlogList.className = 'project-list-section backlog-project-list';
    if (!state.backlogOpen) backlogList.classList.add('collapsed');
    backlogList.dataset.projectBucket = 'backlog';
    backlogList.setAttribute(
      'aria-label',
      state.backlogOpen ? 'Back Log projects' : 'Back Log projects drop target'
    );
    if (state.backlogOpen) {
      backlogProjects.forEach((project) => renderProjectItem(backlogList, project));
    }

    folder.append(folderButton, backlogList);
    els.projectList.appendChild(folder);

    if (state.data.projects.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'project-folder-label';
      empty.textContent = 'No projects yet';
      els.projectList.appendChild(empty);
    }

    destroyProjectSortables();
    if (window.Sortable) {
      const sortableOptions = {
        animation: 150,
        draggable: '.project-item',
        group: 'projects',
        emptyInsertThreshold: 18,
        onEnd: persistProjectTreeFromDom,
      };
      state.projectSortables = [activeList, backlogList].map((list) => new Sortable(list, sortableOptions));
    }
  }

  function destroyProjectSortables() {
    state.projectSortables.forEach((sortable) => sortable.destroy());
    state.projectSortables = [];
  }

  function projectIdsFromList(list) {
    return [...list.children].filter((el) => el.classList.contains('project-item')).map((el) => el.dataset.id);
  }

  async function persistProjectTreeFromDom() {
    const activeList = els.projectList.querySelector('[data-project-bucket="active"]');
    const backlogList = els.projectList.querySelector('[data-project-bucket="backlog"]');
    if (!activeList || !backlogList) return;

    const activeIds = projectIdsFromList(activeList);
    const visibleBacklogIds = projectIdsFromList(backlogList);
    const usedIds = new Set([...activeIds, ...visibleBacklogIds]);
    const hiddenBacklogIds = getBacklogProjects().map((project) => project.id).filter((id) => !usedIds.has(id));
    const items = [
      ...activeIds.map((id) => ({ id, is_backlog: false })),
      ...visibleBacklogIds.map((id) => ({ id, is_backlog: true })),
      ...hiddenBacklogIds.map((id) => ({ id, is_backlog: true })),
    ];

    try {
      if (visibleBacklogIds.length > 0 && !state.backlogOpen) {
        state.backlogOpen = true;
        writeBacklogOpenPreference(true);
      }
      await api('POST', '/api/projects/reorder', { items });
      await refresh();
    } catch (err) {
      toast(err.message, true);
      await refresh();
    }
  }

  function renderPane(options = {}) {
    const project = state.data.projects.find((p) => p.id === state.selectedProjectId);
    if (!project) {
      els.projectView.hidden = true;
      els.emptyState.hidden = false;
      state.paneProjectId = null;
      if (window.LiveFeedUI) LiveFeedUI.applyPaneState(null);
      return;
    }
    els.emptyState.hidden = true;
    els.projectView.hidden = false;
    if (state.paneProjectId !== project.id) {
      els.editProjectForm.hidden = true;
      state.paneProjectId = project.id;
      state.editingTaskId = null;
      state.editingTaskDraft = null;
    }

    els.projectName.textContent = project.name;
    const storedSummary = (project.task_summary || '').trim();
    if (storedSummary) {
      els.projectTaskSummaryDisplay.textContent = storedSummary;
      els.projectTaskSummaryDisplay.classList.remove('empty');
    } else {
      els.projectTaskSummaryDisplay.textContent = 'No task summary set.';
      els.projectTaskSummaryDisplay.classList.add('empty');
    }

    applyTaskBacklogHeaderButton();
    applyToggleAllProgressButton(project);
    // Live-feed plain/live segmented toggle + the task list's live-mode container class.
    if (window.LiveFeedUI) LiveFeedUI.applyPaneState(project);
    if (options.skipTaskList) {
      renderSummary(project);
      updateWaitingPillLabels(project);
    } else {
      renderTasks(project);
      renderSummary(project);
    }
  }

  function renderSummary(project) {
    // Count only non-backlog tasks — backlog items live in the project but off this list, so they
    // must not inflate "open" (was showing e.g. "5 open" when only 4 tasks are visible).
    const counted = project.tasks.filter((t) => !t.is_task_backlog);
    // A finished agent task keeps status 'todo' but shows the green "done" pill (watch_finished set,
    // and not waiting on a question/permission). Count those as done so "done" actually increments.
    const isDone = (t) =>
      t.status === 'done' ||
      (t.status === 'todo' && t.watch_finished && !t.watch_finished.needs_input);
    const done = counted.filter(isDone).length;
    const waiting = counted.filter((t) => t.status === 'waiting').length;
    const open = counted.length - done - waiting;
    els.taskSummary.textContent = `${open} open · ${waiting} tracking · ${done} done`;
  }

  function updateWaitingPillLabels(project) {
    for (const task of project.tasks) {
      if (task.status !== 'waiting') continue;
      const li = els.taskList.querySelector(`.task-item[data-id="${task.id}"]`);
      if (!li) continue;
      const btn = li.querySelector('.pill-toggle.waiting');
      if (!btn) continue;
      const label = btn.querySelector('.pill-label');
      if (label) label.textContent = formatWaiting(task.waiting_since);
      else btn.textContent = formatWaiting(task.waiting_since);
    }
  }

  function clearTaskListElement() {
    state.suppressTaskEditBlur = true;
    try {
      els.taskList.innerHTML = '';
    } finally {
      state.suppressTaskEditBlur = false;
    }
  }

  function renderTasks(project) {
    const showBacklog = state.showTaskBacklog;
    const tasksToRender = project.tasks.filter((t) => showBacklog || !t.is_task_backlog);
    const visibleIds = new Set(tasksToRender.map((t) => t.id));
    if (state.editingTaskId && !visibleIds.has(state.editingTaskId)) {
      state.editingTaskId = null;
      state.editingTaskDraft = null;
    }
    // Rebuild patch: a rebuild (clearTaskListElement + buildTaskItem per task) would destroy each
    // task's OPEN live-feed card — including its L2 history — so in live mode carry the card NODES
    // across the rebuild. Moving the node is safe: LiveFeedUI re-queries the card from the DOM on
    // every poll (it holds no stale reference). Detaching a scrollable element destroys its scroll
    // state, however (scrollTop reads 0 once the node leaves the document, and moving the node
    // does not bring it back), so each card's scrollable parts are recorded here and restored
    // after the card is re-attached below. The collapsed chip has no scroll state, so it is just
    // rebuilt fresh. Steady-state polls no longer come through here at all (refresh() skips the
    // rebuild when nothing rendered has changed), so this path runs only on real changes.
    const preservedLiveCards = new Map();
    if (els.taskList.classList.contains('live-mode')) {
      els.taskList.querySelectorAll('.task-item').forEach((li) => {
        const card = li.querySelector('.task-live-card');
        if (!card || !li.dataset.id) return;
        const scrolls = [];
        card.querySelectorAll('.lf-history, .lf-full-msg, .lf-qstack').forEach((part) => {
          scrolls.push({
            part,
            top: part.scrollTop,
            // Pinned to the live tail → keep following it after the rebuild.
            atBottom: part.scrollHeight - part.scrollTop - part.clientHeight <= 4,
          });
        });
        preservedLiveCards.set(li.dataset.id, { card, scrolls });
      });
    }
    clearTaskListElement();
    tasksToRender.forEach((task) => {
      const li = buildTaskItem(project, task);
      const preserved = preservedLiveCards.get(task.id);
      if (preserved) {
        // Only reuse it if the rebuilt row still wants a card (task still tracked, not hidden, and
        // still expanded); otherwise the freshly built row correctly has none and we drop the old.
        const fresh = li.querySelector('.task-live-card');
        if (fresh) fresh.replaceWith(preserved.card);
      }
      els.taskList.appendChild(li);
      if (preserved && preserved.card.isConnected) {
        preserved.scrolls.forEach(({ part, top, atBottom }) => {
          part.scrollTop = atBottom ? part.scrollHeight : top;
        });
      }
    });

    if (state.taskSortable) state.taskSortable.destroy();
    state.taskSortable = null;
    if (window.Sortable) {
      state.taskSortable = new Sortable(els.taskList, {
        animation: 150,
        handle: '.task-drag',
        onEnd: async () => {
          const visibleIds = [...els.taskList.querySelectorAll('.task-item')].map((el) => el.dataset.id);
          const ids = getFullTaskOrderAfterVisibleReorder(project, visibleIds, showBacklog);
          try {
            await api('POST', `/api/projects/${project.id}/tasks/reorder`, { ids });
            await refresh();
          } catch (err) {
            toast(err.message, true);
            await refresh();
          }
        },
      });
    }
    requestAnimationFrame(() => {
      alignTaskPillsToCurrentLine();
      renderBlockerLines();
    });
    // The list now reflects the current data — record its signature so the 2s poll can skip
    // rebuilds until something render-relevant actually changes (see refresh()).
    state.taskListRenderSig = taskListRenderSignature();
  }

  // Drop each task's pill cluster down so it sits beside the "current" line (firstActiveLineIndex),
  // not always the first line — so checking off the top item carries the pills down with the
  // highlight. Measured because lines can wrap, so it runs after layout; two passes (read all
  // offsets, then write all margins) keep one item's margin change from reflowing the next mid-read.
  function alignTaskPillsToCurrentLine() {
    if (!els.taskList) return;
    const writes = [];
    els.taskList.querySelectorAll('.task-item').forEach((li) => {
      const pills = li.querySelector('.task-item-pills');
      if (!pills) return;
      const wrap = li.querySelector('.task-text-rich');
      const current = wrap ? wrap.querySelector('.task-line-current') : null;
      if (!wrap || !current) {
        writes.push([pills, '']);
        return;
      }
      const offset = current.getBoundingClientRect().top - wrap.getBoundingClientRect().top;
      writes.push([pills, offset > 1 ? `${Math.round(offset)}px` : '']);
    });
    writes.forEach(([pills, value]) => {
      pills.style.marginTop = value;
    });
  }

  function getFullTaskOrderAfterVisibleReorder(project, visibleIds, showBacklog) {
    if (showBacklog) return visibleIds;
    const reorderedVisible = [...visibleIds];
    return project.tasks.map((task) => {
      if (task.is_task_backlog) return task.id;
      return reorderedVisible.shift() || task.id;
    });
  }

  function fitTaskTextInputHeight(textarea) {
    if (!textarea?.isConnected) return;
    const minPx = parseFloat(getComputedStyle(textarea).minHeight) || 44;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.max(minPx, textarea.scrollHeight)}px`;
  }

  // ---------------------------------------------------------------------------
  // Custom-UI helpers: rich task text, editable title section, stuck/blocker links
  // ---------------------------------------------------------------------------

  function getSelectedProject() {
    return state.data && state.data.projects
      ? state.data.projects.find((p) => p.id === state.selectedProjectId)
      : null;
  }

  function beginTaskEdit(task) {
    const { display, bodies } = stripNoteBodies(task.text);
    state.editingTaskId = task.id;
    state.editingTaskDraft = display;
    state.editingTaskNoteBodies = bodies;
    render();
  }

  function copyText(text) {
    const val = String(text == null ? '' : text);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(val);
        return;
      }
    } catch {
      /* fall through */
    }
    const ta = document.createElement('textarea');
    ta.value = val;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {
      /* ignore */
    }
    ta.remove();
  }

  // Inline LaTeX via KaTeX (loaded from CDN in index.html). Falls back to raw $..$.
  function renderLatexInto(parent, latex) {
    const span = document.createElement('span');
    span.className = 'tl-latex';
    if (window.katex && typeof window.katex.renderToString === 'function') {
      try {
        span.innerHTML = window.katex.renderToString(latex, { throwOnError: false, displayMode: false });
      } catch {
        span.textContent = `$${latex}$`;
      }
    } else {
      span.textContent = `$${latex}$`;
    }
    parent.appendChild(span);
  }

  // Inline markup within one line. Order: #NOTE token, $latex$, **bold**, *italic*, _italic_.
  // (#PROMPT is the legacy spelling of #NOTE and still renders, so old tasks keep working.)
  const INLINE_RE =
    /#(?:NOTE|PROMPT)(?:\{\{([\s\S]*?)\}\})?|\$([^$\n]+)\$|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|_([^_\n]+)_/g;

  function renderInlineInto(parent, text, ctx) {
    INLINE_RE.lastIndex = 0;
    let last = 0;
    let m;
    while ((m = INLINE_RE.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      const raw = m[0];
      if (raw.startsWith('#NOTE') || raw.startsWith('#PROMPT')) {
        const idx = ctx.nextPromptIndex();
        const kind = raw.startsWith('#PROMPT') ? 'PROMPT' : 'NOTE';
        const content = (m[1] || '').replace(/\\n/g, '\n');
        parent.appendChild(buildPromptButton(ctx.project, ctx.task, idx, content, kind));
      } else if (m[2] !== undefined) {
        renderLatexInto(parent, m[2]);
      } else if (m[3] !== undefined) {
        const b = document.createElement('strong');
        b.textContent = m[3];
        parent.appendChild(b);
      } else if (m[4] !== undefined || m[5] !== undefined) {
        const i = document.createElement('em');
        i.textContent = m[4] !== undefined ? m[4] : m[5];
        parent.appendChild(i);
      }
      last = m.index + raw.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function renderLineInto(lineEl, line, ctx, lineIdx) {
    const cb = /^(\s*)\[( |x|X)\]\s?([\s\S]*)$/.exec(line);
    if (cb) {
      lineEl.classList.add('tl-line-check');
      const checked = cb[2].toLowerCase() === 'x';
      const box = document.createElement('button');
      box.type = 'button';
      box.className = 'tl-interactive tl-check' + (checked ? ' checked' : '');
      box.title = 'Click: cross out · Double-click: remove line';
      box.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleCheckboxLine(ctx.project, ctx.task, lineIdx);
      });
      box.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        removeTaskLine(ctx.project, ctx.task, lineIdx);
      });
      lineEl.appendChild(box);
      const textSpan = document.createElement('span');
      textSpan.className = 'tl-checktext' + (checked ? ' checked' : '');
      renderInlineInto(textSpan, cb[3], ctx);
      lineEl.appendChild(textSpan);
    } else if (line.length === 0) {
      lineEl.appendChild(document.createTextNode('​'));
    } else {
      renderInlineInto(lineEl, line, ctx);
    }
  }

  // --- Context-note markdown ---
  // A small, dependency-free markdown renderer JUST for a task's context note (the "where I left
  // off" page). It deliberately does NOT reuse the task-text renderer above, because that one turns
  // #NOTE into an editing button bound to task.text — wrong for a standalone note. All user text is
  // placed via textContent (never innerHTML), and link hrefs are sanitized, so this is XSS-safe.

  // Inline: `code`, $latex$, **bold**, *italic* / _italic_, and [text](url).
  const CONTEXT_INLINE_RE =
    /`([^`\n]+)`|\$([^$\n]+)\$|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|_([^_\n]+)_|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

  // Only allow safe link schemes (or a relative / in-page target). Anything else renders as plain
  // text so a note can't smuggle in a javascript: link.
  function contextSafeUrl(url) {
    const u = String(url || '').trim();
    if (/^(https?:|mailto:)/i.test(u)) return u;
    if (/^[/#]/.test(u)) return u;
    return null;
  }

  function renderContextInline(parent, text) {
    CONTEXT_INLINE_RE.lastIndex = 0;
    let last = 0;
    let m;
    while ((m = CONTEXT_INLINE_RE.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[1] !== undefined) {
        const code = document.createElement('code');
        code.className = 'context-note-code';
        code.textContent = m[1];
        parent.appendChild(code);
      } else if (m[2] !== undefined) {
        renderLatexInto(parent, m[2]);
      } else if (m[3] !== undefined) {
        const b = document.createElement('strong');
        b.textContent = m[3];
        parent.appendChild(b);
      } else if (m[4] !== undefined || m[5] !== undefined) {
        const it = document.createElement('em');
        it.textContent = m[4] !== undefined ? m[4] : m[5];
        parent.appendChild(it);
      } else if (m[6] !== undefined && m[7] !== undefined) {
        const href = contextSafeUrl(m[7]);
        if (href) {
          const a = document.createElement('a');
          a.href = href;
          a.textContent = m[6];
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.className = 'context-note-link';
          parent.appendChild(a);
        } else {
          parent.appendChild(document.createTextNode(m[0]));
        }
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  // Block level: # / ## / ### headings, - / * / + bullets, 1. numbered lists, > quotes, ``` fenced
  // code, --- rules, and blank-line-separated paragraphs. Renders `text` into (a cleared) `container`.
  function renderContextNote(container, text) {
    container.innerHTML = '';
    const src = String(text == null ? '' : text);
    if (!src.trim()) {
      const empty = document.createElement('div');
      empty.className = 'context-note-empty';
      empty.textContent = 'No context yet. Click Edit to write a note for switching back to this task.';
      container.appendChild(empty);
      return;
    }
    const lines = src.split('\n');
    let list = null; // the <ul>/<ol> currently being filled (consecutive list lines share one)
    const flushList = () => {
      if (list) {
        container.appendChild(list);
        list = null;
      }
    };
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      // Fenced code block: gather every line until the closing fence (or end of text).
      const fence = /^\s*```(.*)$/.exec(line);
      if (fence) {
        flushList();
        const pre = document.createElement('pre');
        pre.className = 'context-note-pre';
        const code = document.createElement('code');
        const body = [];
        i += 1;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
          body.push(lines[i]);
          i += 1;
        }
        code.textContent = body.join('\n');
        pre.appendChild(code);
        container.appendChild(pre);
        i += 1; // skip the closing fence
        continue;
      }
      const heading = /^(#{1,3})\s+(.*)$/.exec(line);
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      const quote = /^\s*>\s?(.*)$/.exec(line);
      const isRule = /^\s*(---+|\*\*\*+|___+)\s*$/.test(line);
      if (heading) {
        flushList();
        const level = heading[1].length; // 1..3
        const el = document.createElement(level === 1 ? 'h3' : level === 2 ? 'h4' : 'h5');
        el.className = 'context-note-h context-note-h' + level;
        renderContextInline(el, heading[2]);
        container.appendChild(el);
      } else if (isRule) {
        flushList();
        const hr = document.createElement('hr');
        hr.className = 'context-note-hr';
        container.appendChild(hr);
      } else if (bullet) {
        if (!list || list.tagName !== 'UL') {
          flushList();
          list = document.createElement('ul');
          list.className = 'context-note-ul';
        }
        const li = document.createElement('li');
        renderContextInline(li, bullet[1]);
        list.appendChild(li);
      } else if (numbered) {
        if (!list || list.tagName !== 'OL') {
          flushList();
          list = document.createElement('ol');
          list.className = 'context-note-ol';
        }
        const li = document.createElement('li');
        renderContextInline(li, numbered[1]);
        list.appendChild(li);
      } else if (quote) {
        flushList();
        const bq = document.createElement('blockquote');
        bq.className = 'context-note-quote';
        renderContextInline(bq, quote[1]);
        container.appendChild(bq);
      } else if (line.trim() === '') {
        flushList(); // blank line ends any run of list items; spacing comes from CSS
      } else {
        flushList();
        const p = document.createElement('div');
        p.className = 'context-note-p';
        renderContextInline(p, line);
        container.appendChild(p);
      }
      i += 1;
    }
    flushList();
  }

  // The "current" checklist line: the first line that isn't a completed ([x]) checkbox. Ticking the
  // top item off advances this to the next line, so the highlight tint + the pills follow the work
  // down the list. Never advances past the last line (there'd be no next line to move to).
  function firstActiveLineIndex(lines) {
    let i = 0;
    while (i < lines.length - 1 && /^\s*\[[xX]\]/.test(lines[i])) i += 1;
    return i;
  }

  // The first line's tint tracks the lifecycle: working → done → needs-input → manual-wait (none when idle).
  function taskAgentStateClass(task) {
    const isFinished = task.status === 'todo' && !!task.watch_finished;
    if (isFinished && task.watch_finished.needs_input) return 'fl-needsinput';
    if (isFinished) return 'fl-done';
    if (task.status === 'waiting') return taskHasWatcher(task) ? 'fl-working' : 'fl-waiting';
    return '';
  }

  // Display-mode render of the whole task text. First line = "working on now".
  function makeTaskDisplay(project, task) {
    const wrap = document.createElement('div');
    wrap.className = 'task-text task-text-rich';
    let promptCounter = 0;
    const ctx = { project, task, nextPromptIndex: () => promptCounter++ };
    // "hide progress" collapses the waiting/working pills; also drop the first-line tint that mirrors them.
    const progressHidden = state.taskProgressHiddenIds.has(task.id);
    const stateClass = progressHidden ? '' : taskAgentStateClass(task);
    const lines = String(task.text || '').split('\n');
    // Highlight (and anchor the pills to) the first not-yet-done line rather than always line 0.
    const currentIdx = firstActiveLineIndex(lines);
    lines.forEach((line, idx) => {
      const lineEl = document.createElement('div');
      lineEl.className = 'task-line';
      if (idx === currentIdx) {
        lineEl.classList.add('task-line-current');
        if (stateClass) lineEl.classList.add(stateClass);
      }
      renderLineInto(lineEl, line, ctx, idx);
      wrap.appendChild(lineEl);
    });
    wrap.addEventListener('click', (e) => {
      if (e.target.closest('.tl-interactive')) return;
      if (window.getSelection && String(window.getSelection()).length) return;
      beginTaskEdit(task);
    });
    return wrap;
  }

  function toggleCheckboxLine(project, task, lineIdx) {
    const lines = String(task.text || '').split('\n');
    if (lineIdx < 0 || lineIdx >= lines.length) return;
    lines[lineIdx] = lines[lineIdx].replace(
      /^(\s*)\[( |x|X)\]/,
      (full, sp, mark) => `${sp}[${mark.toLowerCase() === 'x' ? ' ' : 'x'}]`
    );
    patchTask(project, task, { text: lines.join('\n') });
  }

  function removeTaskLine(project, task, lineIdx) {
    const lines = String(task.text || '').split('\n');
    if (lineIdx < 0 || lineIdx >= lines.length) return;
    lines.splice(lineIdx, 1);
    const next = lines.join('\n');
    if (!next.trim()) {
      toast('A task needs at least one line', true);
      return;
    }
    patchTask(project, task, { text: next });
  }

  // #NOTE / #PROMPT both store their body inline as #<KIND>{{...}} (newlines encoded as \n).
  // The two behave identically; only the pill label differs. The keyword is always preserved.
  function replaceNthPromptToken(text, n, content) {
    const re = /#(NOTE|PROMPT)(?:\{\{[\s\S]*?\}\})?/g;
    let i = -1;
    return String(text).replace(re, (match, kw) => {
      i += 1;
      if (i !== n) return match;
      const safe = String(content).replace(/\n/g, '\\n').replace(/\}\}/g, '} }');
      return safe ? `#${kw}{{${safe}}}` : `#${kw}`;
    });
  }

  // While editing a task's text box we show note/prompt tokens bare (just "#NOTE"/"#PROMPT"), so
  // their body isn't dumped inline. The bodies are pulled out here (in order) and re-attached on save.
  const NOTE_TOKEN_RE = /#(NOTE|PROMPT)(?:\{\{([\s\S]*?)\}\})?/g;

  function stripNoteBodies(text) {
    const bodies = [];
    NOTE_TOKEN_RE.lastIndex = 0;
    const display = String(text).replace(NOTE_TOKEN_RE, (_full, kw, inner) => {
      bodies.push(inner !== undefined ? inner : '');
      return `#${kw}`;
    });
    return { display, bodies };
  }

  function restoreNoteBodies(text, bodies) {
    const list = bodies || [];
    let i = -1;
    NOTE_TOKEN_RE.lastIndex = 0;
    return String(text).replace(NOTE_TOKEN_RE, (_full, kw, inner) => {
      i += 1;
      // A body the user typed inline while editing wins; otherwise re-attach the stripped one.
      if (inner) return `#${kw}{{${inner}}}`;
      const body = list[i];
      return body ? `#${kw}{{${body}}}` : `#${kw}`;
    });
  }

  // Plain-text task text for read-only previews (e.g. the Focus modal): show notes/prompts as a
  // marker instead of dumping their body inline.
  function taskTextForPreview(text) {
    NOTE_TOKEN_RE.lastIndex = 0;
    return String(text || '').replace(NOTE_TOKEN_RE, (_full, kw) =>
      kw === 'PROMPT' ? '[Prompt]' : '[Note]'
    );
  }

  // A "#TITLE Provider : Chat title" directive on the FIRST line sets the task's provider + title
  // (a manual version of what watching an agent does) and is then stripped from the task body.
  // "#TITLE Provider" (no colon) sets just the provider and leaves any existing title alone.
  function parseTitleDirective(text) {
    const raw = String(text || '');
    const nl = raw.indexOf('\n');
    const firstLine = (nl === -1 ? raw : raw.slice(0, nl)).trim();
    const m = /^#TITLE\s+(.+)$/i.exec(firstLine);
    if (!m) return null;
    const rest = m[1].trim();
    const colon = rest.indexOf(':');
    const provider = (colon === -1 ? rest : rest.slice(0, colon)).trim();
    const title = colon === -1 ? '' : rest.slice(colon + 1).trim();
    const remaining = nl === -1 ? '' : raw.slice(nl + 1);
    return { provider, title, remaining };
  }

  // Build the request body for a task whose text may start with a #TITLE directive. The directive
  // line only sets the title/provider — the task text is whatever is UNDER that line (may be empty).
  function taskBodyFromText(text) {
    const directive = parseTitleDirective(text);
    if (!directive) return { text };
    const body = { text: directive.remaining.trim(), title_provider: directive.provider };
    if (directive.title) body.chat_title = directive.title;
    return body;
  }

  function buildPromptButton(project, task, idx, content, kind = 'NOTE') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tl-interactive tl-prompt';
    btn.textContent = kind === 'PROMPT' ? 'prompt' : 'note';
    btn.title = 'Click: open · Double-click: copy';
    let clickTimer = null;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (clickTimer) return;
      clickTimer = setTimeout(() => {
        clickTimer = null;
        openPromptPopover(btn, project, task, idx, content, kind);
      }, 220);
    });
    btn.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
      }
      copyText(content);
      toast('Prompt copied');
    });
    return btn;
  }

  function closePromptPopover() {
    if (state.promptPopover) {
      state.promptPopover.remove();
      state.promptPopover = null;
    }
    if (state.promptPopoverOutside) {
      document.removeEventListener('mousedown', state.promptPopoverOutside, true);
      state.promptPopoverOutside = null;
    }
  }

  function openPromptPopover(anchor, project, task, idx, content, kind = 'NOTE') {
    closePromptPopover();
    const pop = document.createElement('div');
    pop.className = 'prompt-popover';

    // Header doubles as a drag handle to move the popover around.
    const header = document.createElement('div');
    header.className = 'prompt-popover-header';
    header.textContent = kind === 'PROMPT' ? 'Prompt' : 'Note';
    header.title = 'Drag to move';
    header.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const rect = pop.getBoundingClientRect();
      const dx = e.clientX - rect.left;
      const dy = e.clientY - rect.top;
      const onMove = (ev) => {
        pop.style.left = `${Math.max(4, Math.min(ev.clientX - dx, window.innerWidth - 60))}px`;
        pop.style.top = `${Math.max(4, Math.min(ev.clientY - dy, window.innerHeight - 40))}px`;
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    const ta = document.createElement('textarea');
    ta.className = 'prompt-popover-text';
    ta.value = content || '';
    ta.placeholder = 'Type a prompt…';
    // On open, size the box to the note (capped). While typing, only GROW to fit new content so a
    // manual resize (resize: both) is never shrunk back under the user.
    const cap = 360;
    const fitPromptHeight = () => {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(cap, Math.max(84, ta.scrollHeight))}px`;
    };
    ta.addEventListener('input', () => {
      if (ta.scrollHeight > ta.clientHeight && ta.clientHeight < cap) {
        ta.style.height = `${Math.min(cap, ta.scrollHeight)}px`;
      }
    });
    const row = document.createElement('div');
    row.className = 'prompt-popover-row';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'prompt-popover-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      copyText(ta.value);
      toast('Prompt copied');
    });
    const doSave = () => {
      const next = replaceNthPromptToken(task.text, idx, ta.value);
      closePromptPopover();
      patchTask(project, task, { text: next });
    };
    // Cmd/Ctrl+S saves and closes, same as the Save button.
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        doSave();
      }
    });
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'prompt-popover-btn primary';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', doSave);
    row.append(copyBtn, saveBtn);
    pop.append(header, ta, row);
    document.body.appendChild(pop);
    fitPromptHeight();
    // Position so the whole box (including Save) stays on screen — it's position:fixed, so if it
    // ran off the bottom you couldn't scroll to reach the buttons.
    const r = anchor.getBoundingClientRect();
    const margin = 8;
    const rect = pop.getBoundingClientRect();
    const left = Math.max(margin, Math.min(r.left, window.innerWidth - rect.width - margin));
    let top = r.bottom + 6;
    if (top + rect.height > window.innerHeight - margin) {
      // Doesn't fit below the pill: flip above it, or clamp into view if it fits neither way.
      const above = r.top - 6 - rect.height;
      top = above >= margin ? above : Math.max(margin, window.innerHeight - margin - rect.height);
    }
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    state.promptPopover = pop;
    state.promptPopoverOutside = (e) => {
      if (!pop.contains(e.target) && e.target !== anchor) closePromptPopover();
    };
    document.addEventListener('mousedown', state.promptPopoverOutside, true);
    setTimeout(() => ta.focus(), 0);
  }

  // Wrap the current selection in the edit textarea (Cmd/Ctrl+B / +I).
  function wrapSelection(ta, marker) {
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const sel = ta.value.slice(s, e);
    ta.value = ta.value.slice(0, s) + marker + sel + marker + ta.value.slice(e);
    state.editingTaskDraft = ta.value;
    ta.setSelectionRange(s + marker.length, s + marker.length + sel.length);
    fitTaskTextInputHeight(ta);
  }

  // Whether a task carries any title/location meta or a live watcher — the condition under
  // which the meta line is shown.
  function taskHasTitleMeta(task) {
    return !!(
      (task.title_provider || '').trim() ||
      (task.chat_title || '').trim() ||
      (task.manual_location || '').trim() ||
      taskHasWatcher(task) ||
      task.paused_watch_tracking ||
      task.completed_watch_tracking
    );
  }

  // The auto-generated agent header — one clean line above the task row, shown once a task carries
  // any title meta or a live watcher. Order, left → right (all vertically centered): two drag-column
  // spacers, the platform logo (over the checkbox, tinted to the brand), the chat title, the
  // platform name, a location icon, then the folder. Display-only; provider / chat title / location
  // are edited from the "Add title" modal (reached from the monitor modal).
  function buildAgentHeader(project, task) {
    if (!taskHasTitleMeta(task)) return null;

    const tracking =
      getTaskWatchTracking(task) ||
      task.paused_watch_tracking ||
      task.completed_watch_tracking ||
      null;
    const providerKind = (task.provider_kind || '').trim();
    const isProcess = providerKind === 'process' || !!(tracking && tracking.kind === 'process');

    const mk = (cls, text) => {
      const span = document.createElement('span');
      span.className = cls;
      if (text != null) span.textContent = text;
      return span;
    };
    const dot = () => mk('hdr-dot', '·');

    const hdr = document.createElement('div');
    hdr.className = 'task-agent-hdr';

    // A 14px drag spacer + the 16px logo cell reproduce the task row's leading columns (drag 14 ·
    // checkbox 16), so the logo lands directly over the checkbox and the title over the task text.
    // (No delete-× column anymore — the row hover reveals only the drag handle.)
    hdr.appendChild(mk('hdr-drag'));

    const logo = mk('hdr-logo');
    const markKind = isProcess ? 'process' : providerKind;
    const mark = platformMarkSvg(markKind);
    if (mark) {
      logo.innerHTML = mark;
      logo.style.color = platformTintVar(markKind);
    }
    hdr.appendChild(logo);

    // Middle segments, joined by muted separator dots — only present segments get a dot.
    const segments = [];

    const platformLabel = isProcess ? 'Terminal process' : (task.title_provider || '').trim();
    let chatTitle = (task.chat_title || '').trim();
    if (isProcess && tracking && tracking.command) chatTitle = String(tracking.command).trim();

    // The chat title is the headline; if a watcher couldn't resolve one, fall back to the platform
    // label so the line still reads (and then drop the separate platform segment).
    let titleText = chatTitle;
    let showPlatform = true;
    if (!titleText) {
      titleText = platformLabel;
      showPlatform = false;
    }
    if (titleText) {
      const titleEl = mk(isProcess ? 'hdr-title mono' : 'hdr-title', titleText);
      titleEl.title = titleText;
      segments.push(titleEl);
    }

    if (showPlatform && platformLabel) segments.push(mk('hdr-plat', platformLabel));

    const locKind = headerLocationKind(task, tracking, isProcess);
    if (locKind) {
      const loc = mk('hdr-loc');
      loc.innerHTML = hdrLocationIconSvg(locKind);
      loc.title = HDR_LOCATION_LABELS[locKind] || '';
      segments.push(loc);
    }

    const folder = buildHeaderFolderCell(task, tracking, isProcess, mk);
    if (folder) segments.push(folder);

    segments.forEach((segEl, i) => {
      if (i > 0) hdr.appendChild(dot());
      hdr.appendChild(segEl);
    });

    // Double-clicking the header opens the "Add Header" modal to edit its provider / title /
    // platform / location. (openAddTitleModal is defined later in this IIFE — fine for a handler.)
    hdr.title = 'Double-click to edit header';
    hdr.style.cursor = 'pointer';
    hdr.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      openAddTitleModal(project, task);
    });

    return hdr;
  }

  // Which location glyph to show: browser globe for a browser chat, else the agent's surface
  // (cli / desktop / plugin). Terminal processes show none.
  function headerLocationKind(task, tracking, isProcess) {
    if (isProcess) return '';
    if ((task.location_kind || '') === 'browser' || (tracking && tracking.kind === 'browser_chat')) {
      return 'browser';
    }
    const surface = (task.surface_kind || '').trim();
    return surface === 'cli' || surface === 'desktop' || surface === 'plugin' ? surface : '';
  }

  // The trailing folder cell: the workspace folder name (monospace), "browser chat" (italic) for a
  // browser chat, or "PID <n>" for a tracked terminal process.
  function buildHeaderFolderCell(task, tracking, isProcess, mk) {
    if (isProcess) {
      const pid = tracking && (tracking.pid || tracking.pid === 0) ? tracking.pid : null;
      const label = pid != null ? `PID ${pid}` : (task.manual_location || '').trim();
      return label ? mk('hdr-folder', label) : null;
    }
    if ((task.location_kind || '') === 'browser' || (tracking && tracking.kind === 'browser_chat')) {
      return mk('hdr-folder browser', 'browser chat');
    }
    const loc = (task.manual_location || '').trim();
    return loc ? mk('hdr-folder', loc) : null;
  }

  // Resolve the {project, task} the monitor modal is currently open for.
  function modalProjectTask() {
    if (!cursorModalContext) return null;
    const project = state.data.projects.find((p) => p.id === cursorModalContext.projectId);
    const task = project ? project.tasks.find((t) => t.id === cursorModalContext.taskId) : null;
    return project && task ? { project, task } : null;
  }

  // Reflect the current task's stuck/backlog/focus state on the modal's toggle buttons.
  function updateModalTaskButtons(task) {
    if (els.cursorWaitStuck) els.cursorWaitStuck.classList.toggle('active', !!task.stuck);
    if (els.cursorWaitBacklog) els.cursorWaitBacklog.classList.toggle('active', !!task.is_task_backlog);
    // Focus is always labeled "Focus"; the orange active state means it's editable (has focus targets set).
    if (els.cursorWaitFocus) {
      els.cursorWaitFocus.classList.toggle('active', getTaskFocusCommands(task).length > 0);
    }
    // Context glows indigo once this task has a note written (mirrors how Focus reflects its state).
    if (els.cursorWaitContext) {
      els.cursorWaitContext.classList.toggle('active', !!String(task.context_note || '').trim());
    }
    // "Waiting" glows yellow when the task is a manual wait (waiting status, no agent watcher).
    if (els.cursorWaitManual) {
      els.cursorWaitManual.classList.toggle('active', task.status === 'waiting' && !taskHasWatcher(task));
    }
  }

  // Wraps a pill in a group with a clear × centered directly below it. The × is invisible until
  // you hover exactly over it (see .pill-clear in the CSS).
  function makePillClearGroup(pill, onClear, clearTitle) {
    const group = document.createElement('div');
    group.className = 'pill-group';
    group.appendChild(pill);
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'pill-clear';
    x.textContent = '×';
    x.title = clearTitle;
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      onClear();
    });
    group.appendChild(x);
    return group;
  }

  // Row pills for stuck/backlog. They're turned ON from the monitor modal; once on, their pill shows
  // on the task here, each with a clear × centered below it. Stuck: drag onto the blocking task to link.
  function buildStuckPill(project, task) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'pill pill-toggle stuck';
    pill.textContent = 'stuck';
    pill.title = 'Stuck — click-hold and drag onto the task that is blocking this one.';
    attachStuckDrag(pill, project, task);
    return makePillClearGroup(pill, () => patchTask(project, task, { stuck: false }), 'Clear stuck');
  }

  function buildBacklogPill(project, task) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'pill pill-toggle backlog';
    pill.textContent = 'backlog';
    pill.title = 'In backlog';
    return makePillClearGroup(
      pill,
      () => patchTask(project, task, { is_task_backlog: false }),
      'Remove from backlog'
    );
  }

  // Neutral "off" backlog pill shown on tasks that are NOT in the backlog, so you can add one with a
  // single click without opening the monitor modal. Uncolored like the monitor eye's off state; the
  // row only shows it while backlog tasks are visible ("Hide Backlog" state) — see the caller.
  function buildBacklogTogglePill(project, task) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'pill pill-toggle backlog off';
    pill.textContent = 'backlog';
    pill.title = 'Add to backlog';
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      patchTask(project, task, { is_task_backlog: true });
    });
    return pill;
  }

  // Drag from the row stuck pill onto another task to mark it as the blocker.
  function attachStuckDrag(pill, project, task) {
    let startX = 0;
    let startY = 0;
    let moved = false;
    let dragging = false;
    const onMove = (e) => {
      if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) > 6) {
        moved = true;
        dragging = true;
        startBlockerDrag(task);
      }
      if (dragging) updateBlockerDrag(e.clientX, e.clientY);
    };
    const onUp = (e) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (dragging) finishBlockerDrag(project, task, e.clientX, e.clientY);
      dragging = false;
      moved = false;
    };
    pill.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      startX = e.clientX;
      startY = e.clientY;
      moved = false;
      dragging = false;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // The monitor modal's "stuck" button behaves like the row stuck pill: a plain click turns stuck on
  // and closes the modal; click-and-hold-drag closes the modal (revealing the task list) and drags
  // the blocker arrow onto the task that's blocking this one.
  function attachModalStuckDrag(pill) {
    let startX = 0;
    let startY = 0;
    let moved = false;
    let dragging = false;
    let ctx = null;
    const onMove = (e) => {
      if (!ctx) return;
      if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) > 6) {
        moved = true;
        dragging = true;
        closeCursorModal(); // reveal the task list so you can drop onto a task
        startBlockerDrag(ctx.task);
      }
      if (dragging) updateBlockerDrag(e.clientX, e.clientY);
    };
    const onUp = (e) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (dragging && ctx) {
        finishBlockerDrag(ctx.project, ctx.task, e.clientX, e.clientY);
      } else if (ctx) {
        // Plain click (no drag): turn stuck on and close the modal.
        closeCursorModal();
        patchTask(ctx.project, ctx.task, { stuck: true });
      }
      ctx = null;
      dragging = false;
      moved = false;
    };
    pill.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      ctx = modalProjectTask();
      if (!ctx) return;
      e.preventDefault();
      startX = e.clientX;
      startY = e.clientY;
      moved = false;
      dragging = false;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function startBlockerDrag(task) {
    state.blockerDrag = { fromId: task.id, x: 0, y: 0 };
    document.body.classList.add('blocker-dragging');
  }

  function updateBlockerDrag(x, y) {
    if (!state.blockerDrag) return;
    state.blockerDrag.x = x;
    state.blockerDrag.y = y;
    const el = document.elementFromPoint(x, y);
    const li = el && el.closest ? el.closest('.task-item') : null;
    els.taskList.querySelectorAll('.task-item.blocker-target').forEach((n) => n.classList.remove('blocker-target'));
    if (li && li.dataset.id !== state.blockerDrag.fromId) li.classList.add('blocker-target');
    renderBlockerLines();
  }

  function finishBlockerDrag(project, task, x, y) {
    const el = document.elementFromPoint(x, y);
    const li = el && el.closest ? el.closest('.task-item') : null;
    document.body.classList.remove('blocker-dragging');
    els.taskList.querySelectorAll('.task-item.blocker-target').forEach((n) => n.classList.remove('blocker-target'));
    const targetId = li ? li.dataset.id : null;
    state.blockerDrag = null;
    if (targetId && targetId !== task.id) {
      patchTask(project, task, { blocking_task_id: targetId, stuck: true });
    } else {
      renderBlockerLines();
    }
  }

  function ensureBlockerSvg() {
    let svg = document.getElementById('blocker-lines');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = 'blocker-lines';
      svg.innerHTML =
        '<defs><marker id="bl-arrow" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">' +
        '<path d="M0,0 L7,3 L0,6 Z" fill="currentColor"/></marker></defs>';
      document.body.appendChild(svg);
      if (!state.blockerLinesHooked) {
        state.blockerLinesHooked = true;
        window.addEventListener('resize', () => {
          alignTaskPillsToCurrentLine();
          renderBlockerLines();
        });
        window.addEventListener('scroll', () => renderBlockerLines(), true);
      }
    }
    return svg;
  }

  function renderBlockerLines() {
    const svg = ensureBlockerSvg();
    svg.querySelectorAll('.bl-line').forEach((n) => n.remove());
    const project = getSelectedProject();
    const rectFor = (id) => {
      const li = els.taskList.querySelector(`.task-item[data-id="${(window.CSS && CSS.escape ? CSS.escape(id) : id)}"]`);
      return li ? li.getBoundingClientRect() : null;
    };
    const addLine = (x1, y1, x2, y2, cls) => {
      const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      l.setAttribute('x1', x1);
      l.setAttribute('y1', y1);
      l.setAttribute('x2', x2);
      l.setAttribute('y2', y2);
      l.setAttribute('class', `bl-line ${cls || ''}`);
      l.setAttribute('marker-end', 'url(#bl-arrow)');
      svg.appendChild(l);
    };
    if (project && Array.isArray(project.tasks)) {
      project.tasks.forEach((t) => {
        if (!t.blocking_task_id) return;
        const a = rectFor(t.id);
        const b = rectFor(t.blocking_task_id);
        if (!a || !b) return;
        addLine(a.left + 10, a.top + a.height / 2, b.left + 10, b.top + b.height / 2, 'persist');
      });
    }
    if (state.blockerDrag && state.blockerDrag.x) {
      const a = rectFor(state.blockerDrag.fromId);
      if (a) addLine(a.left + 10, a.top + a.height / 2, state.blockerDrag.x, state.blockerDrag.y, 'temp');
    }
  }

  function buildTaskItem(project, task) {
    const li = document.createElement('li');
    li.className = 'task-item';
    li.dataset.id = task.id;
    if (task.status === 'done') li.classList.add('done');
    if (task.stuck) li.classList.add('is-stuck');

    const main = document.createElement('div');
    main.className = 'task-item-main';

    // Left icon column: on hover it reveals only a drag handle (⋮⋮) — delete and hide-progress
    // are no longer inline buttons; they live on the right-click menu and the ⌘ shortcuts.
    const gutter = document.createElement('div');
    gutter.className = 'task-gutter';

    const drag = document.createElement('span');
    drag.className = 'task-drag';
    drag.textContent = '⋮⋮';
    drag.title = 'Drag to reorder';

    const progressHidden = state.taskProgressHiddenIds.has(task.id);

    const check = document.createElement('button');
    check.className = 'task-check';
    check.title = task.status === 'done' ? 'Mark as not done' : 'Mark as done';
    check.addEventListener('click', async () => {
      const next = task.status === 'done' ? 'todo' : 'done';
      await patchTask(project, task, { status: next });
    });

    gutter.append(drag, check);
    main.appendChild(gutter);

    if (progressHidden) li.classList.add('task-progress-hidden');
    if (state.selectedTaskId === task.id) li.classList.add('task-selected');

    const pills = document.createElement('div');
    pills.className = 'task-item-pills';
    // The working/monitor pill and its clear × form ONE column unit, so the × stays pinned
    // under the status pill no matter what other pills (focus, backlog, stuck) sit beside it.
    const monitorGroup = document.createElement('div');
    monitorGroup.className = 'monitor-group';
    let monitorBtnRef = null;
    let clearBtnRef = null;

    // Single "monitor" control. One pill with several looks:
    //  - nothing set   → neutral eye "monitor" (opens the picker)
    //  - agent watcher → blue robot "working" (auto-clears when done)
    //  - manual wait   → yellow hourglass "waiting" (you check it yourself)
    // An × next to an active pill clears it straight back to "monitor".
    // ⌘/Ctrl-click hides this task's progress (status pill + tint) as a shortcut; the gutter eye
    // (left column) is the primary hide/show control and brings it back.
    const isWaiting = task.status === 'waiting';
    const hasWatcher = taskHasWatcher(task);
    const isFinished = task.status === 'todo' && !!task.watch_finished;
    // In live mode a tracked task keeps the STANDARD status pill; it's just decorated with a caret
    // (expands the live-feed card) and, while working, a live timer — same pill, same sizing. The
    // expanded card is a separate element appended after the pills.
    const liveMode = !!(window.LiveFeedUI && LiveFeedUI.isLive(project));
    const liveTracked =
      !progressHidden && liveMode && !!(window.LiveFeedUI && LiveFeedUI.taskLiveBinding(task));
    // Always build the monitor pill — even for a done (crossed-out) task so it doesn't vanish when
    // you tick the checkbox. A done task can't be waiting/tracking/finished (those live in the
    // task's status, now 'done'), so it falls through to the neutral "monitor" eye.
    {
      const monitorBtn = document.createElement('button');
      monitorBtn.type = 'button';
      if (isFinished && task.watch_finished.needs_input) {
        // The needs-input pill splits by gate kind when Orchestra can tell them apart. 'question' and
        // 'permission' get their own glyph + label; 'unknown'/absent keep today's generic pill exactly
        // (byte-identical). All three keep the `needsinput` base class so the hidden-state selectors
        // and the project roll-up still match.
        const gateKind = task.watch_finished.gate_kind;
        if (gateKind === 'question') {
          monitorBtn.className = 'pill pill-toggle needsinput needsinput-question';
          setPillContent(monitorBtn, QUESTION_ICON_SVG, 'question');
          monitorBtn.title =
            'Agent stopped to ask you a question. Click to open working (re-link or set done); ⌘-click to hide progress; click × to dismiss to monitor.';
        } else if (gateKind === 'permission') {
          monitorBtn.className = 'pill pill-toggle needsinput needsinput-permission';
          setPillContent(monitorBtn, PERMISSION_ICON_SVG, 'permission');
          monitorBtn.title =
            'Agent stopped waiting for permission to act. Click to open working (re-link or set done); ⌘-click to hide progress; click × to dismiss to monitor.';
        } else {
          monitorBtn.className = 'pill pill-toggle needsinput';
          setPillContent(monitorBtn, ALERT_ICON_SVG, 'needs input');
          monitorBtn.title =
            'Agent stopped and needs your input (a question or permission). Click to open working (re-link or set done); ⌘-click to hide progress; click × to dismiss to monitor.';
        }
      } else if (isFinished) {
        monitorBtn.className = 'pill pill-toggle finished';
        setPillContent(monitorBtn, CHECK_ICON_SVG, 'done');
        monitorBtn.title =
          'Agent finished. Click to open working (re-link or set done); ⌘-click to hide progress; click × to dismiss to monitor.';
      } else if (isWaiting && hasWatcher) {
        monitorBtn.className = 'pill pill-toggle watching';
        setPillContent(monitorBtn, ROBOT_ICON_SVG, 'tracking');
        monitorBtn.title =
          'Tracking an agent — clears itself when it finishes. Click to change; ⌘-click to hide progress.';
      } else if (isWaiting) {
        monitorBtn.className = 'pill pill-toggle waiting';
        setPillContent(monitorBtn, HOURGLASS_ICON_SVG, formatWaiting(task.waiting_since));
        monitorBtn.title =
          'Waiting — you check this one yourself. Click to switch to tracking an agent; ⌘-click to hide progress.';
      } else {
        monitorBtn.className = 'pill pill-toggle monitor off';
        setPillContent(monitorBtn, EYE_ICON_SVG, 'monitor');
        monitorBtn.title =
          'Monitor this task — watch an agent (auto, clears itself) or just mark it waiting (manual). ⌘-click to hide progress.';
      }
      monitorBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (e.metaKey || e.ctrlKey) {
          state.taskProgressHiddenIds.add(task.id);
          writeTaskProgressHiddenIds(state.taskProgressHiddenIds);
          renderPane();
          return;
        }
        await openCursorWaitModal(project, task);
      });
      monitorBtnRef = monitorBtn;
    }

    // Clear (×) — present for any active monitor (auto, manual, or finished).
    // Sends the task back to "monitor" (status todo also drops any linked
    // watcher server-side; for finished it just acknowledges the green badge).
    if (isWaiting || isFinished) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'cursor-unlink';
      clear.textContent = '×';
      clear.title = isFinished ? 'Dismiss — back to monitor' : 'Clear — back to monitor';
      clear.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (isFinished) await ackFinished(project, task);
        else await patchTask(project, task, { status: 'todo' });
      });
      clearBtnRef = clear;
    }

    // When progress is hidden, the whole monitor-group is CSS-hidden (the status pill and its ×).
    // The gutter eye is the "show" control now — no in-row "show" pill. The remaining pills
    // (focus/stuck/backlog) slide up into the state pill's slot.
    if (monitorBtnRef) {
      if (!progressHidden) monitorGroup.classList.add('has-working');
      // Live mode + tracked: decorate the standard pill with a caret (expands the live-feed card)
      // and, while working, a live timer. Same pill, same sizing — just two small additions.
      if (liveTracked && window.LiveFeedUI && LiveFeedUI.decoratePill) {
        LiveFeedUI.decoratePill(monitorBtnRef, project, task);
      }
      monitorGroup.appendChild(monitorBtnRef);
    }
    if (clearBtnRef) monitorGroup.appendChild(clearBtnRef);

    // Pill order, left → right: the monitor / "done" pill, then focus, stuck, backlog.
    if (monitorGroup.childElementCount > 0) pills.appendChild(monitorGroup);

    const focusCommands = getTaskFocusCommands(task);
    if (focusCommands.length > 0) {
      const focusPill = document.createElement('button');
      focusPill.type = 'button';
      focusPill.className = 'pill pill-toggle task-focus';
      focusPill.textContent = 'focus';
      focusPill.title = 'Focus this task';
      focusPill.addEventListener('click', async (e) => {
        e.stopPropagation();
        await runTaskFocus(project, task);
      });
      pills.appendChild(
        makePillClearGroup(
          focusPill,
          () => patchTask(project, task, { focus_commands: [], focus_items: [] }),
          'Clear focus'
        )
      );
    }

    // Stuck / backlog are switched on from the monitor modal; once on, their pill appears here.
    // Shown for done (crossed-out) tasks too, so ticking the checkbox doesn't hide them.
    // The backlog pill also shows in a neutral "off" state on non-backlog tasks (one-click add),
    // but only while backlog tasks are being shown (the header button reads "Hide Backlog"); in the
    // plain working view (button reads "Show Backlog") non-backlog tasks show no backlog pill.
    if (task.stuck) pills.appendChild(buildStuckPill(project, task));
    if (task.is_task_backlog) {
      pills.appendChild(buildBacklogPill(project, task));
    } else if (state.showTaskBacklog) {
      pills.appendChild(buildBacklogTogglePill(project, task));
    }

    // Context note — a "where I left off" page you write for yourself. You add/open it from the
    // monitor menu (the "Context" button there); the pill only appears on the row once a note
    // exists, as a glanceable indigo "this task has context" badge you can click to reopen.
    if (String(task.context_note || '').trim()) {
      const contextPill = document.createElement('button');
      contextPill.type = 'button';
      contextPill.className = 'pill pill-toggle task-context';
      setPillContent(contextPill, CONTEXT_ICON_SVG, 'context');
      contextPill.title = 'Context note — click to read or edit your re-orientation notes';
      contextPill.addEventListener('click', (e) => {
        e.stopPropagation();
        openContextModal(project, task);
      });
      // Clear × below the pill (like focus/stuck/backlog): empties the note, so the badge disappears.
      pills.appendChild(
        makePillClearGroup(
          contextPill,
          () => patchTask(project, task, { context_note: '' }),
          'Clear context note'
        )
      );
    }

    // Text
    if (state.editingTaskId === task.id) {
      const input = document.createElement('textarea');
      input.rows = 1;
      input.spellcheck = true;
      input.value = state.editingTaskDraft != null ? state.editingTaskDraft : task.text;
      input.className = 'task-text-input';
      const finish = async (commit) => {
        const bodies = state.editingTaskNoteBodies;
        state.editingTaskId = null;
        state.editingTaskDraft = null;
        state.editingTaskNoteBodies = null;
        const val = restoreNoteBodies(input.value.trim(), bodies);
        const directive = parseTitleDirective(val);
        if (commit && directive) {
          await patchTask(project, task, taskBodyFromText(val));
        } else if (commit && val.trim() && val !== task.text) {
          await patchTask(project, task, { text: val });
        } else {
          render();
        }
      };
      input.addEventListener('input', () => {
        state.editingTaskDraft = input.value;
        fitTaskTextInputHeight(input);
      });
      input.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B')) {
          e.preventDefault();
          wrapSelection(input, '**');
          return;
        }
        if ((e.metaKey || e.ctrlKey) && (e.key === 'i' || e.key === 'I')) {
          e.preventDefault();
          wrapSelection(input, '*');
          return;
        }
        if (e.key === 'Enter' && e.shiftKey) return;
        if (e.key === 'Enter' && e.isComposing) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      });
      input.addEventListener('blur', () => {
        if (state.suppressTaskEditBlur) return;
        if (!input.isConnected) return;
        if (state.spellcheckContextMenuOpen) {
          state.pendingSpellcheckBlurFinish = () => {
            if (input.isConnected && !state.suppressTaskEditBlur) finish(true);
          };
          return;
        }
        finish(true);
      });
      main.appendChild(input);
      setTimeout(() => {
        fitTaskTextInputHeight(input);
        input.focus();
        const len = input.value.length;
        input.setSelectionRange(len, len);
      }, 0);
    } else {
      main.appendChild(makeTaskDisplay(project, task));
    }

    // Focus setup ("Focus +") now lives inside the monitor modal.

    // Pills ride on the right of the text row. Kept even while editing so the textarea stops at
    // the left edge of the left-most pill instead of expanding over them; the flex layout
    // (textarea flex:1/min-width:0, pills flex:0 0 auto) shrinks the box to leave room.
    if (pills.childElementCount > 0) main.appendChild(pills);

    // Expanded live-feed card — a full-width item that wraps UNDER the row; the pill stays inline.
    // Present only while this task is expanded (pill caret toggled); the poll adds/removes it.
    if (liveTracked) {
      const card = LiveFeedUI.buildCard(project, task);
      if (card) main.appendChild(card);
    }

    // Row interactions: a plain click selects the row (gray left bar); ⌘/Ctrl-click toggles this
    // task's hidden state (works on hidden rows too, since they have no chip); right-click opens the
    // 2-item menu. Clicks that land on the text (edit), a control, or the live surfaces are ignored.
    main.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey) {
        if (e.target.closest('input, textarea, .task-text')) return; // the pill handles ⌘ itself (stops propagation)
        toggleTaskProgressHidden(task.id);
        return;
      }
      if (e.target.closest('button, a, input, textarea, pixel-bot, .task-text, .task-live-card, .task-gutter')) return;
      if (window.getSelection && String(window.getSelection()).length) return;
      selectTask(task.id);
    });
    main.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      selectTask(task.id, { force: true });
      openTaskContextMenu(e.clientX, e.clientY, project, task);
    });

    // The auto-generated agent header (platform logo · chat title · platform · location · folder)
    // sits above the task's text box.
    const agentHeader = buildAgentHeader(project, task);
    [agentHeader, main].forEach((el) => {
      if (el) li.appendChild(el);
    });

    return li;
  }

  // Single-select a row (the gray left bar). A plain click toggles it off if it's already selected;
  // pass { force: true } (right-click) to always select. Updates the DOM in place — no list rebuild
  // — so it stays snappy and doesn't disturb live cells.
  function selectTask(taskId, opts = {}) {
    const next = !opts.force && state.selectedTaskId === taskId ? null : taskId;
    state.selectedTaskId = next;
    els.taskList.querySelectorAll('.task-item.task-selected').forEach((li) => li.classList.remove('task-selected'));
    if (next) {
      const li = els.taskList.querySelector(`.task-item[data-id="${window.CSS && CSS.escape ? CSS.escape(next) : next}"]`);
      if (li) li.classList.add('task-selected');
    }
  }

  // Toggle a task's "progress hidden" state (the gray overlay + no chip). Used by ⌘-click, the
  // chip's ⌘-click, and the right-click menu.
  function toggleTaskProgressHidden(taskId) {
    if (state.taskProgressHiddenIds.has(taskId)) state.taskProgressHiddenIds.delete(taskId);
    else state.taskProgressHiddenIds.add(taskId);
    writeTaskProgressHiddenIds(state.taskProgressHiddenIds);
    renderPane();
  }

  // Delete a task (with undo support via the deleted-tasks stack). Shared by the right-click menu
  // and the ⌘+Delete shortcut — there is no inline trash button anymore.
  async function deleteTask(project, task) {
    try {
      const taskIndex = project.tasks.findIndex((t) => t.id === task.id);
      await api('DELETE', `/api/projects/${project.id}/tasks/${task.id}`);
      state.deletedTasksStack.push({ task: { ...task }, projectId: project.id, index: taskIndex });
      if (state.selectedTaskId === task.id) state.selectedTaskId = null;
      await refresh();
    } catch (err) {
      toast(err.message, true);
    }
  }

  // The 2-item right-click menu on a task row: Hide/Show progress, Delete task. A single menu lives
  // in the DOM at a time; clicking away or pressing Escape dismisses it.
  function openTaskContextMenu(x, y, project, task) {
    closeTaskContextMenu();
    const menu = document.createElement('div');
    menu.className = 'task-context-menu';
    const hidden = state.taskProgressHiddenIds.has(task.id);
    const item = (label, onClick, danger) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'task-context-menu-item' + (danger ? ' danger' : '');
      btn.textContent = label;
      btn.addEventListener('click', () => {
        closeTaskContextMenu();
        onClick();
      });
      return btn;
    };
    menu.appendChild(item(hidden ? 'Show progress' : 'Hide progress', () => toggleTaskProgressHidden(task.id)));
    menu.appendChild(item('Delete task', () => deleteTask(project, task), true));
    document.body.appendChild(menu);
    // Keep the menu on-screen (nudge it in from the right/bottom edges).
    const rect = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;
    state.taskContextMenuEl = menu;
    // Defer the dismiss listeners so this same click/contextmenu doesn't immediately close it.
    setTimeout(() => {
      document.addEventListener('mousedown', onTaskContextMenuAway, true);
      document.addEventListener('keydown', onTaskContextMenuKey, true);
    }, 0);
  }

  function closeTaskContextMenu() {
    if (state.taskContextMenuEl) {
      state.taskContextMenuEl.remove();
      state.taskContextMenuEl = null;
      document.removeEventListener('mousedown', onTaskContextMenuAway, true);
      document.removeEventListener('keydown', onTaskContextMenuKey, true);
    }
  }

  function onTaskContextMenuAway(e) {
    if (state.taskContextMenuEl && !state.taskContextMenuEl.contains(e.target)) closeTaskContextMenu();
  }

  function onTaskContextMenuKey(e) {
    if (e.key === 'Escape') closeTaskContextMenu();
  }

  // ⌘+Delete — delete the selected task (via the shared deleteTask, so undo still works).
  function deleteSelectedTask() {
    const project = getSelectedProject();
    if (!project) return;
    const task = project.tasks.find((t) => t.id === state.selectedTaskId);
    if (task) deleteTask(project, task);
  }

  // ⌘+↑ / ⌘+↓ — move the selected task up/down among the visible rows and persist the new order.
  async function moveSelectedTask(delta) {
    const project = getSelectedProject();
    if (!project) return;
    const showBacklog = state.showTaskBacklog;
    const visible = project.tasks.filter((t) => showBacklog || !t.is_task_backlog);
    const idx = visible.findIndex((t) => t.id === state.selectedTaskId);
    if (idx === -1) return;
    const target = idx + delta;
    if (target < 0 || target >= visible.length) return;
    const visibleIds = visible.map((t) => t.id);
    const moved = visibleIds.splice(idx, 1)[0];
    visibleIds.splice(target, 0, moved);
    const ids = getFullTaskOrderAfterVisibleReorder(project, visibleIds, showBacklog);
    try {
      await api('POST', `/api/projects/${project.id}/tasks/reorder`, { ids });
      await refresh();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function patchTask(project, task, patch) {
    try {
      await api('PATCH', `/api/projects/${project.id}/tasks/${task.id}`, patch);
      await refresh();
    } catch (err) {
      toast(err.message, true);
    }
  }

  // Dismiss the green "agent finished" state → back to plain monitor.
  async function ackFinished(project, task) {
    try {
      await api('POST', `/api/projects/${project.id}/tasks/${task.id}/watch-ack`);
      await refresh();
    } catch (err) {
      toast(err.message, true);
    }
  }

  // Show the green "done" pill without crossing out the task.
  async function markWatchDone(project, task) {
    try {
      await api('POST', `/api/projects/${project.id}/tasks/${task.id}/watch-complete`);
      await refresh();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function runTaskFocus(project, task) {
    try {
      const result = await api('POST', `/api/projects/${project.id}/tasks/${task.id}/focus`);
      if (!result.ok) {
        toast(result.error || 'Task focus failed', true);
      } else if (result.error) {
        toast(`Warning: ${result.error}`, true);
      }
    } catch (err) {
      toast(err.message, true);
    }
  }

  function openTaskFocusModal(project, task) {
    taskFocusContext = { projectId: project.id, taskId: task.id };
    els.taskFocusTaskText.textContent = taskTextForPreview(task.text);
    renderWorkspaceItems(els.taskFocusForm, getTaskFocusItems(task));
    els.taskFocusClear.hidden = getTaskFocusCommands(task).length === 0;
    const focusTargetOptions = els.taskFocusForm.querySelector('[data-focus-target-options]');
    if (focusTargetOptions) focusTargetOptions.hidden = true;
    els.taskFocusModal.hidden = false;
    setTimeout(() => {
      const firstInput = els.taskFocusForm.querySelector('[data-workspace-field]');
      firstInput?.focus();
    }, 0);
  }

  function closeTaskFocusModal() {
    els.taskFocusModal.hidden = true;
    taskFocusContext = null;
    els.taskFocusTaskText.textContent = '';
    const container = els.taskFocusForm.querySelector('[data-workspace-items]');
    if (container) container.innerHTML = '';
    const focusTargetOptions = els.taskFocusForm.querySelector('[data-focus-target-options]');
    if (focusTargetOptions) focusTargetOptions.hidden = true;
  }

  function closeCursorModal() {
    stopCursorModalAutoRefresh();
    els.cursorRunModal.hidden = true;
    cursorModalContext = null;
  }

  // Manual provider + title entry. Persists the same task.title_provider / manual_title fields a
  // watcher would set, so watching an agent later overwrites whatever the user typed here.
  function openAddTitleModal(project, task) {
    addTitleContext = { projectId: project.id, taskId: task.id };
    els.addTitleProvider.value = (task.title_provider || '').trim();
    els.addTitleText.value = (task.chat_title || task.title || '').trim();
    els.addTitleLocation.value = (task.manual_location || '').trim();
    addTitleSurface = (task.surface_kind || '').trim();
    renderAddTitlePlatformPicker();
    els.addTitleModal.hidden = false;
    setTimeout(() => els.addTitleProvider.focus(), 0);
  }

  function closeAddTitleModal() {
    els.addTitleModal.hidden = true;
    addTitleContext = null;
    els.addTitleProvider.value = '';
    els.addTitleText.value = '';
    els.addTitleLocation.value = '';
    addTitleSurface = '';
    renderAddTitlePlatformPicker();
  }

  // --- Context note modal ---
  // A short label for the task the note belongs to (its chat/header title, else its first line of
  // text) so you know which task you're reading context for.
  function taskContextLabel(task) {
    const title = String(task.chat_title || task.manual_title || task.title || '').trim();
    if (title) return title;
    return taskTextForPreview(task.text || '');
  }

  function contextNoteModalTarget() {
    if (!contextNoteContext) return {};
    const project = state.data.projects.find((p) => p.id === contextNoteContext.projectId);
    const task = project ? project.tasks.find((t) => t.id === contextNoteContext.taskId) : null;
    return { project, task };
  }

  // Flip between reading (rendered markdown) and editing (raw textarea). The Close button stays
  // visible in both; Edit shows while reading, Save/Cancel while editing.
  function setContextNoteMode(editing) {
    els.contextNoteView.hidden = editing;
    els.contextNoteTextarea.hidden = !editing;
    els.contextNoteEdit.hidden = editing;
    els.contextNoteSave.hidden = !editing;
    els.contextNoteCancel.hidden = !editing;
    if (editing) setTimeout(() => els.contextNoteTextarea.focus(), 0);
  }

  function openContextModal(project, task) {
    contextNoteContext = { projectId: project.id, taskId: task.id };
    els.contextNoteSubtitle.textContent = taskContextLabel(task);
    const note = String(task.context_note || '');
    els.contextNoteTextarea.value = note;
    renderContextNote(els.contextNoteView, note);
    els.contextNoteModal.hidden = false;
    // Empty note → open straight into edit mode so you can start typing right away.
    setContextNoteMode(!note.trim());
  }

  function closeContextModal() {
    els.contextNoteModal.hidden = true;
    contextNoteContext = null;
    els.contextNoteTextarea.value = '';
    els.contextNoteView.innerHTML = '';
    els.contextNoteSubtitle.textContent = '';
  }

  async function saveContextNote() {
    const { project, task } = contextNoteModalTarget();
    if (!project || !task) {
      closeContextModal();
      return;
    }
    const value = els.contextNoteTextarea.value;
    // Optimistically show the saved note; patchTask re-fetches the board (which makes the row's
    // indigo context badge appear now that a note exists). The modal stays open on the rendered note.
    renderContextNote(els.contextNoteView, value);
    setContextNoteMode(false);
    await patchTask(project, task, { context_note: value });
  }

  // The Platform picker's three surface toggles (CLI / Desktop / Plugin), reusing the run-picker's
  // SURFACE_ICON_SVGS glyphs. Reflects the selected surface; clicking the active one deselects it,
  // and only one may be active at a time. Re-rendered on open/close and on every toggle.
  const ADD_TITLE_PLATFORM_SURFACES = [
    { surface: 'cli', label: 'CLI' },
    { surface: 'desktop', label: 'Desktop' },
    { surface: 'plugin', label: 'Plugin' },
  ];
  function renderAddTitlePlatformPicker() {
    const host = els.addTitlePlatform;
    if (!host) return;
    host.innerHTML = '';
    ADD_TITLE_PLATFORM_SURFACES.forEach(({ surface, label }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'platform-pick';
      btn.dataset.surface = surface;
      btn.title = label;
      btn.setAttribute('aria-label', label);
      const active = addTitleSurface === surface;
      btn.setAttribute('aria-pressed', String(active));
      btn.classList.toggle('active', active);
      btn.innerHTML = surfaceIconSvg(surface);
      btn.addEventListener('click', () => {
        addTitleSurface = addTitleSurface === surface ? '' : surface;
        renderAddTitlePlatformPicker();
      });
      host.appendChild(btn);
    });
  }

  function addTitleModalTarget() {
    if (!addTitleContext) return {};
    const project = state.data.projects.find((p) => p.id === addTitleContext.projectId);
    const task = project ? project.tasks.find((t) => t.id === addTitleContext.taskId) : null;
    return { project, task };
  }

  function stopCursorModalAutoRefresh() {
    cursorModalAutoRefreshGeneration += 1;
    cursorModalAutoRefreshInFlight = false;
    if (cursorModalAutoRefreshTimer) {
      clearInterval(cursorModalAutoRefreshTimer);
      cursorModalAutoRefreshTimer = null;
    }
  }

  const AUTO_REFRESH_SOURCES = new Set([
    'provider-cursor',
    'provider-openai',
    'provider-claude',
    'provider-gemini',
    'provider-grok',
    'grok-local',
    'cursor-local',
    'cursor-remote',
    'codex-local',
    'codex-remote',
    'claude-ide-local',
    'claude-ide-remote',
    'claude-cowork',
    'gemini-ide-local',
    'gemini-ide-remote',
    'browser-chatgpt',
    'browser-claude',
    'browser-gemini',
    'process-local',
    'process-remote',
  ]);

  const BROWSER_WATCH_SOURCES = new Set(['browser-chatgpt', 'browser-claude', 'browser-gemini']);
  const PROCESS_WATCH_SOURCES = new Set(['process-local', 'process-remote']);

  function autoRefreshIntervalMs(source) {
    if (BROWSER_WATCH_SOURCES.has(source) || PROCESS_WATCH_SOURCES.has(source)) return 700;
    return 700;
  }

  function startCursorModalAutoRefresh() {
    stopCursorModalAutoRefresh();
    if (!cursorModalContext || !cursorModalContext.source) return;
    if (!AUTO_REFRESH_SOURCES.has(cursorModalContext.source)) return;
    const generation = cursorModalAutoRefreshGeneration;
    const intervalMs = autoRefreshIntervalMs(cursorModalContext.source);
    cursorModalAutoRefreshTimer = setInterval(async () => {
      if (!cursorModalContext || els.cursorRunModal.hidden) return;
      if (cursorModalAutoRefreshInFlight) return;
      const source = cursorModalContext.source;
      if (!AUTO_REFRESH_SOURCES.has(source)) return;
      const project = state.data.projects.find((p) => p.id === cursorModalContext.projectId);
      const task = project?.tasks.find((t) => t.id === cursorModalContext.taskId);
      if (!project || !task) return;
      cursorModalAutoRefreshInFlight = true;
      try {
        const refreshQuery = PROCESS_WATCH_SOURCES.has(source) ? els.watchSearch.value.trim() : '';
        await loadModalSource(project, task, source, refreshQuery, { quiet: true });
      } catch {
        // Ignore transient refresh failures while modal stays open.
      } finally {
        if (cursorModalAutoRefreshGeneration === generation) {
          cursorModalAutoRefreshInFlight = false;
        }
      }
    }, intervalMs);
  }

  function setCursorModalTab(tabName) {
    const selected = tabName === 'settings' ? 'settings' : 'watching';
    els.cursorModalTabs.forEach((tab) => {
      const isActive = tab.dataset.cursorModalTab === selected;
      tab.classList.toggle('active', isActive);
      tab.setAttribute('aria-selected', String(isActive));
    });
    els.cursorWatchPanel.hidden = selected !== 'watching';
    els.cursorWatchPanel.classList.toggle('active', selected === 'watching');
    els.cursorSettingsPanel.hidden = selected !== 'settings';
    els.cursorSettingsPanel.classList.toggle('active', selected === 'settings');
  }

  function getWatchGroupConfig(kind) {
    return WATCH_GROUPS[kind] || null;
  }

  function providerKindForLegacyWatchPreference(kind, value) {
    if (kind === 'coding_agent') {
      const normalized =
        value === 'gemini-cli-local'
          ? 'gemini-ide-local'
          : value === 'gemini-cli-remote'
            ? 'gemini-ide-remote'
            : value;
      if (normalized === 'cursor-local' || normalized === 'cursor-remote') return 'cursor';
      if (normalized === 'codex-local' || normalized === 'codex-remote') return 'openai';
      if (
        normalized === 'claude-ide-local' ||
        normalized === 'claude-ide-remote' ||
        normalized === 'claude-cowork'
      ) {
        return 'claude';
      }
      if (normalized === 'gemini-ide-local' || normalized === 'gemini-ide-remote') return 'gemini';
      return 'cursor';
    }
    if (kind === 'llm') {
      if (value === 'claude') return 'claude';
      if (value === 'gemini') return 'gemini';
      return 'openai';
    }
    return WATCH_GROUPS[kind] ? kind : null;
  }

  function readRawProjectWatchPreference(project, kind) {
    if (!project || !kind) return null;
    try {
      const raw = localStorage.getItem(getProjectWatchPreferenceKey(project, kind));
      if (raw != null) return raw;
      return localStorage.getItem(legacyProjectWatchPreferenceKey(project, kind));
    } catch {
      return null;
    }
  }

  function readRawTaskWatchPreference(task, kind) {
    if (!task || !kind) return null;
    try {
      return localStorage.getItem(getTaskWatchPreferenceKey(task, kind));
    } catch {
      return null;
    }
  }

  function normalizeActiveWatchKind(project, task, kind) {
    if (WATCH_GROUPS[kind]) return kind;
    if (kind === 'coding_agent' || kind === 'llm') {
      const raw =
        readRawTaskWatchPreference(task, kind) ||
        readRawProjectWatchPreference(project, kind) ||
        (kind === 'llm' ? 'chatgpt' : 'cursor-local');
      return providerKindForLegacyWatchPreference(kind, raw);
    }
    return null;
  }

  function normalizeWatchPreference(kind, value) {
    const config = getWatchGroupConfig(kind);
    if (!config) return null;
    if (kind === 'cursor' || kind === 'openai' || kind === 'claude' || kind === 'gemini') {
      return config.defaultValue;
    }
    return config.options.some((option) => option.value === value) ? value : config.defaultValue;
  }

  function getProjectWatchPreferenceKey(project, kind) {
    return `${WATCH_PREFERENCE_STORAGE_PREFIX}.${project.id}.${kind}`;
  }

  function legacyProjectWatchPreferenceKey(project, kind) {
    return `${LEGACY_WATCH_PREFERENCE_PREFIX}.${project.id}.${kind}`;
  }

  function readProjectWatchPreference(project, kind) {
    const config = getWatchGroupConfig(kind);
    if (!project || !config) return null;
    try {
      const key = getProjectWatchPreferenceKey(project, kind);
      let raw = localStorage.getItem(key);
      if (raw == null) {
        raw = localStorage.getItem(legacyProjectWatchPreferenceKey(project, kind));
        if (raw != null) {
          try {
            localStorage.setItem(key, raw);
          } catch {
            // Ignore migration failures; preference still applies this session.
          }
        }
      }
      return normalizeWatchPreference(kind, raw);
    } catch {
      return config.defaultValue;
    }
  }

  function writeProjectWatchPreference(project, kind, value) {
    const normalized = normalizeWatchPreference(kind, value);
    if (!project || !normalized) return;
    try {
      localStorage.setItem(getProjectWatchPreferenceKey(project, kind), normalized);
    } catch {
      // Ignore storage failures; the selection still works for the current modal session.
    }
  }

  function getTaskWatchPreferenceKey(task, kind) {
    return `${TASK_WATCH_PREFERENCE_PREFIX}.${task.id}.${kind}`;
  }

  function getTaskActiveKindKey(task) {
    return `${TASK_ACTIVE_KIND_PREFIX}.${task.id}`;
  }

  function readTaskWatchPreference(task, kind) {
    const config = getWatchGroupConfig(kind);
    if (!task || !config) return null;
    try {
      const key = getTaskWatchPreferenceKey(task, kind);
      const raw = localStorage.getItem(key);
      return normalizeWatchPreference(kind, raw);
    } catch {
      return null;
    }
  }

  function writeTaskWatchPreference(task, kind, value) {
    const normalized = normalizeWatchPreference(kind, value);
    if (!task || !normalized) return;
    try {
      localStorage.setItem(getTaskWatchPreferenceKey(task, kind), normalized);
    } catch {
      // Ignore
    }
  }

  function readTaskActiveKindPreference(task) {
    if (!task) return null;
    try {
      return localStorage.getItem(getTaskActiveKindKey(task));
    } catch {
      return null;
    }
  }

  function writeTaskActiveKindPreference(task, kind) {
    if (!task || !kind) return;
    try {
      localStorage.setItem(getTaskActiveKindKey(task), kind);
    } catch {
      // Ignore
    }
  }

  function sourceForWatchPreference(kind, value) {
    const config = getWatchGroupConfig(kind);
    const normalized = normalizeWatchPreference(kind, value);
    return config?.options.find((option) => option.value === normalized)?.source || null;
  }

  function setActiveWatchKind(kind) {
    [...els.watchSourceChoices.querySelectorAll('[data-watch-kind]')].forEach((btn) => {
      const isActive = btn.dataset.watchKind === kind;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', String(isActive));
    });
  }

  function resetWatchPickerUi() {
    setActiveWatchKind(null);
    els.watchSubsourceToggle.hidden = true;
    els.watchSubsourceToggle.classList.remove('coding-agent-toggle');
    els.watchSubsourceToggle.innerHTML = '';
  }

  function renderWatchSubsourceToggle(project, task, kind, selectedValue) {
    const config = getWatchGroupConfig(kind);
    if (!config) {
      els.watchSubsourceToggle.hidden = true;
      els.watchSubsourceToggle.innerHTML = '';
      return;
    }

    const normalized = normalizeWatchPreference(kind, selectedValue);
    els.watchSubsourceToggle.innerHTML = '';
    els.watchSubsourceToggle.classList.remove('coding-agent-toggle');
    if (kind !== 'process') {
      els.watchSubsourceToggle.hidden = true;
      return;
    }
    els.watchSubsourceToggle.hidden = false;

    const label = document.createElement('span');
    label.className = 'watch-subsource-toggle-label';
    label.textContent = config.toggleLabel;

    const options = document.createElement('div');
    options.className = 'watch-subsource-toggle-options';
    options.setAttribute('role', 'group');
    options.setAttribute('aria-label', `${config.label} options`);

    config.options.forEach((option) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isActive = option.value === normalized;
      btn.className = `watch-subsource-toggle-button ${isActive ? 'active' : ''}`;
      btn.textContent = option.label;
      btn.setAttribute('aria-pressed', String(isActive));
      btn.addEventListener('click', async () => {
        if (option.value === normalized) return;
        await activateWatchGroup(project, task, kind, option.value);
      });
      options.appendChild(btn);
    });

    els.watchSubsourceToggle.append(label, options);
  }

  async function activateWatchGroup(project, task, kind, value = null) {
    const config = getWatchGroupConfig(kind);
    if (!config) return;
    if (value === null || value === undefined) {
      value = readTaskWatchPreference(task, kind) || readProjectWatchPreference(project, kind);
    }
    const selectedValue = normalizeWatchPreference(kind, value);
    const source = sourceForWatchPreference(kind, selectedValue);
    if (!selectedValue || !source) return;

    stopCursorModalAutoRefresh();
    writeTaskWatchPreference(task, kind, selectedValue);
    writeProjectWatchPreference(project, kind, selectedValue);
    writeTaskActiveKindPreference(task, kind);
    setActiveWatchKind(kind);
    renderWatchSubsourceToggle(project, task, kind, selectedValue);
    try {
      await loadModalSource(project, task, source, '');
      if (AUTO_REFRESH_SOURCES.has(source)) {
        startCursorModalAutoRefresh();
      } else {
        stopCursorModalAutoRefresh();
      }
    } catch (err) {
      stopCursorModalAutoRefresh();
      toast(err.message, true);
    }
  }

  /** Primary row title for browser watch list: user preview, or tab title if empty. */
  function browserWatchRowLabel(previewRaw, titleRaw, conversationId, url) {
    const preview = String(previewRaw || '').trim();
    if (preview) {
      return preview.length > 72 ? `${preview.slice(0, 72)}…` : preview;
    }
    const title = String(titleRaw || '').trim();
    const isGeneric = !title ||
      /^(chatgpt|claude|gemini|new\s+chat)/i.test(title) ||
      title === conversationId ||
      title === url;
    if (isGeneric) {
      return 'Awaiting title / user message';
    }
    return title.length > 72 ? `${title.slice(0, 72)}…` : title;
  }

  // The real, non-generic browser chat title (or '' if it's still just "ChatGPT"/url/id).
  function browserRealTitle(titleRaw, conversationId, url) {
    const title = String(titleRaw || '')
      .replace(/\s*[-–]\s*(Claude|Google Gemini|Gemini|ChatGPT)\s*$/i, '')
      .trim();
    if (!title) return '';
    if (/^(chatgpt|claude|gemini|new\s+chat)$/i.test(title)) return '';
    if (title === conversationId || title === url) return '';
    return title;
  }

  // Picker-row meta, in order: Platform glyph · Chat title · Surface glyph (cli/plugin/desktop) ·
  // Folder or browser URL · Local/Remote · Remote host (only when remote).
  function clampPickerTitle(t, n = 40) {
    const s = String(t || '').trim();
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
  }
  function localRemoteLabel(source) {
    return source === 'ssh' ? 'Remote' : 'Local';
  }
  // Concise surface name for the picker meta line: where the agent runs (plugin / desktop / CLI).
  function pickerSurfaceLabel(surface) {
    if (surface === 'cli') return 'CLI';
    if (surface === 'desktop') return 'Desktop';
    if (surface === 'plugin') return 'Plugin';
    return '';
  }

  // Minimalist provider glyphs for the watch-picker meta line, keyed by providerIconKind(). Each
  // carries its own width/height so it renders at the right size inside a .row-meta-icon wrapper.
  const PROVIDER_ICON_SVGS = {
    cursor:
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M12 2 21 7v10l-9 5-9-5V7z"/><path d="M12 2v10M12 12l9-5M12 12 3 7"/></svg>',
    openai:
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><ellipse cx="12" cy="12" rx="3.6" ry="8.4"/><ellipse cx="12" cy="12" rx="3.6" ry="8.4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="3.6" ry="8.4" transform="rotate(120 12 12)"/></svg>',
    claude:
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"/></svg>',
    gemini:
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2c.4 5.2 4.4 9.2 9.6 9.6-5.2.4-9.2 4.4-9.6 9.6-.4-5.2-4.4-9.2-9.6-9.6C7.6 11.2 11.6 7.2 12 2Z"/></svg>',
    process:
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/></svg>',
  };
  function providerIconSvg(kind) {
    return PROVIDER_ICON_SVGS[kind] || '';
  }
  // Minimalist surface glyphs for the picker meta line: a terminal (CLI), a monitor (desktop app),
  // or a puzzle piece (editor plugin). Keyed by a run's surface.
  const SURFACE_ICON_SVGS = {
    cli:
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 16h4"/></svg>',
    desktop:
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
    plugin:
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 4.5a1.8 1.8 0 0 1 3.6 0V6h2.9a1 1 0 0 1 1 1v2.9h1.5a1.8 1.8 0 0 1 0 3.6h-1.5V17a1 1 0 0 1-1 1h-2.9v-1.5a1.8 1.8 0 0 0-3.6 0V18H7.1a1 1 0 0 1-1-1v-2.9H4.6a1.8 1.8 0 0 1 0-3.6h1.5V7a1 1 0 0 1 1-1H10z"/></svg>',
  };
  function surfaceIconSvg(kind) {
    return SURFACE_ICON_SVGS[kind] || '';
  }
  function locationLeaf(v) {
    const s = String(v || '')
      .trim()
      .replace(/[\\/]+$/, '');
    if (!s) return '';
    if (s.includes('/')) return s.split('/').filter(Boolean).pop() || '';
    if (s.includes('\\')) return s.split('\\').filter(Boolean).pop() || '';
    if (s.includes('-')) return s.split('-').pop() || s; // cursor project_slug (path → dashes)
    return s;
  }
  // Claude Cowork's workspace_path is the sandbox's per-session outputs dir (leaf "outputs"), not
  // the folder the user picked. Prefer the real "Working folders" — the first folder's name, with a
  // +N suffix when several are attached — and fall back to the workspace leaf when none are known.
  function coworkFolderLabel(run) {
    const names = (Array.isArray(run.working_folders) ? run.working_folders : [])
      .map((f) => locationLeaf(String(f || '').trim()))
      .filter(Boolean);
    if (names.length) return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0];
    return locationLeaf(run.workspace_path);
  }
  // A picker meta line is a dot-delimited row of segments: some are plain text (chat title,
  // folder / URL, Local/Remote, remote host), some are small glyphs (the platform logo and the
  // surface marker). Icon segments carry `alt` text so the whole line still reads correctly in
  // the row's aria-label. buildPickerMeta returns { parts, text }: `parts` drives the visual
  // render (see renderMetaParts), `text` is the accessible/fallback string.
  function metaTextPart(text) {
    const s = String(text == null ? '' : text).trim();
    return s ? { text: s } : null;
  }
  function metaIconPart(svg, alt) {
    return svg ? { icon: svg, alt: String(alt || '').trim() } : null;
  }
  function buildPickerMeta(parts) {
    const clean = parts.filter(Boolean);
    return {
      parts: clean,
      text: clean.map((p) => (p.text != null ? p.text : p.alt)).filter(Boolean).join(' · '),
    };
  }
  // Which PROVIDER_ICON_SVGS glyph represents a picker provider.
  function providerIconKind(provider) {
    if (provider === 'cursor') return 'cursor';
    if (provider === 'codex' || provider === 'chatgpt') return 'openai';
    if (provider === 'claude' || provider === 'claude_cowork') return 'claude';
    if (provider === 'gemini') return 'gemini';
    if (provider === 'grok') return 'grok';
    if (provider === 'process') return 'process';
    return '';
  }
  // Map a hand-typed provider name (free text from the "Add Header" modal) to a brand-glyph key
  // (provider_kind), so a recognized provider gets its logo. Case-insensitive substring match;
  // '' means unrecognized → no logo. Unlike providerIconKind above, this takes free text.
  function providerKindFromText(str) {
    const s = String(str || '').toLowerCase();
    if (!s) return '';
    if (s.includes('claude') || s.includes('anthropic')) return 'claude';
    if (s.includes('cursor')) return 'cursor';
    if (s.includes('gemini') || s.includes('google')) return 'gemini';
    if (s.includes('codex') || s.includes('chatgpt') || s.includes('openai')) return 'openai';
    if (s.includes('grok') || s.includes('xai')) return 'grok';
    if (s.includes('terminal') || s.includes('process')) return 'process';
    return '';
  }
  // Compact "browser URL" location: host + path, clamped so long conversation URLs don't blow
  // out the meta line.
  function browserUrlLabel(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    try {
      const u = new URL(raw);
      const path = u.pathname && u.pathname !== '/' ? u.pathname : '';
      return clampPickerTitle(`${u.hostname}${path}`);
    } catch {
      return clampPickerTitle(raw);
    }
  }

  function watchSourceLabel(source) {
    switch (source) {
      case 'provider-cursor':
        return 'Cursor';
      case 'provider-openai':
        return 'ChatGPT';
      case 'provider-claude':
        return 'Claude';
      case 'provider-gemini':
        return 'Gemini';
      case 'provider-grok':
        return 'Grok';
      case 'cursor-local':
        return 'Watch Cursor Agent (Local)';
      case 'cursor-remote':
        return 'Watch Cursor Agent (Remote)';
      case 'process-local':
        return 'Watch Terminal Process (Local)';
      case 'process-remote':
        return 'Watch Terminal Process (Remote)';
      case 'browser-chatgpt':
        return 'ChatGPT Browser';
      case 'browser-claude':
        return 'Claude Browser';
      case 'browser-gemini':
        return 'Gemini Browser';
      case 'codex-local':
        return 'Watch Codex (Local)';
      case 'codex-remote':
        return 'Watch Codex (Remote)';
      case 'claude-ide-local':
        return 'Watch Claude Code (Local)';
      case 'claude-ide-remote':
        return 'Watch Claude Code (Remote)';
      case 'claude-cowork':
        return 'Watch Claude Cowork';
      case 'gemini-ide-local':
        return 'Watch Gemini (Local)';
      case 'gemini-ide-remote':
        return 'Watch Gemini (Remote)';
      case 'grok-local':
        return 'Watch Grok (Local)';
      default:
        return 'Working';
    }
  }

  function findWatchingTask(row, excludeTaskId) {
    if (!state.data || !Array.isArray(state.data.projects)) return null;
    for (const project of state.data.projects) {
      if (!Array.isArray(project.tasks)) continue;
      for (const t of project.tasks) {
        if (t.id === excludeTaskId) continue;
        if (t.status === 'done') continue;
        // Include paused_watch_tracking: when a watched agent pauses on a question or a
        // permission prompt, the server moves its watcher out of watch_tracking into
        // paused_watch_tracking (the "needs input" state). The chat is still claimed by
        // this task, so it must stay grayed for other tasks' pickers until the watch
        // truly clears — agent finished or run cancelled — at which point
        // paused_watch_tracking is reset to null.
        const tracking = getTaskWatchTracking(t) || t.paused_watch_tracking || null;
        if (!tracking) continue;

        if (tracking.kind !== row.kind) continue;

        if (row.kind === 'process') {
          if (
            parseInt(tracking.pid, 10) === parseInt(row.pid, 10) &&
            tracking.source === row.source &&
            (tracking.source !== 'ssh' || tracking.host === row.host)
          ) {
            return t;
          }
        } else if (row.kind === 'cursor') {
          const matchPath = tracking.transcript_path && row.transcript_path && tracking.transcript_path === row.transcript_path;
          const matchConv = tracking.conversation_id && row.conversation_id && tracking.conversation_id === row.conversation_id;
          if (matchPath || matchConv) {
            return t;
          }
        } else if (row.kind === 'ide_agent') {
          if (tracking.provider === row.provider) {
            const matchSession = tracking.session_id && row.session_id && tracking.session_id === row.session_id;
            const matchTranscript = tracking.transcript_path && row.transcript_path && tracking.transcript_path === row.transcript_path;
            const matchAudit = tracking.audit_path && row.audit_path && tracking.audit_path === row.audit_path;
            if (matchSession || matchTranscript || matchAudit) {
              return t;
            }
          }
        } else if (row.kind === 'browser_chat') {
          if (
            tracking.provider === row.provider &&
            tracking.conversation_id &&
            row.conversation_id &&
            tracking.conversation_id.toLowerCase() === row.conversation_id.toLowerCase()
          ) {
            return t;
          }
        }
      }
    }
    return null;
  }

  // Paint a structured picker meta line (see buildPickerMeta) into `container`: text segments
  // become text nodes, icon segments become inline glyphs, joined by " · ". Icon SVGs are
  // trusted module constants; text segments (titles, paths, hosts) are user data and go in as
  // text nodes, so nothing user-controlled is ever parsed as HTML.
  function renderMetaParts(container, parts) {
    parts.forEach((part, i) => {
      if (i > 0) container.appendChild(document.createTextNode(' · '));
      if (part.icon) {
        const glyph = document.createElement('span');
        glyph.className = 'row-meta-icon';
        glyph.innerHTML = part.icon;
        if (part.alt) glyph.title = part.alt;
        container.appendChild(glyph);
      } else {
        container.appendChild(document.createTextNode(part.text || ''));
      }
    });
  }

  function renderWatchRows(rows, onPick, rowOptions = {}) {
    els.cursorRunList.innerHTML = '';
    const hintTexts = Array.isArray(rowOptions.hintBefore)
      ? rowOptions.hintBefore
      : rowOptions.hintBefore
        ? [rowOptions.hintBefore]
        : [];
    hintTexts.forEach((text) => {
      const hintLi = document.createElement('li');
      hintLi.className = 'hint';
      hintLi.style.padding = '8px 12px';
      hintLi.textContent = text;
      els.cursorRunList.appendChild(hintLi);
    });

    const excludeTaskId = cursorModalContext ? cursorModalContext.taskId : null;
    const unwatched = [];
    const watched = [];
    rows.forEach((row) => {
      const watchedBy = findWatchingTask(row, excludeTaskId);
      if (watchedBy) {
        watched.push({ row, watchedBy });
      } else {
        unwatched.push({ row, watchedBy: null });
      }
    });

    const sorted = [...unwatched, ...watched];

    sorted.forEach(({ row, watchedBy }) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cursor-run-row';
      if (watchedBy) {
        btn.classList.add('already-watched');
      }
      const fullTitle = row.title || row.label || '';
      const accessibleLabel = [fullTitle || row.label, row.meta].filter(Boolean).join(' ');
      if (accessibleLabel) btn.setAttribute('aria-label', accessibleLabel);
      const title = document.createElement('span');
      title.className = 'row-title';
      const shortTitle = document.createElement('span');
      shortTitle.className = 'row-title-short';
      shortTitle.textContent = row.label;
      title.appendChild(shortTitle);
      const expandsTerminalProcessTitle = row.kind === 'process' && fullTitle && fullTitle !== row.label;
      if (expandsTerminalProcessTitle) {
        btn.classList.add('has-expanded-title');
        const setExpandedTitle = (expanded) => {
          btn.classList.toggle('is-title-expanded', expanded);
        };
        btn.addEventListener('mouseenter', () => setExpandedTitle(true));
        btn.addEventListener('mouseleave', () => setExpandedTitle(false));
        btn.addEventListener('focus', () => setExpandedTitle(true));
        btn.addEventListener('blur', () => setExpandedTitle(false));
        const expandedTitle = document.createElement('span');
        expandedTitle.className = 'row-title-full';
        expandedTitle.textContent = fullTitle;
        title.appendChild(expandedTitle);
      }
      const meta = document.createElement('span');
      meta.className = 'row-meta';
      if (Array.isArray(row.metaParts) && row.metaParts.length) {
        renderMetaParts(meta, row.metaParts);
      } else {
        meta.textContent = row.meta || '';
      }
      btn.append(title, meta);
      btn.addEventListener('click', () => {
        if (watchedBy) {
          const text = taskTextForPreview(watchedBy.text).trim() || 'Untitled Task';
          const taskNamePreview = text.length > 40 ? `${text.slice(0, 40)}…` : text;
          toast(`Already tracked by ${taskNamePreview}.`, true);
          return;
        }
        onPick(row);
      });
      li.appendChild(btn);
      els.cursorRunList.appendChild(li);
    });
  }

  function hasRemoteWatchConfig(project) {
    const remotes =
      (Array.isArray(project?.cursor_remotes) && project.cursor_remotes.length) ||
      (project?.cursor_remote && project.cursor_remote.host);
    const remoteWorkspaces = Array.isArray(project?.cursor_workspaces)
      ? project.cursor_workspaces.some((item) => item && item.source === 'ssh' && item.workspace_path)
      : false;
    return !!(remotes && remoteWorkspaces);
  }

  function providerRowLabel(provider) {
    if (provider === 'codex') return 'Codex';
    if (provider === 'claude') return 'Claude Code';
    if (provider === 'claude_cowork') return 'Claude Cowork';
    if (provider === 'chatgpt') return 'ChatGPT';
    if (provider === 'grok') return 'Grok';
    return 'Gemini';
  }

  function runRecencyMs(run) {
    const direct = Number(run.mtime_ms || run.updated_ms || 0);
    if (Number.isFinite(direct) && direct > 0) return direct;
    return (
      Date.parse(run.updated_at || '') ||
      Date.parse(run.log_started_at || '') ||
      Date.parse(run.log_done_at || '') ||
      Date.parse(run.last_seen_at || '') ||
      0
    );
  }

  function sourceScopeLabel(source, host) {
    if (source === 'ssh') return host ? `Remote · ${host}` : 'Remote';
    return 'Local';
  }

  function isNoRemoteWatchConfigError(err) {
    return /no remote watch host configured/i.test(err?.message || '');
  }

  async function linkWatchRow(project, task, row) {
    if (row.kind === 'ide_agent') {
      await api('POST', `/api/projects/${project.id}/tasks/${task.id}/watch-link`, {
        kind: 'ide_agent',
        provider: row.provider,
        source: row.source,
        host: row.host,
        projects_root: row.projects_root,
        state_location: row.state_location,
        session_id: row.session_id,
        transcript_path: row.transcript_path,
        audit_path: row.audit_path,
        session_dir: row.session_dir,
        title: row.run_title,
        surface: row.surface,
        workspace_path: row.workspace_path,
        working_folders: row.working_folders,
        last_user_preview: row.last_user_preview,
        log_path: row.log_path,
        log_request_id: row.log_request_id,
        log_started_at: row.log_started_at,
        log_done_at: row.log_done_at,
      });
    } else if (row.kind === 'browser_chat') {
      await api('POST', `/api/projects/${project.id}/tasks/${task.id}/watch-link`, {
        kind: 'browser_chat',
        provider: row.provider,
        conversation_id: row.conversation_id,
        url: row.url,
        title: row.displayTitle,
        last_user_preview: row.last_user_preview,
        tab_id: row.tab_id,
      });
    } else {
      await api('POST', `/api/projects/${project.id}/tasks/${task.id}/watch-link`, row);
    }
    closeCursorModal();
    await refresh();
  }

  async function fetchIdeAgentPickerRows(project, source, options = {}) {
    let provider = 'gemini';
    if (source.startsWith('codex')) provider = 'codex';
    else if (source === 'claude-cowork') provider = 'claude_cowork';
    else if (source.startsWith('claude')) provider = 'claude';
    else if (source.startsWith('grok')) provider = 'grok';
    const isRemote = source.endsWith('remote');
    if (isRemote && !hasRemoteWatchConfig(project)) return [];
    const queryParts = [
      `provider=${encodeURIComponent(provider)}`,
      `source=${isRemote ? 'ssh' : 'local'}`,
      'active_only=1',
    ];
    let runs = [];
    try {
      const result = await api('GET', `/api/projects/${project.id}/ide-agent-runs?${queryParts.join('&')}`);
      runs = result.runs || [];
    } catch (err) {
      if (options.ignoreNoRemoteError && isRemote && isNoRemoteWatchConfigError(err)) return [];
      throw err;
    }
    const filtered = (runs || []).filter((run) => {
      if (run.provider !== provider) return false;
      if (!((!!run.host === isRemote) || (!run.host && !isRemote))) return false;
      // A HELD run has parked (waiting on a sub-agent, background task, cron/wakeup, or cascade)
      // but its underlying watch is still holding — the agent has NOT finished. Keep it in the
      // picker regardless of the generating/completion_hint levers, exactly like a permission
      // pause below. Without this, a held run's snapshot reads generating:false/completion_hint:true
      // the instant it parks and it would vanish until it resumes (see picker-held-run bug).
      if (run.held !== true) {
        if (run.generating !== true) return false;
        if (run.completion_hint) return false;
      }
      // Note: a pending permission (gemini notification_type === 'ToolPermission') is NOT
      // filtered out here. A chat paused on a permission prompt is still a live run, so it
      // stays in the picker — grayed if a task is watching it (see findWatchingTask /
      // paused_watch_tracking), selectable otherwise — matching how a pending question behaves.
      const pickerLabel = (run.last_user_preview || run.title || run.session_id || '').trim();
      if (isUserRequestInterruptedPickerLabel(pickerLabel)) return false;
      return true;
    });
    return filtered.map((run) => {
      const primaryLabel = run.last_user_preview || run.title || run.session_id;
      const rowProvider = run.provider || provider;
      const detail = run.workspace_path || run.updated_at || run.session_id;
      const rowSource = run.source || (isRemote ? 'ssh' : 'local');
      const meta = buildPickerMeta([
        metaIconPart(providerIconSvg(providerIconKind(rowProvider)), providerRowLabel(rowProvider)),
        metaTextPart(clampPickerTitle(run.title)),
        metaTextPart(providerRowLabel(rowProvider)),
        metaIconPart(surfaceIconSvg(run.surface), pickerSurfaceLabel(run.surface)),
        metaTextPart(rowProvider === 'claude_cowork' ? coworkFolderLabel(run) : locationLeaf(run.workspace_path)),
        metaTextPart(localRemoteLabel(rowSource)),
        rowSource === 'ssh' ? metaTextPart(run.host) : null,
      ]);
      return {
        kind: 'ide_agent',
        provider: rowProvider,
        session_id: run.session_id,
        transcript_path: run.transcript_path,
        audit_path: run.audit_path || '',
        session_dir: run.session_dir || '',
        run_title: run.title || '',
        surface: run.surface || '',
        chat_title: (run.title || '').trim(),
        source: rowSource,
        host: run.host || null,
        projects_root: run.projects_root || null,
        state_location: run.state_location || '',
        workspace_path: run.workspace_path || '',
        working_folders: Array.isArray(run.working_folders) ? run.working_folders : [],
        last_user_preview: run.last_user_preview || '',
        log_path: run.log_path || '',
        log_request_id: run.log_request_id || '',
        log_started_at: run.log_started_at || '',
        log_done_at: run.log_done_at || '',
        label: primaryLabel,
        meta: meta.text,
        metaParts: meta.parts,
        title: primaryLabel,
        recency_ms: runRecencyMs(run),
      };
    });
  }

  async function loadIdeAgentPickerRuns(project, task, source, loadToken, options = {}) {
    const rows = await fetchIdeAgentPickerRows(project, source, options);
    if (!cursorModalContext || cursorModalLoadToken !== loadToken) return;
    if (!rows.length) {
      const scanHint = ' Keep this picker open while you start an agent.';
      els.cursorRunList.innerHTML = `<li class="hint" style="padding:12px">No currently generating sessions found yet for this provider.${scanHint}</li>`;
      return;
    }
    renderWatchRows(rows, async (row) => {
      try {
        await linkWatchRow(project, task, row);
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  async function fetchCursorPickerRows(project, source = 'provider-cursor') {
    const { runs } = await api('GET', `/api/projects/${project.id}/cursor-runs?active_only=1`);
    const filtered = (runs || []).filter((run) => {
      if (!run.hook_hint) return false;
      // A HELD cursor run has parked mid-turn (per-generation stop while a continuation /
      // sub-agent is still in flight) but its watch is still holding — keep it visible past the
      // generating/terminal/completion levers, which all fire at a mid-turn generation boundary.
      if (run.held !== true) {
        if (run.generating !== true) return false;
        if (run.terminal_hint || run.completion_hint) return false;
      }
      if (isUserRequestInterruptedPickerLabel(run.user_preview)) return false;
      if (source === 'cursor-local' && run.source === 'ssh') return false;
      if (source === 'cursor-remote' && run.source !== 'ssh') return false;
      return true;
    });
    return filtered.map((run) => {
      const slug = run.project_slug || '';
      const preview = (run.user_preview || '').trim();
      const id = run.run_id || '';
      const rowSource = run.source || 'local';
      const meta = buildPickerMeta([
        metaIconPart(providerIconSvg('cursor'), 'Cursor'),
        metaTextPart(clampPickerTitle(run.title)),
        metaTextPart('Cursor'),
        metaIconPart(surfaceIconSvg(run.surface), pickerSurfaceLabel(run.surface)),
        metaTextPart(locationLeaf(slug)),
        metaTextPart(localRemoteLabel(rowSource)),
        rowSource === 'ssh' ? metaTextPart(run.host) : null,
      ]);
      return {
        kind: 'cursor',
        source: rowSource,
        host: run.host,
        projects_root: run.projects_root,
        transcript_path: run.transcript_path,
        conversation_id: run.conversation_id,
        surface: run.surface || '',
        chat_title: (run.title || '').trim(),
        label: preview || id,
        meta: meta.text,
        metaParts: meta.parts,
        title: [run.transcript_path, run.run_id].filter(Boolean).join('\n'),
        recency_ms: runRecencyMs(run),
      };
    });
  }

  async function fetchBrowserChatPickerRows(source) {
    const providerMap = {
      'browser-chatgpt': 'chatgpt',
      'browser-claude': 'claude',
      'browser-gemini': 'gemini',
    };
    const provider = providerMap[source];
    const { items } = await api('GET', `/api/browser-chats?provider=${encodeURIComponent(provider)}`);
    const withConversation = (items || []).filter((s) => s.conversation_id);
    const generatingSnaps = withConversation.filter((s) => s.generating);
    return generatingSnaps.map((snap) => {
      const preview = (snap.last_user_preview || '').trim();
      const displayTitle = (snap.title || '').trim() || snap.url || snap.conversation_id;
      const metaTitle = displayTitle.length > 64 ? `${displayTitle.slice(0, 64)}…` : displayTitle;
      const meta = buildPickerMeta([
        metaIconPart(providerIconSvg(providerIconKind(snap.provider)), providerRowLabel(snap.provider)),
        metaTextPart(clampPickerTitle(browserRealTitle(snap.title, snap.conversation_id, snap.url))),
        metaTextPart(providerRowLabel(snap.provider)),
        metaTextPart(browserUrlLabel(snap.url)),
      ]);
      return {
        kind: 'browser_chat',
        provider: snap.provider,
        conversation_id: snap.conversation_id,
        url: snap.url || '',
        displayTitle,
        chat_title: browserRealTitle(snap.title, snap.conversation_id, snap.url),
        last_user_preview: preview,
        tab_id: snap.tab_id,
        label: browserWatchRowLabel(preview, snap.title, snap.conversation_id, snap.url),
        meta: meta.text,
        metaParts: meta.parts,
        title: [displayTitle, snap.url, snap.conversation_id, preview].filter(Boolean).join('\n'),
        recency_ms: runRecencyMs(snap),
      };
    });
  }

  function sortProviderRows(rows) {
    return rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        const delta = (b.row.recency_ms || 0) - (a.row.recency_ms || 0);
        return delta || a.index - b.index;
      })
      .map((item) => item.row);
  }

  function providerEmptyHint(source) {
    if (source === 'provider-cursor') {
      return 'No currently active Cursor agents found yet. Keep this picker open while you start a Cursor agent.';
    }
    if (source === 'provider-openai') {
      return 'No currently generating ChatGPT sessions found yet. Start a Codex run or a ChatGPT browser reply. Browser sessions need the Orchestra Chat Watch extension.';
    }
    if (source === 'provider-claude') {
      return 'No currently generating Claude sessions found yet. Start Claude Code, Claude Cowork, or a Claude browser reply. Browser sessions need the Orchestra Chat Watch extension.';
    }
    if (source === 'provider-grok') {
      return 'No currently generating Grok sessions found yet. Start Grok locally and keep this picker open.';
    }
    return 'No currently generating Gemini sessions found yet. Start Gemini locally, remotely, or in the browser. Browser sessions need the Orchestra Chat Watch extension.';
  }

  async function loadProviderPickerRuns(project, task, source, loadToken, options = {}) {
    const rowPromises = [];
    if (source === 'provider-cursor') {
      rowPromises.push(fetchCursorPickerRows(project));
    } else if (source === 'provider-openai') {
      rowPromises.push(fetchIdeAgentPickerRows(project, 'codex-local', { ignoreNoRemoteError: true }));
      rowPromises.push(fetchIdeAgentPickerRows(project, 'codex-remote', { ignoreNoRemoteError: true }));
      rowPromises.push(fetchBrowserChatPickerRows('browser-chatgpt'));
    } else if (source === 'provider-claude') {
      rowPromises.push(fetchIdeAgentPickerRows(project, 'claude-ide-local', { ignoreNoRemoteError: true }));
      rowPromises.push(fetchIdeAgentPickerRows(project, 'claude-ide-remote', { ignoreNoRemoteError: true }));
      rowPromises.push(fetchIdeAgentPickerRows(project, 'claude-cowork', { ignoreNoRemoteError: true }));
      rowPromises.push(fetchBrowserChatPickerRows('browser-claude'));
    } else if (source === 'provider-gemini') {
      rowPromises.push(fetchIdeAgentPickerRows(project, 'gemini-ide-local', { ignoreNoRemoteError: true }));
      rowPromises.push(fetchIdeAgentPickerRows(project, 'gemini-ide-remote', { ignoreNoRemoteError: true }));
      rowPromises.push(fetchBrowserChatPickerRows('browser-gemini'));
    } else if (source === 'provider-grok') {
      // Local-only this wave (the grok ssh leg is R2d).
      rowPromises.push(fetchIdeAgentPickerRows(project, 'grok-local', { ignoreNoRemoteError: true }));
    }
    const rows = sortProviderRows((await Promise.all(rowPromises)).flat());
    if (!cursorModalContext || cursorModalLoadToken !== loadToken) return;
    if (!rows.length) {
      els.cursorRunList.innerHTML = `<li class="hint" style="padding:12px">${providerEmptyHint(source)}</li>`;
    } else {
      renderWatchRows(rows, async (row) => {
        try {
          await linkWatchRow(project, task, row);
        } catch (err) {
          toast(err.message, true);
        }
      });
    }
  }

  async function loadModalSource(project, task, source, query = '', options = {}) {
    const quiet = !!options.quiet;
    const loadToken = ++cursorModalLoadToken;
    const prevSource = cursorModalContext?.source;
    cursorModalContext.source = source;
    const useSearch = source === 'process-local' || source === 'process-remote';
    els.watchSearch.hidden = !useSearch;
    if (!quiet || !useSearch) {
      els.watchSearch.value = query;
    }
    const processQuery = useSearch ? (quiet ? els.watchSearch.value.trim() : query) : '';
    if (!quiet) {
      els.cursorRunList.innerHTML = '';
      const loading = document.createElement('li');
      loading.className = 'hint';
      loading.style.padding = '12px';
      loading.textContent = `Loading ${watchSourceLabel(source)}…`;
      els.cursorRunList.appendChild(loading);
    }

    if (
      source === 'provider-cursor' ||
      source === 'provider-openai' ||
      source === 'provider-claude' ||
      source === 'provider-gemini' ||
      source === 'provider-grok'
    ) {
      await loadProviderPickerRuns(project, task, source, loadToken, options);
      return;
    }

    if (source === 'cursor-local' || source === 'cursor-remote') {
      const rows = await fetchCursorPickerRows(project, source);
      if (!cursorModalContext || cursorModalLoadToken !== loadToken) return;
      if (!rows.length) {
        els.cursorRunList.innerHTML =
          '<li class="hint" style="padding:12px">No currently active Cursor agents found yet. Keep this picker open while you start an agent.</li>';
        return;
      }
      if (!cursorModalContext || cursorModalLoadToken !== loadToken) return;
      renderWatchRows(rows, async (row) => {
        try {
          await linkWatchRow(project, task, row);
        } catch (err) {
          toast(err.message, true);
        }
      });
      return;
    }

    if (
      source === 'codex-local' ||
      source === 'codex-remote' ||
      source === 'claude-ide-local' ||
      source === 'claude-ide-remote' ||
      source === 'claude-cowork' ||
      source === 'gemini-ide-local' ||
      source === 'gemini-ide-remote' ||
      source === 'grok-local'
    ) {
      await loadIdeAgentPickerRuns(project, task, source, loadToken, options);
      return;
    }

    if (
      source === 'browser-chatgpt' ||
      source === 'browser-claude' ||
      source === 'browser-gemini'
    ) {
      const rows = await fetchBrowserChatPickerRows(source);
      if (!cursorModalContext || cursorModalLoadToken !== loadToken) return;
      els.cursorRunList.innerHTML = '';
      if (!rows.length) {
        const hint = document.createElement('li');
        hint.className = 'hint';
        hint.style.padding = '12px';
        hint.textContent =
          'No currently generating chats found. Open a chat with the Orchestra Chat Watch extension loaded, start or resume a reply, then keep this picker open.';
        els.cursorRunList.appendChild(hint);
      } else {
        renderWatchRows(rows, async (row) => {
          try {
            await linkWatchRow(project, task, row);
          } catch (err) {
            toast(err.message, true);
          }
        });
      }
      return;
    }

    const endpoint =
      source === 'process-remote'
        ? `/api/projects/${project.id}/processes/remote?query=${encodeURIComponent(processQuery)}`
        : `/api/projects/${project.id}/processes/local?query=${encodeURIComponent(processQuery)}`;
    const result = await api('GET', endpoint);
    if (!cursorModalContext || cursorModalLoadToken !== loadToken) return;
    const procs = result.items || [];
    const remoteErrHints = Array.isArray(result.remote_errors)
      ? result.remote_errors.map((e) => `${e.host}: ${e.error}`)
      : [];
    if (!procs.length) {
      const parts = [];
      for (const line of remoteErrHints) {
        parts.push(`<li class="hint" style="padding:12px">${line}</li>`);
      }
      const msg =
        result.no_match_reason === 'workspace'
          ? 'No processes with cwd under this project’s workspaces matched. Try clearing the search, add or adjust Workspaces in project settings, or remove all workspaces there to list every process again. Keep this picker open and new matches will appear automatically.'
          : remoteErrHints.length
            ? 'No processes from reachable remotes matched. Keep this picker open and the list will update automatically.'
            : 'No running processes matched. Keep this picker open and new processes will appear automatically.';
      parts.push(`<li class="hint" style="padding:12px">${msg}</li>`);
      els.cursorRunList.innerHTML = parts.join('');
      return;
    }
    const rows = procs.map((proc) => {
      const hostPrefix = proc.host ? `${proc.host} · ` : '';
      const cwd = typeof proc.cwd === 'string' && proc.cwd.trim() ? proc.cwd.trim() : '';
      const cwdBit =
        cwd.length > 44 ? `${cwd.slice(0, 44)}… · ` : cwd ? `${cwd} · ` : '';
      const cleanedFullCommand = processCommandDisplayLabel(proc.command, { truncate: false });
      return {
        kind: 'process',
        source: proc.host ? 'ssh' : 'local',
        host: proc.host,
        pid: proc.pid,
        pgid: proc.pgid,
        command: proc.command,
        cwd,
        tty: proc.tty,
        completion: proc.completion,
        label: proc.watch_label || processCommandDisplayLabel(proc.command),
        title: cleanedFullCommand || proc.command || '',
        meta: `${hostPrefix}${cwdBit}PID ${proc.pid} · ${proc.etime} · ${Math.round(proc.pcpu)}% CPU · ${proc.tty}`,
      };
    });
    const hintBefore = [
      ...remoteErrHints,
      ...(result.truncated && result.workspace_roots_applied
        ? [
            'Workspace cwd scan hit the safety cap; only the first chunk of matching processes was checked. Type a narrower search (command, pid, tty) to reduce the list.',
          ]
        : []),
    ];
    renderWatchRows(rows, async (row) => {
      try {
        await api('POST', `/api/projects/${project.id}/tasks/${task.id}/watch-link`, row);
        closeCursorModal();
        await refresh();
      } catch (err) {
        toast(err.message, true);
      }
    }, { hintBefore });
  }

  async function openCursorWaitModal(project, task) {
    stopCursorModalAutoRefresh();
    cursorModalContext = {
      projectId: project.id,
      taskId: task.id,
      source: null,
    };
    els.cursorRunModal.hidden = false;
    updateModalTaskButtons(task);
    setCursorModalTab('watching');
    els.watchSearch.hidden = true;
    els.watchSearch.value = '';

    const savedKind = normalizeActiveWatchKind(project, task, readTaskActiveKindPreference(task));
    if (savedKind && WATCH_GROUPS[savedKind]) {
      await activateWatchGroup(project, task, savedKind);
    } else {
      resetWatchPickerUi();
      els.cursorRunList.innerHTML =
        '<li class="hint" style="padding:12px">Choose Cursor, ChatGPT, Claude, Gemini, Grok, or Process above.</li>';
    }
    updateHookStatus(project).catch(() => {});
  }

  const HOOK_INSTALL_AGENTS = [
    { key: 'cursor', label: 'Cursor', localPath: '/api/cursor-hooks/install-local', remotePath: 'cursor-hooks/install-remote' },
    { key: 'claude', label: 'Claude', localPath: '/api/claude-hooks/install-local', remotePath: 'claude-hooks/install-remote' },
    { key: 'gemini', label: 'Gemini', localPath: '/api/gemini-hooks/install-local', remotePath: 'gemini-hooks/install-remote' },
    { key: 'codex', label: 'Codex', localPath: '/api/codex-hooks/install-local', remotePath: 'codex-hooks/install-remote' },
  ];

  async function installAllAgentHooks(project) {
    const localResults = await Promise.all(
      HOOK_INSTALL_AGENTS.map(async (agent) => {
        try {
          await api('POST', agent.localPath);
          return { agent, ok: true };
        } catch (err) {
          return { agent, ok: false, error: err.message };
        }
      })
    );

    const remoteResults = project?.id
      ? await Promise.all(
          HOOK_INSTALL_AGENTS.map(async (agent) => {
            try {
              const data = await api('POST', `/api/projects/${project.id}/${agent.remotePath}`);
              const failed = (data?.results || []).filter((r) => !r.ok).map((r) => r.host);
              return { agent, ok: Boolean(data?.ok), failed };
            } catch (err) {
              return { agent, ok: false, error: err.message };
            }
          })
        )
      : [];

    return { localResults, remoteResults };
  }

  function summarizeInstallAllHooks({ localResults, remoteResults }) {
    const failures = [];
    for (const r of localResults) {
      if (!r.ok) failures.push(`${r.agent.label} local: ${r.error || 'failed'}`);
    }
    for (const r of remoteResults) {
      if (r.ok) continue;
      if (r.failed?.length) failures.push(`${r.agent.label} remote: ${r.failed.join(', ')}`);
      else failures.push(`${r.agent.label} remote: ${r.error || 'failed'}`);
    }
    const allOk = failures.length === 0;
    const remoteSkipped = remoteResults.length === 0;
    let message;
    if (allOk) {
      message = remoteSkipped
        ? 'Local hooks installed for all agents.'
        : 'Local and remote hooks installed for all agents.';
    } else {
      message = failures.join('; ');
    }
    return { allOk, message };
  }

  async function updateHookStatus(project) {
    if (!els.hookStatusText) return;
    try {
      const q = project?.id ? `?project_id=${encodeURIComponent(project.id)}` : '';
      const st = await api('GET', `/api/cursor-hooks/status${q}`);
      const local = st.local?.installed ? 'local: installed' : 'local: missing';
      const remoteLabel =
        Array.isArray(st.remotes) && st.remotes.length
          ? `remote: ${st.remotes.map((r) => r.host).join(', ')}`
          : st.remote?.host
            ? `remote: ${st.remote.host}`
            : 'remote: n/a';
      els.hookStatusText.textContent = `${local} · ${remoteLabel}`;
    } catch {
      els.hookStatusText.textContent = 'hook status unavailable';
    }
    if (!els.claudeHookStatusText) return;
    try {
      const q = project?.id ? `?project_id=${encodeURIComponent(project.id)}` : '';
      const st = await api('GET', `/api/claude-hooks/status${q}`);
      const local = st.local?.installed ? 'local: installed' : 'local: missing';
      const remoteLabel =
        Array.isArray(st.remotes) && st.remotes.length
          ? `remote: ${st.remotes.map((r) => r.host).join(', ')}`
          : st.remote?.host
            ? `remote: ${st.remote.host}`
            : 'remote: n/a';
      els.claudeHookStatusText.textContent = `${local} · ${remoteLabel}`;
    } catch {
      els.claudeHookStatusText.textContent = 'hook status unavailable';
    }
    if (!els.geminiHookStatusText) return;
    try {
      const q = project?.id ? `?project_id=${encodeURIComponent(project.id)}` : '';
      const st = await api('GET', `/api/gemini-hooks/status${q}`);
      const local = st.local?.installed ? 'local: installed' : 'local: missing';
      const remoteLabel =
        Array.isArray(st.remotes) && st.remotes.length
          ? `remote: ${st.remotes.map((r) => r.host).join(', ')}`
          : st.remote?.host
            ? `remote: ${st.remote.host}`
            : 'remote: n/a';
      els.geminiHookStatusText.textContent = `${local} · ${remoteLabel}`;
    } catch {
      els.geminiHookStatusText.textContent = 'hook status unavailable';
    }
  }


  function setupCursorRunModal() {
    els.cursorModalTabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        setCursorModalTab(tab.dataset.cursorModalTab);
      });
    });
    els.cursorModalCancel.addEventListener('click', () => closeCursorModal());
    attachModalStuckDrag(els.cursorWaitStuck);
    els.cursorWaitBacklog.addEventListener('click', async () => {
      const ctx = modalProjectTask();
      if (!ctx) return;
      const next = !ctx.task.is_task_backlog;
      els.cursorWaitBacklog.classList.toggle('active', next);
      await patchTask(ctx.project, ctx.task, { is_task_backlog: next });
    });
    els.cursorWaitFocus.addEventListener('click', () => {
      const ctx = modalProjectTask();
      if (!ctx) return;
      closeCursorModal();
      openTaskFocusModal(ctx.project, ctx.task);
    });
    els.cursorWaitContext.addEventListener('click', () => {
      const ctx = modalProjectTask();
      if (!ctx) return;
      closeCursorModal();
      openContextModal(ctx.project, ctx.task);
    });
    els.cursorWaitAddTitle.addEventListener('click', () => {
      const ctx = modalProjectTask();
      if (!ctx) return;
      closeCursorModal();
      openAddTitleModal(ctx.project, ctx.task);
    });
    els.cursorWaitSetDone.addEventListener('click', async () => {
      if (!cursorModalContext) return;
      const project = state.data.projects.find((p) => p.id === cursorModalContext.projectId);
      const task = project?.tasks.find((t) => t.id === cursorModalContext.taskId);
      if (!project || !task) {
        closeCursorModal();
        return;
      }
      closeCursorModal();
      await markWatchDone(project, task);
    });
    els.cursorWaitManual.addEventListener('click', async () => {
      if (!cursorModalContext) return;
      const project = state.data.projects.find((p) => p.id === cursorModalContext.projectId);
      const task = project?.tasks.find((t) => t.id === cursorModalContext.taskId);
      if (!project || !task) {
        closeCursorModal();
        return;
      }
      try {
        if (task.status === 'waiting' && getTaskWatchTracking(task)) {
          await api('POST', `/api/projects/${project.id}/tasks/${task.id}/watch-unlink`);
        } else if (task.status !== 'waiting') {
          await api('PATCH', `/api/projects/${project.id}/tasks/${task.id}`, { status: 'waiting' });
        }
        closeCursorModal();
        await refresh();
      } catch (err) {
        toast(err.message, true);
      }
    });
    els.watchSourceChoices.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-watch-kind]');
      if (!btn || !cursorModalContext) return;
      const project = state.data.projects.find((p) => p.id === cursorModalContext.projectId);
      const task = project?.tasks.find((t) => t.id === cursorModalContext.taskId);
      if (!project || !task) return;
      await activateWatchGroup(project, task, btn.dataset.watchKind);
    });
    els.installAllHooksBtn?.addEventListener('click', async () => {
      const project = cursorModalContext
        ? state.data.projects.find((p) => p.id === cursorModalContext.projectId)
        : null;
      const buttons = [
        els.installAllHooksBtn,
        els.installLocalHooksBtn,
        els.installRemoteHooksBtn,
        els.installLocalClaudeHooksBtn,
        els.installRemoteClaudeHooksBtn,
        els.installLocalGeminiHooksBtn,
        els.installRemoteGeminiHooksBtn,
        els.installLocalCodexHooksBtn,
        els.installRemoteCodexHooksBtn,
      ].filter(Boolean);
      buttons.forEach((btn) => {
        btn.disabled = true;
      });
      if (els.installAllHooksStatus) els.installAllHooksStatus.textContent = 'Installing…';
      try {
        const outcome = await installAllAgentHooks(project);
        const { allOk, message } = summarizeInstallAllHooks(outcome);
        toast(message, !allOk);
        if (els.installAllHooksStatus) {
          els.installAllHooksStatus.textContent = allOk ? 'Done.' : message;
        }
        if (project) await updateHookStatus(project);
      } catch (err) {
        toast(err.message, true);
        if (els.installAllHooksStatus) els.installAllHooksStatus.textContent = err.message;
      } finally {
        buttons.forEach((btn) => {
          btn.disabled = false;
        });
      }
    });
    els.installLocalHooksBtn?.addEventListener('click', async () => {
      try {
        await api('POST', '/api/cursor-hooks/install-local');
        toast('Local hooks installed.');
        if (!cursorModalContext) return;
        const project = state.data.projects.find((p) => p.id === cursorModalContext.projectId);
        await updateHookStatus(project);
      } catch (err) {
        toast(err.message, true);
      }
    });
    els.installRemoteHooksBtn?.addEventListener('click', async () => {
      if (!cursorModalContext) return;
      const project = state.data.projects.find((p) => p.id === cursorModalContext.projectId);
      if (!project) return;
      try {
        const data = await api('POST', `/api/projects/${project.id}/cursor-hooks/install-remote`);
        if (data && data.ok) toast('Remote Cursor hooks installed on all configured hosts.');
        else {
          const failed = (data.results || []).filter((r) => !r.ok).map((r) => r.host);
          toast(
            failed.length ? `Remote hook install failed for: ${failed.join(', ')}` : 'Some remote hook installs failed.',
            true
          );
        }
        await updateHookStatus(project);
      } catch (err) {
        toast(err.message, true);
      }
    });
    els.testHooksBtn?.addEventListener('click', async () => {
      try {
        await api('POST', '/api/cursor-hooks/test');
        toast('Inserted hook test event.');
      } catch (err) {
        toast(err.message, true);
      }
    });
    els.installLocalClaudeHooksBtn?.addEventListener('click', async () => {
      try {
        await api('POST', '/api/claude-hooks/install-local');
        toast('Local Claude hooks installed.');
        if (!cursorModalContext) return;
        const project = state.data.projects.find((p) => p.id === cursorModalContext.projectId);
        await updateHookStatus(project);
      } catch (err) {
        toast(err.message, true);
      }
    });
    els.installRemoteClaudeHooksBtn?.addEventListener('click', async () => {
      if (!cursorModalContext) return;
      const project = state.data.projects.find((p) => p.id === cursorModalContext.projectId);
      if (!project) return;
      try {
        const data = await api('POST', `/api/projects/${project.id}/claude-hooks/install-remote`);
        if (data && data.ok) toast('Remote Claude hooks + settings installed on all configured hosts.');
        else {
          const failed = (data.results || []).filter((r) => !r.ok).map((r) => r.host);
          toast(
            failed.length ? `Remote Claude install failed for: ${failed.join(', ')}` : 'Some remote Claude installs failed.',
            true
          );
        }
        await updateHookStatus(project);
      } catch (err) {
        toast(err.message, true);
      }
    });
    els.testClaudeHooksBtn?.addEventListener('click', async () => {
      try {
        await api('POST', '/api/claude-hooks/test');
        toast('Inserted Claude hook test event.');
      } catch (err) {
        toast(err.message, true);
      }
    });
    els.installLocalGeminiHooksBtn?.addEventListener('click', async () => {
      try {
        await api('POST', '/api/gemini-hooks/install-local');
        toast('Local Gemini hooks installed.');
        if (!cursorModalContext) return;
        const project = state.data.projects.find((p) => p.id === cursorModalContext.projectId);
        await updateHookStatus(project);
      } catch (err) {
        toast(err.message, true);
      }
    });
    els.installRemoteGeminiHooksBtn?.addEventListener('click', async () => {
      if (!cursorModalContext) return;
      const project = state.data.projects.find((p) => p.id === cursorModalContext.projectId);
      if (!project) return;
      try {
        const data = await api('POST', `/api/projects/${project.id}/gemini-hooks/install-remote`);
        if (data && data.ok) toast('Remote Gemini hooks + settings installed on all configured hosts.');
        else {
          const failed = (data.results || []).filter((r) => !r.ok).map((r) => r.host);
          toast(
            failed.length ? `Remote Gemini install failed for: ${failed.join(', ')}` : 'Some remote Gemini installs failed.',
            true
          );
        }
        await updateHookStatus(project);
      } catch (err) {
        toast(err.message, true);
      }
    });
    els.testGeminiHooksBtn?.addEventListener('click', async () => {
      try {
        await api('POST', '/api/gemini-hooks/test');
        toast('Inserted Gemini hook test event.');
      } catch (err) {
        toast(err.message, true);
      }
    });
    els.installLocalCodexHooksBtn?.addEventListener('click', async () => {
      try {
        await api('POST', '/api/codex-hooks/install-local');
        toast('Installed local Codex hooks.');
      } catch (err) {
        toast(err.message, true);
      }
    });
    els.installRemoteCodexHooksBtn?.addEventListener('click', async () => {
      if (!cursorModalContext) return;
      const project = state.data.projects.find((p) => p.id === cursorModalContext.projectId);
      if (!project) return;
      try {
        const data = await api('POST', `/api/projects/${project.id}/codex-hooks/install-remote`);
        if (data && data.ok) toast('Remote Codex hooks installed on all configured hosts.');
        else {
          const failed = (data.results || []).filter((r) => !r.ok).map((r) => r.host);
          toast(
            failed.length ? `Remote Codex install failed for: ${failed.join(', ')}` : 'Some remote Codex installs failed.',
            true
          );
        }
      } catch (err) {
        toast(err.message, true);
      }
    });
    els.testCodexHooksBtn?.addEventListener('click', async () => {
      try {
        await api('POST', '/api/codex-hooks/test');
        toast('Inserted Codex hook test event.');
      } catch (err) {
        toast(err.message, true);
      }
    });
    let searchTimer = null;
    els.watchSearch.addEventListener('input', () => {
      if (!cursorModalContext || !cursorModalContext.source) return;
      const source = cursorModalContext.source;
      if (!source.startsWith('process')) return;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        const project = state.data.projects.find((p) => p.id === cursorModalContext.projectId);
        const task = project?.tasks.find((t) => t.id === cursorModalContext.taskId);
        if (!project || !task) return;
        try {
          await loadModalSource(project, task, source, els.watchSearch.value.trim());
        } catch (err) {
          toast(err.message, true);
        }
      }, 200);
    });
    els.cursorRunModal.addEventListener('click', (e) => {
      if (e.target === els.cursorRunModal) closeCursorModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !els.cursorRunModal.hidden) {
        e.preventDefault();
        closeCursorModal();
      }
    });
  }

  function hasLinkedWaitingTasks() {
    return state.data.projects.some((p) =>
      (p.tasks || []).some(
        (t) =>
          // Actively tracking an agent...
          (t.status === 'waiting' && getTaskWatchTracking(t)) ||
          // ...or paused on a needs-input gate (question/permission). The server keeps
          // working — it can resume tracking once you answer and then mark the watch
          // done — so we must keep polling to observe that, otherwise the pill stays
          // frozen on "needs input" until a manual reload.
          t.paused_watch_tracking ||
          // ...or finished ("done" pill) but still holding its re-arm binding. When a
          // follow-up prompt fires, the server flips the watch done→working the instant
          // its UserPromptSubmit hook arrives — but with no other task tracking, this
          // poll would otherwise be dormant and the pill stays frozen on "done" until a
          // manual UI action (opening the picker, sending another prompt) forces a
          // refresh. The binding is cleared on re-arm (→ waiting) and on watch-ack, so
          // this does not poll forever.
          (t.status === 'todo' && t.watch_finished && t.completed_watch_tracking)
      )
    );
  }

  function startLinkedWaitingRefresh() {
    // Poll fairly often while a watch is active or paused so pill transitions
    // (tracking ↔ needs input ↔ done) feel responsive. Match the server's ~2s
    // watch poller so the UI is not the slower leg during needs-input gates.
    setInterval(() => {
      // Live-feed delta poll piggybacks this same 2s tick. It is a no-op in plain mode and
      // fails quietly (cells simply show nothing new) — see live_feed_ui.js pollTick.
      if (window.LiveFeedUI) LiveFeedUI.pollTick();
      if (!hasLinkedWaitingTasks()) return;
      refresh({ preserveTaskList: true }).catch(() => {});
    }, 2_000);
  }

  // --- Project forms ---

  function buildColorRow(container, selected, onSelect) {
    container.innerHTML = '';
    COLORS.forEach((c) => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = `color-swatch ${c}`;
      sw.dataset.color = c;
      if (c === selected) sw.classList.add('selected');
      sw.addEventListener('click', () => {
        [...container.querySelectorAll('.color-swatch')].forEach((s) => s.classList.remove('selected'));
        sw.classList.add('selected');
        onSelect(c);
      });
      container.appendChild(sw);
    });
  }

  function normalizeLaunchCommands(commands) {
    const list = Array.isArray(commands) ? commands : [commands];
    return list.filter((command) => typeof command === 'string').map((command) => command.trim()).filter(Boolean);
  }

  function getProjectLaunchCommands(project) {
    return normalizeLaunchCommands(project.launch_commands?.length ? project.launch_commands : project.launch_command);
  }

  function getTaskFocusCommands(task) {
    return normalizeLaunchCommands(task?.focus_commands || []);
  }

  function getProjectWorkspaceCommands(project) {
    return normalizeLaunchCommands(project?.workspace_commands || []);
  }

  function workspaceItemId() {
    return `workspace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function commandToWorkspaceItem(command) {
    return { id: workspaceItemId(), type: 'shell', label: '', command };
  }

  function getProjectWorkspaceItems(project) {
    const workspaceItems = [];
    if (Array.isArray(project?.workspace_items)) {
      workspaceItems.push(...project.workspace_items.filter((item) => item && typeof item === 'object'));
    } else {
      workspaceItems.push(...getProjectWorkspaceCommands(project).map(commandToWorkspaceItem));
    }
    const helper = window.DefaultLaunchCommands;
    const existingCommands = new Set(workspaceItems.map((item) => {
      try {
        return helper?.buildWorkspaceItemCommand ? helper.buildWorkspaceItemCommand(item) : '';
      } catch {
        return item?.type === 'shell' ? String(item.command || '').trim() : '';
      }
    }).filter(Boolean));
    getProjectLaunchCommands(project).forEach((command) => {
      if (!existingCommands.has(command)) workspaceItems.push(commandToWorkspaceItem(command));
    });
    return workspaceItems;
  }

  function getTaskFocusItems(task) {
    if (Array.isArray(task?.focus_items)) {
      return task.focus_items.filter((item) => item && typeof item === 'object');
    }
    return getTaskFocusCommands(task).map(commandToWorkspaceItem);
  }

  function defaultWorkspaceItem(type = 'shell') {
    const id = workspaceItemId();
    const metadata = { is_primary: false };
    if (type === 'cursor_project') return { id, type, source: 'local', workspace_path: '', ...metadata };
    if (type === 'chrome_page') return { id, type, url: '', ...metadata };
    if (type === 'app_file') return { id, type, app: '', target_path: '', ...metadata };
    if (type === 'obsidian_note') return { id, type, vault: '', note_path: '', ...metadata };
    if (type === 'desktop') return { id, type, desktop: 1, ...metadata };
    return { id, type: 'shell', label: '', command: '', ...metadata };
  }

  function getCommandListContainer(form, fieldName) {
    return form.querySelector(`[data-command-list="${fieldName}"]`);
  }

  function updateCommandRemoveButtons(container) {
    const buttons = [...container.querySelectorAll('[data-remove-launch-command]')];
    buttons.forEach((button) => {
      button.hidden = buttons.length <= 1;
    });
  }

  function renderLaunchPresetFields(preset) {
    const root = els.launchPresetFields;
    root.innerHTML = '';
    const addField = (name, label, placeholder) => {
      const wrap = document.createElement('label');
      wrap.textContent = label;
      const input = document.createElement('input');
      input.type = 'text';
      input.name = name;
      input.placeholder = placeholder;
      wrap.appendChild(input);
      root.appendChild(wrap);
      return input;
    };
    const addSelect = (name, label, options) => {
      const wrap = document.createElement('label');
      wrap.textContent = label;
      const select = document.createElement('select');
      select.name = name;
      options.forEach(({ value, label: optionLabel }) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = optionLabel;
        select.appendChild(option);
      });
      wrap.appendChild(select);
      root.appendChild(wrap);
      return select;
    };
    if (preset === 'focus_chrome') {
      addField('url', 'Enter URL', 'https://example.com');
      return;
    }
    if (preset === 'focus_cursor') {
      addField('project_folder', 'Enter project folder', '/Users/you/project');
      return;
    }
    if (preset === 'focus_remote_cursor') {
      addField('remote', 'Enter remote', 'user@my-server');
      addField('project_folder', 'Enter project folder', '/home/you/project');
      return;
    }
    if (preset === 'open_app') {
      addField('app', 'Enter app', 'TextEdit');
      addField('target_path', 'Optional file/folder/URL', '~/Desktop/ResearchGoals.txt');
      return;
    }
    if (preset === 'open_window') {
      addSelect(
        'desktop',
        'Desktop to focus',
        Array.from({ length: 10 }, (_, index) => {
          const desktop = String(index + 1);
          return { value: desktop, label: `Desktop ${desktop}` };
        })
      );
    }
  }

  function openLaunchPresetModal(targetInput) {
    const returnToTaskFocus = !!targetInput?.closest('#task-focus-modal') && !els.taskFocusModal.hidden;
    launchPresetContext = { input: targetInput, preset: null, returnToTaskFocus };
    if (returnToTaskFocus) {
      els.taskFocusModal.hidden = true;
    }
    els.launchPresetModal.hidden = false;
    renderLaunchPresetFields('focus_chrome');
    launchPresetContext.preset = 'focus_chrome';
  }

  function closeLaunchPresetModal() {
    const context = launchPresetContext;
    els.launchPresetModal.hidden = true;
    launchPresetContext = null;
    els.launchPresetFields.innerHTML = '';
    if (context?.returnToTaskFocus && taskFocusContext) {
      els.taskFocusModal.hidden = false;
    }
    setTimeout(() => {
      if (context?.input?.isConnected) context.input.focus();
    }, 0);
  }

  function escapeMarkup(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function highlightBash(value) {
    const tokenPattern =
      /(#.*$)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|function|in|select|until|time)\b)|(\$[A-Za-z_][A-Za-z0-9_]*|\$\{[^}]*\}|\$\([^)]*\)|`[^`]*`)|(\b(?:cd|osascript|tell|set|repeat|exit|delay|keystroke|key|code|cursor|open|printf|echo|export|source|test|\[|\])\b)/gm;
    return escapeMarkup(value).replace(tokenPattern, (match, comment, stringValue, keyword, variable, command) => {
      const className = comment
        ? 'comment'
        : stringValue
          ? 'string'
          : keyword
            ? 'keyword'
            : variable
              ? 'variable'
              : command
                ? 'command'
                : '';
      return className ? `<span class="bash-${className}">${match}</span>` : match;
    });
  }

  function syncShellCommandHighlight() {
    if (!els.shellCommandTextarea || !els.shellCommandHighlight) return;
    const value = els.shellCommandTextarea.value || '';
    els.shellCommandHighlight.innerHTML = highlightBash(value) + (value.endsWith('\n') ? ' ' : '');
  }

  function openShellCommandEditor(targetInput) {
    const returnToTaskFocus = !!targetInput?.closest('#task-focus-modal') && !els.taskFocusModal.hidden;
    shellCommandEditorContext = { input: targetInput, returnToTaskFocus };
    if (returnToTaskFocus) {
      els.taskFocusModal.hidden = true;
    }
    els.shellCommandTextarea.value = targetInput?.value || '';
    syncShellCommandHighlight();
    els.shellCommandModal.hidden = false;
    setTimeout(() => {
      els.shellCommandTextarea.focus();
      const len = els.shellCommandTextarea.value.length;
      els.shellCommandTextarea.setSelectionRange(len, len);
    }, 0);
  }

  function closeShellCommandEditor() {
    const context = shellCommandEditorContext;
    els.shellCommandModal.hidden = true;
    shellCommandEditorContext = null;
    if (context?.returnToTaskFocus && taskFocusContext) {
      els.taskFocusModal.hidden = false;
    }
    setTimeout(() => {
      if (context?.input?.isConnected) context.input.focus();
    }, 0);
  }

  function useShellCommandEditorValue() {
    const context = shellCommandEditorContext;
    if (!context?.input) return;
    context.input.value = els.shellCommandTextarea.value;
    context.input.dispatchEvent(new Event('input', { bubbles: true }));
    context.input.dispatchEvent(new Event('change', { bubbles: true }));
    closeShellCommandEditor();
  }

  function addCommandField(form, fieldName, value = '') {
    const container = getCommandListContainer(form, fieldName);
    if (!container) return null;
    const row = document.createElement('div');
    row.className = 'launch-command-row';

    const input = document.createElement('input');
    input.name = fieldName;
    input.type = 'text';
    input.placeholder = 'e.g. code ~/projects/my-app';
    input.value = value;

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'icon-button launch-command-remove';
    removeButton.dataset.removeLaunchCommand = 'true';
    removeButton.textContent = 'Remove';
    removeButton.addEventListener('click', () => {
      row.remove();
      updateCommandRemoveButtons(container);
    });

    const presetButton = document.createElement('button');
    presetButton.type = 'button';
    presetButton.className = 'ghost-button launch-command-default';
    presetButton.textContent = 'Default launch command';
    presetButton.addEventListener('click', () => {
      openLaunchPresetModal(input);
    });

    row.append(input, presetButton, removeButton);
    container.appendChild(row);
    updateCommandRemoveButtons(container);
    return input;
  }

  function renderCommandFields(form, fieldName, commands = []) {
    const container = getCommandListContainer(form, fieldName);
    if (!container) return;
    container.innerHTML = '';
    const values = normalizeLaunchCommands(commands);
    (values.length ? values : ['']).forEach((command) => addCommandField(form, fieldName, command));
  }

  function collectCommandFields(form, fieldName) {
    return normalizeLaunchCommands([...form.querySelectorAll(`[name="${fieldName}"]`)].map((input) => input.value));
  }

  function createWorkspaceInput(name, placeholder, value = '') {
    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.workspaceField = name;
    input.placeholder = placeholder;
    input.value = value || '';
    return input;
  }

  function createWorkspaceTextarea(name, placeholder, value = '') {
    const textarea = document.createElement('textarea');
    textarea.dataset.workspaceField = name;
    textarea.placeholder = placeholder;
    textarea.value = value || '';
    textarea.rows = 1;
    return textarea;
  }

  function createWorkspaceSelect(name, options, value) {
    const select = document.createElement('select');
    select.dataset.workspaceField = name;
    options.forEach(({ value: optionValue, label }) => {
      const option = document.createElement('option');
      option.value = optionValue;
      option.textContent = label;
      select.appendChild(option);
    });
    select.value = value;
    return select;
  }

  function createWorkspaceCheckbox(name, label, checked = false) {
    const wrap = document.createElement('label');
    wrap.className = 'workspace-checkbox-label';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.workspaceField = name;
    input.checked = !!checked;
    const text = document.createElement('span');
    text.textContent = label;
    wrap.append(input, text);
    return wrap;
  }

  function trimValue(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function pathLeaf(value) {
    const trimmed = trimValue(value).replace(/[\\/]+$/, '');
    if (!trimmed) return '';
    const parts = trimmed.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || trimmed;
  }

  function workspaceItemSummary(item) {
    const type = item?.type || 'shell';
    if (type === 'cursor_project') {
      const name = pathLeaf(item.workspace_path) || 'Project';
      return `Cursor · ${name}`;
    }
    if (type === 'chrome_page') return `Chrome · ${trimValue(item.url) || 'URL'}`;
    if (type === 'app_file') {
      const app = trimValue(item.app) || 'App';
      const target = trimValue(item.target_path);
      return target ? `${app} · ${target}` : app;
    }
    if (type === 'obsidian_note') {
      const vault = trimValue(item.vault) || 'Vault';
      const note = trimValue(item.note_path);
      return note ? `Obsidian · ${vault} · ${note}` : `Obsidian · ${vault}`;
    }
    if (type === 'desktop') return `Desktop ${item.desktop || 1}`;
    return `Custom · ${trimValue(item.label) || 'Shell command'}`;
  }

  function renderWorkspaceSummary(form) {
    if (!form) return;
    const summary = form.querySelector('[data-workspace-summary]');
    if (!summary) return;
    const items = collectWorkspaceItems(form).filter((item) => {
      if (item.type === 'shell') return trimValue(item.command) || trimValue(item.label);
      return true;
    });
    summary.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('span');
      empty.className = 'workspace-summary-empty';
      empty.textContent = 'No launch targets configured.';
      summary.appendChild(empty);
      return;
    }
    items.forEach((item) => {
      const pill = document.createElement('span');
      pill.className = 'workspace-summary-pill';
      pill.textContent = workspaceItemSummary(item);
      if (item.is_primary) pill.dataset.primary = 'true';
      summary.appendChild(pill);
    });
  }

  function collectWorkspaceItemFromRow(row) {
    const type = row.querySelector('[data-workspace-kind]')?.value || 'shell';
    const item = { id: row.dataset.workspaceItemId || workspaceItemId(), type };
    row.querySelectorAll('[data-workspace-field]').forEach((field) => {
      item[field.dataset.workspaceField] = field.type === 'checkbox' ? field.checked : field.value;
    });
    if (type === 'desktop') {
      item.desktop = Number(item.desktop);
    }
    return item;
  }

  function buildWorkspacePreview(item) {
    const helper = window.DefaultLaunchCommands;
    if (!helper?.buildWorkspaceItemCommands) return '';
    const commands = helper.buildWorkspaceItemCommands(item);
    if (item.is_primary) commands.push(helper.buildWorkspaceItemCommand(item));
    return commands.join('\n');
  }

  function updateWorkspaceItemPreview(row) {
    const preview = row.querySelector('[data-workspace-preview]');
    if (preview) {
      try {
        preview.textContent = buildWorkspacePreview(collectWorkspaceItemFromRow(row));
        preview.classList.remove('error');
      } catch (err) {
        preview.textContent = err.message || 'Complete this item to preview the command.';
        preview.classList.add('error');
      }
    }
    const form = row.closest('form');
    if (form) renderWorkspaceSummary(form);
  }

  function clearOtherPrimaryWorkspaceRows(form, row) {
    form.querySelectorAll('[data-workspace-items] .workspace-item-row').forEach((otherRow) => {
      if (otherRow === row) return;
      const primary = otherRow.querySelector('[data-workspace-field="is_primary"]');
      if (primary) primary.checked = false;
      updateWorkspaceItemPreview(otherRow);
    });
  }

  function renderWorkspaceItemFields(row, item) {
    const fields = row.querySelector('[data-workspace-fields]');
    fields.innerHTML = '';
    const type = item.type || 'shell';

    if (type === 'cursor_project') {
      const source = createWorkspaceSelect(
        'source',
        [
          { value: 'local', label: 'Local' },
          { value: 'ssh', label: 'Remote' },
        ],
        item.source === 'ssh' ? 'ssh' : 'local'
      );
      fields.append(source);
      if (source.value === 'ssh') {
        fields.append(createWorkspaceInput('remote_host', 'Remote host', item.remote_host || ''));
      }
      fields.append(
        createWorkspaceInput(
          'workspace_path',
          source.value === 'ssh' ? '/home/you/Repos/orchestra' : '/Users/you/Repos/orchestra',
          item.workspace_path || ''
        )
      );
      source.addEventListener('change', () => {
        const next = collectWorkspaceItemFromRow(row);
        next.source = source.value;
        renderWorkspaceItemFields(row, next);
        updateWorkspaceItemPreview(row);
      });
    } else if (type === 'chrome_page') {
      fields.append(createWorkspaceInput('url', 'https://example.com', item.url || ''));
    } else if (type === 'app_file') {
      fields.append(createWorkspaceInput('app', 'TextEdit', item.app || ''));
      fields.append(createWorkspaceInput('target_path', 'Optional file/folder/URL', item.target_path || ''));
    } else if (type === 'obsidian_note') {
      fields.append(createWorkspaceInput('vault', 'Work', item.vault || ''));
      fields.append(createWorkspaceInput('note_path', 'Projects/orchestra', item.note_path || ''));
    } else if (type === 'desktop') {
      fields.append(
        createWorkspaceSelect(
          'desktop',
          Array.from({ length: 10 }, (_, index) => {
            const desktop = String(index + 1);
            return { value: desktop, label: `Desktop ${desktop}` };
          }),
          String(item.desktop || 1)
        )
      );
    } else {
      fields.append(createWorkspaceInput('label', 'Label (e.g. Start dev server)', item.label || ''));
      const commandDetails = document.createElement('details');
      commandDetails.className = 'workspace-command-details';
      const summary = document.createElement('summary');
      summary.textContent = 'Shell command';
      const commandRow = document.createElement('div');
      commandRow.className = 'workspace-command-input-row';
      const commandInput = createWorkspaceTextarea('command', 'Shell command', item.command || '');
      const advancedButton = document.createElement('button');
      advancedButton.type = 'button';
      advancedButton.className = 'ghost-button workspace-command-advanced';
      advancedButton.textContent = 'Advanced';
      advancedButton.addEventListener('click', () => openShellCommandEditor(commandInput));
      commandRow.append(commandInput, advancedButton);
      commandDetails.append(summary, commandRow);
      fields.append(commandDetails);
    }

    fields.querySelectorAll('input, select, textarea').forEach((field) => {
      field.addEventListener('input', () => updateWorkspaceItemPreview(row));
      field.addEventListener('change', () => updateWorkspaceItemPreview(row));
    });

    const primaryLabel = createWorkspaceCheckbox('is_primary', 'Raise last', !!item.is_primary);
    const primaryInput = primaryLabel.querySelector('input');
    primaryInput.addEventListener('change', () => {
      if (primaryInput.checked) clearOtherPrimaryWorkspaceRows(row.closest('form'), row);
      updateWorkspaceItemPreview(row);
    });
    fields.append(primaryLabel);
  }

  function addWorkspaceItemRow(form, item = defaultWorkspaceItem('shell')) {
    const container = form.querySelector('[data-workspace-items]');
    if (!container) return null;
    const normalized = { ...defaultWorkspaceItem(item.type || 'shell'), ...item };
    const row = document.createElement('div');
    row.className = 'workspace-item-row';
    row.dataset.workspaceItemId = normalized.id || workspaceItemId();

    const top = document.createElement('div');
    top.className = 'workspace-item-top';

    const typeSelect = document.createElement('select');
    typeSelect.dataset.workspaceKind = 'true';
    const typeOptions =
      normalized.type === 'obsidian_note' ? WORKSPACE_ITEM_TYPES : DEFAULT_WORKSPACE_ITEM_TYPES;
    typeOptions.forEach(({ value, label }) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      typeSelect.appendChild(option);
    });
    typeSelect.value = normalized.type || 'shell';

    const moveUpButton = document.createElement('button');
    moveUpButton.type = 'button';
    moveUpButton.className = 'icon-button';
    moveUpButton.textContent = 'Up';
    moveUpButton.addEventListener('click', () => {
      const previous = row.previousElementSibling;
      if (previous) container.insertBefore(row, previous);
      renderWorkspaceSummary(row.closest('form'));
    });

    const moveDownButton = document.createElement('button');
    moveDownButton.type = 'button';
    moveDownButton.className = 'icon-button';
    moveDownButton.textContent = 'Down';
    moveDownButton.addEventListener('click', () => {
      const next = row.nextElementSibling;
      if (next) container.insertBefore(next, row);
      renderWorkspaceSummary(row.closest('form'));
    });

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'icon-button launch-command-remove';
    removeButton.textContent = 'Remove';
    removeButton.addEventListener('click', () => {
      const form = row.closest('form');
      row.remove();
      renderWorkspaceSummary(form);
    });

    const fields = document.createElement('div');
    fields.className = 'workspace-item-fields';
    fields.dataset.workspaceFields = 'true';

    const previewDetails = document.createElement('details');
    previewDetails.className = 'workspace-preview-details';
    const previewSummary = document.createElement('summary');
    previewSummary.textContent = 'Command preview';
    const preview = document.createElement('div');
    preview.className = 'workspace-item-preview';
    preview.dataset.workspacePreview = 'true';
    previewDetails.append(previewSummary, preview);

    typeSelect.addEventListener('change', () => {
      const next = defaultWorkspaceItem(typeSelect.value);
      next.id = row.dataset.workspaceItemId;
      renderWorkspaceItemFields(row, next);
      updateWorkspaceItemPreview(row);
    });

    top.append(typeSelect, moveUpButton, moveDownButton, removeButton);
    row.append(top, fields, previewDetails);
    container.appendChild(row);
    renderWorkspaceItemFields(row, normalized);
    updateWorkspaceItemPreview(row);
    return row;
  }

  function renderWorkspaceItems(form, items = []) {
    const container = form.querySelector('[data-workspace-items]');
    if (!container) return;
    container.innerHTML = '';
    const values = Array.isArray(items) ? items : [];
    let primaryIndex = -1;
    values.forEach((item, index) => {
      if (item?.is_primary) primaryIndex = index;
    });
    values.forEach((item, index) => addWorkspaceItemRow(form, { ...item, is_primary: index === primaryIndex }));
    renderWorkspaceSummary(form);
  }

  function collectWorkspaceItems(form) {
    return [...form.querySelectorAll('[data-workspace-items] .workspace-item-row')].map(collectWorkspaceItemFromRow);
  }

  function renderProjectCommandFields(form, project = null) {
    renderWorkspaceItems(form, project ? getProjectWorkspaceItems(project) : []);
  }

  function getProjectCursorRemote(project) {
    return project && project.cursor_remote && typeof project.cursor_remote === 'object'
      ? project.cursor_remote
      : null;
  }

  function newCursorRemoteRowId() {
    return window.crypto?.randomUUID?.() || `r-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }

  function getProjectCursorRemotes(project) {
    if (Array.isArray(project?.cursor_remotes) && project.cursor_remotes.length) {
      return project.cursor_remotes.map((r) => ({
        id: typeof r.id === 'string' && r.id.trim() ? r.id.trim() : newCursorRemoteRowId(),
        host: r.host || '',
      }));
    }
    const legacy = getProjectCursorRemote(project);
    return legacy
    ? [{ id: newCursorRemoteRowId(), host: legacy.host || '' }]
      : [];
  }

  function getProjectCursorWorkspaces(project) {
    if (!Array.isArray(project?.cursor_workspaces)) return [];
    return project.cursor_workspaces
      .filter((item) => item && typeof item === 'object' && typeof item.workspace_path === 'string')
      .map((item) => {
        const row = {
          source: item.source === 'ssh' ? 'ssh' : 'local',
          workspace_path: item.workspace_path.trim(),
        };
        if (row.source === 'ssh' && typeof item.remote_id === 'string' && item.remote_id.trim()) {
          row.remote_id = item.remote_id.trim();
        }
        return row;
      })
      .filter((item) => item.workspace_path);
  }

  function getTaskWatchTracking(task) {
    return task.watch_tracking || task.cursor_tracking || null;
  }

  function getCursorRemotePayloadFromForm(form) {
    return { cursor_remotes: collectCursorRemotes(form) };
  }

  function collectCursorRemotes(form) {
    const rows = [...form.querySelectorAll('[data-cursor-remote-hosts] [data-cursor-remote-host-row]')];
    const out = [];
    rows.forEach((row) => {
      const id = row.dataset.remoteId || '';
      const host = row.querySelector('[data-cursor-remote-host]')?.value?.trim() || '';
      if (!host) return;
      out.push({
        id: id || newCursorRemoteRowId(),
        host,
      });
    });
    return out;
  }

  function refreshCursorWorkspaceRemoteSelects(form) {
    const remotes = collectCursorRemotes(form);
    form.querySelectorAll('[data-cursor-workspace-row] [name="cursor_workspace_remote_id"]').forEach((sel) => {
      const prev = sel.value;
      sel.innerHTML = '';
      const first = document.createElement('option');
      first.value = '';
      first.textContent = remotes.length ? 'Default remote host' : 'Add a remote host above';
      sel.appendChild(first);
      remotes.forEach((r) => {
        const opt = document.createElement('option');
        opt.value = r.id;
        opt.textContent = `${r.host}`;
        sel.appendChild(opt);
      });
      if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
    });
  }

function addCursorRemoteHostRow(form, value = { id: '', host: '' }) {
    const container = form.querySelector('[data-cursor-remote-hosts]');
    const row = document.createElement('div');
    row.className = 'launch-command-row';
    row.dataset.cursorRemoteHostRow = 'true';
    row.dataset.remoteId = value.id && String(value.id).trim() ? String(value.id).trim() : newCursorRemoteRowId();

    const hostInput = document.createElement('input');
    hostInput.type = 'text';
    hostInput.dataset.cursorRemoteHost = 'true';
    hostInput.placeholder = 'SSH host (e.g. my-server or user@host)';
    hostInput.value = value.host || '';

    const onChange = () => refreshCursorWorkspaceRemoteSelects(form);
    hostInput.addEventListener('input', onChange);

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'icon-button launch-command-remove';
    removeButton.textContent = 'Remove';
    removeButton.addEventListener('click', () => {
      row.remove();
      refreshCursorWorkspaceRemoteSelects(form);
    });

  row.append(hostInput, removeButton);
    container.appendChild(row);
    refreshCursorWorkspaceRemoteSelects(form);
    return hostInput;
  }

  function renderCursorRemoteHostFields(form, remotes = []) {
    const container = form.querySelector('[data-cursor-remote-hosts]');
    container.innerHTML = '';
    const list = Array.isArray(remotes) ? remotes : [];
    if (!list.length) {
      refreshCursorWorkspaceRemoteSelects(form);
      return;
    }
    list.forEach((r) => addCursorRemoteHostRow(form, r));
  }

  function addCursorWorkspaceField(form, value = { source: 'local', workspace_path: '', remote_id: '' }) {
    const container = form.querySelector('[data-cursor-workspaces]');
    const row = document.createElement('div');
    row.className = 'launch-command-row';
    row.dataset.cursorWorkspaceRow = 'true';

    const source = document.createElement('select');
    source.name = 'cursor_workspace_source';
    const localOption = document.createElement('option');
    localOption.value = 'local';
    localOption.textContent = 'Local';
    const remoteOption = document.createElement('option');
    remoteOption.value = 'ssh';
    remoteOption.textContent = 'Remote';
    source.append(localOption, remoteOption);
    source.value = value.source === 'ssh' ? 'ssh' : 'local';

    const remoteHost = document.createElement('select');
    remoteHost.name = 'cursor_workspace_remote_id';
    remoteHost.className = 'cursor-workspace-remote-select';
    remoteHost.title = 'Remote SSH host for this workspace path';

    const input = document.createElement('input');
    input.name = 'cursor_workspace_path';
    input.type = 'text';
    input.placeholder = source.value === 'ssh' ? '/home/you/Repos/orchestra' : '/Users/you/Repos/orchestra';
    input.value = value.workspace_path || '';

    const syncRemoteVisible = () => {
      const isRemote = source.value === 'ssh';
      remoteHost.hidden = !isRemote;
      remoteHost.style.display = isRemote ? '' : 'none';
      input.placeholder = isRemote ? '/home/you/Repos/orchestra' : '/Users/you/Repos/orchestra';
    };
    source.addEventListener('change', () => {
      syncRemoteVisible();
    });

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'icon-button launch-command-remove';
    removeButton.textContent = 'Remove';
    removeButton.addEventListener('click', () => row.remove());

    row.append(source, remoteHost, input, removeButton);
    container.appendChild(row);
    refreshCursorWorkspaceRemoteSelects(form);
    if (value.remote_id && [...remoteHost.options].some((o) => o.value === value.remote_id)) {
      remoteHost.value = value.remote_id;
    }
    syncRemoteVisible();
    return input;
  }

  function renderCursorWorkspaceFields(form, workspaces = []) {
    const container = form.querySelector('[data-cursor-workspaces]');
    container.innerHTML = '';
    const normalized = Array.isArray(workspaces) ? workspaces : [];
    normalized.forEach((workspace) => addCursorWorkspaceField(form, workspace));
  }

  function collectCursorWorkspaces(form) {
    const rows = [...form.querySelectorAll('[data-cursor-workspaces] [data-cursor-workspace-row]')];
    const out = [];
    rows.forEach((row) => {
      const source = row.querySelector('[name="cursor_workspace_source"]')?.value === 'ssh' ? 'ssh' : 'local';
      const workspace_path = row.querySelector('[name="cursor_workspace_path"]')?.value?.trim() || '';
      if (!workspace_path) return;
      const entry = { source, workspace_path };
      if (source === 'ssh') {
        const rid = row.querySelector('[name="cursor_workspace_remote_id"]')?.value?.trim() || '';
        if (rid) entry.remote_id = rid;
      }
      out.push(entry);
    });
    return out;
  }

  function setRemoteWatchPanelOpen(form, isOpen) {
    const panel = form.querySelector('[data-remote-watch-panel]');
    if (panel) panel.open = !!isOpen;
  }

  function setWorkspacePanelOpen(form, isOpen) {
    const panel = form.querySelector('[data-workspace-panel]');
    if (panel) panel.open = !!isOpen;
  }

  function setupProjectCommandFields(form) {
    form.querySelector('[data-configure-workspace]')?.addEventListener('click', () => {
      setWorkspacePanelOpen(form, true);
      form.querySelector('[data-workspace-panel]')?.scrollIntoView({ block: 'nearest' });
    });
    form.querySelector('[data-add-workspace-item]')?.addEventListener('click', () => {
      const row = addWorkspaceItemRow(form, defaultWorkspaceItem('shell'));
      row?.querySelector('[data-workspace-kind]')?.focus();
    });
    form.querySelector('[data-add-cursor-workspace]')?.addEventListener('click', () => {
      addCursorWorkspaceField(form).focus();
    });
    form.querySelector('[data-add-cursor-remote-host]')?.addEventListener('click', () => {
      addCursorRemoteHostRow(form).focus();
    });
    renderProjectCommandFields(form);
    renderCursorRemoteHostFields(form, []);
    renderCursorWorkspaceFields(form);
  }

  function setupLaunchPresetModal() {
    const helper = window.DefaultLaunchCommands;
    if (!helper) return;

    els.launchPresetModal.addEventListener('click', (e) => {
      if (e.target === els.launchPresetModal) closeLaunchPresetModal();
    });
    els.launchPresetCancel.addEventListener('click', () => closeLaunchPresetModal());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !els.launchPresetModal.hidden) {
        e.preventDefault();
        closeLaunchPresetModal();
      }
    });

    els.launchPresetModal.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-launch-preset]');
      if (!btn || !launchPresetContext) return;
      const preset = btn.dataset.launchPreset;
      launchPresetContext.preset = preset;
      renderLaunchPresetFields(preset);
    });

    els.launchPresetUse.addEventListener('click', () => {
      if (!launchPresetContext || !launchPresetContext.input || !launchPresetContext.preset) return;
      const values = {};
      [...els.launchPresetFields.querySelectorAll('input')].forEach((input) => {
        values[input.name] = input.value || '';
      });
      [...els.launchPresetFields.querySelectorAll('select')].forEach((select) => {
        values[select.name] = select.value || '';
      });
      try {
        const cmd = helper.buildDefaultLaunchCommand(launchPresetContext.preset, values);
        launchPresetContext.input.value = cmd;
        closeLaunchPresetModal();
      } catch (err) {
        toast(err.message || String(err), true);
      }
    });
  }

  function setupShellCommandEditor() {
    els.shellCommandTextarea.addEventListener('input', syncShellCommandHighlight);
    els.shellCommandTextarea.addEventListener('scroll', () => {
      const highlight = els.shellCommandHighlight?.parentElement;
      if (!highlight) return;
      highlight.scrollTop = els.shellCommandTextarea.scrollTop;
      highlight.scrollLeft = els.shellCommandTextarea.scrollLeft;
    });
    els.shellCommandModal.addEventListener('click', (e) => {
      if (e.target === els.shellCommandModal) closeShellCommandEditor();
    });
    els.shellCommandCancel.addEventListener('click', () => closeShellCommandEditor());
    els.shellCommandUse.addEventListener('click', () => useShellCommandEditorValue());
    document.addEventListener('keydown', (e) => {
      if (els.shellCommandModal.hidden) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeShellCommandEditor();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        useShellCommandEditorValue();
      }
    });
  }

  function getTaskFocusModalTarget() {
    if (!taskFocusContext) return {};
    const project = state.data.projects.find((p) => p.id === taskFocusContext.projectId);
    const task = project?.tasks.find((t) => t.id === taskFocusContext.taskId);
    return { project, task };
  }

  function setupTaskFocusModal() {
    const form = els.taskFocusForm;
    const focusTargetOptions = form.querySelector('[data-focus-target-options]');

    const addFocusTarget = (type) => {
      const row = addWorkspaceItemRow(form, defaultWorkspaceItem(type || 'shell'));
      if (focusTargetOptions) focusTargetOptions.hidden = true;
      row?.querySelector('[data-workspace-field]')?.focus();
    };

    els.taskFocusAddCommand.addEventListener('click', () => {
      if (!focusTargetOptions) {
        addFocusTarget('shell');
        return;
      }
      focusTargetOptions.hidden = !focusTargetOptions.hidden;
    });

    focusTargetOptions?.addEventListener('click', (e) => {
      const copyButton = e.target.closest('[data-copy-workspace-focus]');
      if (copyButton) {
        const { project } = getTaskFocusModalTarget();
        if (!project) return;
        const workspaceItems = getProjectWorkspaceItems(project);
        if (workspaceItems.length === 0) {
          toast('No workspace launch targets configured', true);
          return;
        }
        workspaceItems.forEach((item) => {
          addWorkspaceItemRow(form, { ...item, id: workspaceItemId() });
        });
        if (focusTargetOptions) focusTargetOptions.hidden = true;
        return;
      }
      const button = e.target.closest('[data-focus-target-type]');
      if (!button) return;
      addFocusTarget(button.dataset.focusTargetType || 'shell');
    });

    els.taskFocusCancel.addEventListener('click', () => closeTaskFocusModal());
    els.taskFocusModal.addEventListener('click', (e) => {
      if (e.target === els.taskFocusModal) closeTaskFocusModal();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || els.taskFocusModal.hidden || !els.launchPresetModal.hidden) return;
      e.preventDefault();
      closeTaskFocusModal();
    });

    els.taskFocusClear.addEventListener('click', async () => {
      const { project, task } = getTaskFocusModalTarget();
      if (!project || !task) return;
      closeTaskFocusModal();
      await patchTask(project, task, { focus_items: [], focus_commands: [] });
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const { project, task } = getTaskFocusModalTarget();
      if (!project || !task) return;
      const focus_items = collectWorkspaceItems(form);
      closeTaskFocusModal();
      await patchTask(project, task, { focus_items, focus_commands: [] });
    });

    els.addTitleCancel.addEventListener('click', () => closeAddTitleModal());
    els.addTitleModal.addEventListener('click', (e) => {
      if (e.target === els.addTitleModal) closeAddTitleModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || els.addTitleModal.hidden) return;
      e.preventDefault();
      closeAddTitleModal();
    });
    els.addTitleForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const { project, task } = addTitleModalTarget();
      if (!project || !task) return;
      const title_provider = els.addTitleProvider.value.trim();
      const chat_title = els.addTitleText.value.trim();
      const manual_location = els.addTitleLocation.value.trim();
      // A recognized provider name yields its brand glyph; the chosen platform yields its surface
      // glyph. Capture surface before closeAddTitleModal() resets addTitleSurface.
      const provider_kind = providerKindFromText(title_provider);
      const surface_kind = addTitleSurface;
      closeAddTitleModal();
      await patchTask(project, task, {
        title_provider,
        chat_title,
        manual_location,
        provider_kind,
        surface_kind,
      });
    });

    // Context note modal wiring.
    els.contextNoteEdit.addEventListener('click', () => setContextNoteMode(true));
    els.contextNoteView.addEventListener('click', (e) => {
      // Follow a link if one was clicked; don't hijack a text selection; otherwise start editing.
      if (e.target.closest('a')) return;
      if (window.getSelection && String(window.getSelection()).length) return;
      setContextNoteMode(true);
    });
    els.contextNoteSave.addEventListener('click', () => saveContextNote());
    els.contextNoteCancel.addEventListener('click', () => {
      const { task } = contextNoteModalTarget();
      const saved = String(task?.context_note || '');
      els.contextNoteTextarea.value = saved;
      renderContextNote(els.contextNoteView, saved);
      setContextNoteMode(false);
    });
    els.contextNoteClose.addEventListener('click', () => closeContextModal());
    els.contextNoteModal.addEventListener('click', (e) => {
      if (e.target === els.contextNoteModal) closeContextModal();
    });
    els.contextNoteTextarea.addEventListener('keydown', (e) => {
      // ⌘/Ctrl+Enter saves (plain Enter inserts a newline, as expected in a textarea).
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        saveContextNote();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || els.contextNoteModal.hidden) return;
      e.preventDefault();
      closeContextModal();
    });
  }

  function setupNewProjectForm() {
    const form = els.newProjectForm;
    let selectedColor = 'teal';
    const colorRow = form.querySelector('.color-row');

    const reset = () => {
      form.reset();
      renderProjectCommandFields(form);
      renderCursorWorkspaceFields(form);
      renderCursorRemoteHostFields(form, []);
      setRemoteWatchPanelOpen(form, false);
      setWorkspacePanelOpen(form, false);
      selectedColor = 'teal';
      buildColorRow(colorRow, selectedColor, (c) => (selectedColor = c));
    };

    setupProjectCommandFields(form);
    buildColorRow(colorRow, selectedColor, (c) => (selectedColor = c));

    els.newProjectBtn.addEventListener('click', () => {
      setWorkspacePanelOpen(form, false);
      form.hidden = false;
      els.newProjectBtn.hidden = true;
      form.querySelector('[name="name"]').focus();
    });

    form.querySelector('[data-cancel]').addEventListener('click', () => {
      form.hidden = true;
      els.newProjectBtn.hidden = false;
      reset();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = form.querySelector('[name="name"]').value.trim();
      const workspace_items = collectWorkspaceItems(form);
      const cursor_workspaces = collectCursorWorkspaces(form);
      const task_summary = form.querySelector('[name="task_summary"]').value;
      const cursorRemotePayload = getCursorRemotePayloadFromForm(form);
      const is_backlog = form.querySelector('[name="is_backlog"]').checked;
      if (!name) return;
      try {
        const created = await api('POST', '/api/projects', {
          name,
          launch_command: '',
          launch_commands: [],
          workspace_items,
          cursor_workspaces,
          task_summary,
          ...cursorRemotePayload,
          is_backlog,
          color: selectedColor,
        });
        state.selectedProjectId = created.id;
        form.hidden = true;
        els.newProjectBtn.hidden = false;
        reset();
        await refresh();
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  function setupEditProjectForm() {
    const form = els.editProjectForm;
    let selectedColor = 'teal';
    const colorRow = form.querySelector('.color-row');

    const open = () => {
      const project = state.data.projects.find((p) => p.id === state.selectedProjectId);
      if (!project) return;
      selectedColor = project.color || 'teal';
      form.querySelector('[name="name"]').value = project.name;
      renderProjectCommandFields(form, project);
      renderCursorRemoteHostFields(form, getProjectCursorRemotes(project));
      renderCursorWorkspaceFields(form, getProjectCursorWorkspaces(project));
      form.querySelector('[name="task_summary"]').value = project.task_summary || '';
      form.querySelector('[name="is_backlog"]').checked = isBacklogProject(project);
      // Live mode is a per-project display preference (persisted by LiveFeedUI in localStorage).
      form.querySelector('[name="live_mode"]').checked = !!(window.LiveFeedUI && LiveFeedUI.isLive(project));
      setRemoteWatchPanelOpen(form, false);
      buildColorRow(colorRow, selectedColor, (c) => (selectedColor = c));
      form.hidden = false;
      form.querySelector('[name="name"]').focus();
    };

    setupProjectCommandFields(form);
    els.editProjectBtn.addEventListener('click', open);

    form.querySelector('[data-cancel]').addEventListener('click', () => {
      form.hidden = true;
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const project = state.data.projects.find((p) => p.id === state.selectedProjectId);
      if (!project) return;
      const name = form.querySelector('[name="name"]').value.trim();
      const workspace_items = collectWorkspaceItems(form);
      const cursor_workspaces = collectCursorWorkspaces(form);
      const task_summary = form.querySelector('[name="task_summary"]').value;
      const cursorRemotePayload = getCursorRemotePayloadFromForm(form);
      const is_backlog = form.querySelector('[name="is_backlog"]').checked;
      const live = form.querySelector('[name="live_mode"]').checked;
      if (!name) return;
      try {
        await api('PATCH', `/api/projects/${project.id}`, {
          name,
          launch_command: '',
          launch_commands: [],
          workspace_items,
          cursor_workspaces,
          task_summary,
          ...cursorRemotePayload,
          is_backlog,
          color: selectedColor,
        });
        form.hidden = true;
        // Apply the per-project live-mode preference (writes localStorage, re-renders, and
        // starts/stops the live poll + ticker).
        if (window.LiveFeedUI) LiveFeedUI.setMode(project, live ? 'live' : 'plain');
        await refresh();
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  function setupDeleteProject() {
    els.deleteProjectBtn.addEventListener('click', async () => {
      const project = state.data.projects.find((p) => p.id === state.selectedProjectId);
      if (!project) return;
      if (!confirm(`Delete project "${project.name}" and all its tasks?`)) return;
      try {
        await api('DELETE', `/api/projects/${project.id}`);
        state.selectedProjectId = null;
        await refresh();
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  function setupTaskBacklogHeaderButton() {
    els.toggleTaskBacklogBtn?.addEventListener('click', () => {
      state.showTaskBacklog = !state.showTaskBacklog;
      writeShowTaskBacklogPreference(state.showTaskBacklog);
      applyTaskBacklogHeaderButton();
      renderPane();
    });
    applyTaskBacklogHeaderButton();
  }

  function setupToggleAllProgressButton() {
    els.toggleAllProgressBtn?.addEventListener('click', () => {
      const project = state.data.projects.find((p) => p.id === state.selectedProjectId);
      if (!project) return;
      const tasks = visibleProjectTasks(project);
      if (tasks.length === 0) return;
      const anyHidden = tasks.some((t) => state.taskProgressHiddenIds.has(t.id));
      // Any collapsed → reveal all; otherwise collapse all.
      tasks.forEach((t) => {
        if (anyHidden) state.taskProgressHiddenIds.delete(t.id);
        else state.taskProgressHiddenIds.add(t.id);
      });
      writeTaskProgressHiddenIds(state.taskProgressHiddenIds);
      renderPane();
    });
  }

  function setupFocusButton() {
    if (!els.focusBtn) return;
    els.focusBtn.addEventListener('click', async () => {
      const project = state.data.projects.find((p) => p.id === state.selectedProjectId);
      if (!project) return;
      try {
        const result = await api('POST', `/api/projects/${project.id}/focus`);
        if (!result.ok) {
          toast(result.error || 'Focus failed', true);
        } else if (result.error) {
          toast(`Warning: ${result.error}`, true);
        }
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  function setupWorkspaceButton() {
    els.workspaceBtn.addEventListener('click', async () => {
      const project = state.data.projects.find((p) => p.id === state.selectedProjectId);
      if (!project) return;
      try {
        const result = await api('POST', `/api/projects/${project.id}/workspace`);
        if (!result.ok) {
          toast(result.error || 'Open Workspace failed', true);
        } else if (result.error) {
          toast(`Warning: ${result.error}`, true);
        }
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  function setupNewTaskForm() {
    els.newTaskForm.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      const t = e.target;
      if (!t || t.getAttribute('name') !== 'text') return;
      if ((t.tagName || '').toLowerCase() !== 'textarea') return;
      e.preventDefault();
      els.newTaskForm.requestSubmit();
    });
    els.newTaskForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = els.newTaskForm.querySelector('[name="text"]');
      const text = input.value.trim();
      if (!text) return;
      const project = state.data.projects.find((p) => p.id === state.selectedProjectId);
      if (!project) return;
      input.value = '';
      try {
        await api('POST', `/api/projects/${project.id}/tasks`, taskBodyFromText(text));
        await refresh();
      } catch (err) {
        toast(err.message, true);
        input.value = text;
      }
    });

    // Monitor pill on the add-task box: create the task, then open the watcher/state modal on it.
    if (els.newTaskMonitor) {
      setPillContent(els.newTaskMonitor, EYE_ICON_SVG, 'monitor');
      els.newTaskMonitor.title =
        'Add this task, then choose an agent to watch (fills in provider + title) or set its state';
      els.newTaskMonitor.addEventListener('click', async () => {
        const input = els.newTaskForm.querySelector('[name="text"]');
        const text = input.value.trim();
        const project = state.data.projects.find((p) => p.id === state.selectedProjectId);
        if (!project) return;
        input.value = '';
        const body = text ? taskBodyFromText(text) : { text: '', allow_blank: true };
        let created;
        try {
          created = await api('POST', `/api/projects/${project.id}/tasks`, body);
          await refresh();
        } catch (err) {
          toast(err.message, true);
          input.value = text;
          return;
        }
        const proj = state.data.projects.find((p) => p.id === project.id);
        const task = proj?.tasks.find((t) => t.id === created.id);
        if (proj && task) await openCursorWaitModal(proj, task);
      });
    }
  }

  function setupDesktopBridge() {
    const bridge = window.orchestraDesktop || window.agentTaskTrackerDesktop;
    if (!bridge || typeof bridge.onSpellcheckMenuState !== 'function') return;
    bridge.onSpellcheckMenuState(({ open } = {}) => {
      state.spellcheckContextMenuOpen = !!open;
      if (state.spellcheckContextMenuOpen || !state.pendingSpellcheckBlurFinish) return;
      const finish = state.pendingSpellcheckBlurFinish;
      state.pendingSpellcheckBlurFinish = null;
      setTimeout(finish, 0);
    });
  }

  function setupProjectsSidebarToggle() {
    els.projectsToggleBtn.addEventListener('click', () => {
      state.projectsSidebarVisible = !state.projectsSidebarVisible;
      applyProjectsSidebarVisibility();
    });
    els.toggleProjectWaitingBadgesBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      state.projectWaitingBadgesHidden = !state.projectWaitingBadgesHidden;
      writeProjectWaitingBadgesHiddenPreference(state.projectWaitingBadgesHidden);
      applyProjectsSidebarVisibility();
    });
    applyProjectsSidebarVisibility();
  }

  // Drag the divider between the sidebar and the pane to resize the projects panel.
  // The width feeds the CSS var --sidebar-w-open; --sidebar-w (and thus the grid + the
  // window-centered project column) follow it automatically.
  function setupSidebarResize() {
    const handle = els.sidebarResizer;
    if (!handle) return;

    function setOpenWidth(px) {
      els.app.style.setProperty('--sidebar-w-open', `${clampSidebarWidth(px)}px`);
    }
    function currentOpenWidth() {
      const raw = getComputedStyle(els.app).getPropertyValue('--sidebar-w-open');
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : SIDEBAR_WIDTH_DEFAULT;
    }

    // Apply the persisted width up front, without animating the sidebar open on load.
    els.app.style.transition = 'none';
    setOpenWidth(readSidebarWidthPreference());
    requestAnimationFrame(() => {
      els.app.style.transition = '';
    });

    let startX = 0;
    let startW = SIDEBAR_WIDTH_DEFAULT;

    function onMove(e) {
      setOpenWidth(startW + (e.clientX - startX));
    }
    function onUp() {
      els.app.classList.remove('sidebar-resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      writeSidebarWidthPreference(currentOpenWidth());
    }

    handle.addEventListener('mousedown', (e) => {
      if (!state.projectsSidebarVisible) return; // no resize while collapsed
      e.preventDefault();
      startX = e.clientX;
      startW = currentOpenWidth();
      els.app.classList.add('sidebar-resizing');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // Double-click the divider to restore the default width.
    handle.addEventListener('dblclick', () => {
      setOpenWidth(SIDEBAR_WIDTH_DEFAULT);
      writeSidebarWidthPreference(SIDEBAR_WIDTH_DEFAULT);
    });
  }

  async function undoDeleteTask() {
    if (!state.deletedTasksStack || state.deletedTasksStack.length === 0) {
      toast('No recently deleted tasks to undo');
      return;
    }
    const deletedInfo = state.deletedTasksStack.pop();
    try {
      const projectExists = state.data.projects.some((p) => p.id === deletedInfo.projectId);
      if (!projectExists) {
        toast('Cannot restore task: Project no longer exists', true);
        return;
      }
      state.selectedProjectId = deletedInfo.projectId;
      await api('POST', `/api/projects/${deletedInfo.projectId}/tasks`, {
        ...deletedInfo.task,
        insert_at_index: deletedInfo.index,
      });
      await refresh();
      toast('Restored deleted task');
    } catch (err) {
      toast(err.message, true);
      state.deletedTasksStack.push(deletedInfo);
    }
  }

  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (!els.cursorRunModal.hidden) return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      
      const active = document.activeElement;
      const tag = (active?.tagName || '').toLowerCase();
      const isTextBox = tag === 'input' || tag === 'textarea' || (active && active.isContentEditable);
      if (isTextBox) return;

      const key = e.key.toLowerCase();
      if (key === 'z') {
        e.preventDefault();
        undoDeleteTask();
        return;
      }

      // Shortcuts that act on the currently selected task row.
      if (state.selectedTaskId) {
        if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault();
          deleteSelectedTask();
          return;
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          moveSelectedTask(e.key === 'ArrowUp' ? -1 : 1);
          return;
        }
      }

      if (e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key, 10) - 1;
        const project = getActiveProjects()[idx];
        if (project) {
          e.preventDefault();
          state.selectedProjectId = project.id;
          render();
        }
      }
    });
  }

  function startWaitingTicker() {
    setInterval(() => {
      const project = state.data.projects.find((p) => p.id === state.selectedProjectId);
      if (!project) return;
      if (!project.tasks.some((t) => t.status === 'waiting')) return;
      if (state.editingTaskId || state.editingTitleTaskId) {
        updateWaitingPillLabels(project);
        renderSummary(project);
        return;
      }
      renderPane();
    }, 30000);
  }

  // --- Boot ---

  setupNewProjectForm();
  setupEditProjectForm();
  setupDeleteProject();
  setupTaskBacklogHeaderButton();
  setupToggleAllProgressButton();
  setupFocusButton();
  setupWorkspaceButton();
  setupNewTaskForm();
  setupDesktopBridge();
  setupProjectsSidebarToggle();
  setupSidebarResize();
  setupKeyboardShortcuts();
  setupCursorRunModal();
  setupTaskFocusModal();
  setupLaunchPresetModal();
  setupShellCommandEditor();
  // Live-feed UI glue (plain/live toggle, row cells, 2s delta poll). Everything it renders is
  // gated on live mode per project; with the default 'plain' it changes nothing.
  if (window.LiveFeedUI) {
    LiveFeedUI.init({
      getProject: () => state.data.projects.find((p) => p.id === state.selectedProjectId) || null,
      rerenderPane: () => renderPane(),
      isTaskProgressHidden: (taskId) => state.taskProgressHiddenIds.has(taskId),
      taskListEl: els.taskList,
      // The chip body opens the tracking picker; ⌘-click on the chip toggles hidden. Resolve the
      // task from the current project so LiveFeedUI can stay project-agnostic.
      openTracking: (taskId) => {
        const project = state.data.projects.find((p) => p.id === state.selectedProjectId) || null;
        const task = project && project.tasks.find((t) => t.id === taskId);
        if (project && task) openCursorWaitModal(project, task);
      },
      toggleHideProgress: (taskId) => toggleTaskProgressHidden(taskId),
    });
  }
  startLinkedWaitingRefresh();
  startWaitingTicker();

  refresh().catch((err) => {
    toast(`Failed to load: ${err.message}`, true);
  });
})();
