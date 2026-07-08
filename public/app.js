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
  const state = {
    data: { version: 1, projects: [] },
    selectedProjectId: null,
    editingTaskId: null,
    /** In-memory text while a task is open in the editor (survives full list re-renders). */
    editingTaskDraft: null,
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
  };

  const els = {
    app: document.querySelector('.app'),
    projectList: document.getElementById('project-list'),
    emptyState: document.getElementById('empty-state'),
    projectView: document.getElementById('project-view'),
    projectName: document.getElementById('project-name'),
    projectTaskSummaryDisplay: document.getElementById('project-task-summary-display'),
    toggleTaskBacklogBtn: document.getElementById('toggle-task-backlog-btn'),
    focusBtn: document.getElementById('focus-btn'),
    workspaceBtn: document.getElementById('workspace-btn'),
    editProjectBtn: document.getElementById('edit-project-btn'),
    deleteProjectBtn: document.getElementById('delete-project-btn'),
    editProjectForm: document.getElementById('edit-project-form'),
    taskList: document.getElementById('task-list'),
    newTaskForm: document.getElementById('new-task-form'),
    taskSummary: document.getElementById('task-summary'),
    projectsToggleBtn: document.getElementById('projects-toggle-btn'),
    toggleProjectWaitingBadgesBtn: document.getElementById('toggle-project-waiting-badges-btn'),
    newProjectBtn: document.getElementById('new-project-btn'),
    newProjectForm: document.getElementById('new-project-form'),
    toast: document.getElementById('toast'),
    cursorRunModal: document.getElementById('cursor-run-modal'),
    cursorRunList: document.getElementById('cursor-run-list'),
    cursorWaitManual: document.getElementById('cursor-wait-manual'),
    cursorWaitSetDone: document.getElementById('cursor-wait-set-done'),
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
  /** @type {{ projectId: string, taskId: string } | null } */
  let taskFocusContext = null;
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

  const BACKLOG_OPEN_KEY = 'orchestra.backlog-open';
  const LEGACY_BACKLOG_OPEN_KEY = 'task-app.backlog-open';
  const TASK_PROGRESS_HIDDEN_IDS_KEY = 'orchestra.task-progress-hidden-task-ids';
  const PROJECT_WAITING_BADGES_HIDDEN_KEY = 'orchestra.project-waiting-badges-hidden';
  const SHOW_TASK_BACKLOG_KEY = 'orchestra.show-task-backlog';

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

  async function refresh(options = {}) {
    state.data = await api('GET', '/api/state');
    if (!state.selectedProjectId || !state.data.projects.find((p) => p.id === state.selectedProjectId)) {
      state.selectedProjectId = getDefaultProjectId();
    }
    const skipTaskList = !!state.editingTaskId && !!options.preserveTaskList;
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
  // Alert — the coral "needs input" pill when a tracked agent stopped blocked on you.
  const ALERT_ICON_SVG =
    '<svg class="pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><line x1="12" x2="12" y1="7.5" y2="13"/><line x1="12" x2="12.01" y1="16.5" y2="16.5"/></svg>';
  // Check — the green "done" pill shown when a tracked agent has finished.
  const CHECK_ICON_SVG =
    '<svg class="pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  // Eye — the idle "monitor" pill before you've chosen auto or manual.
  const EYE_ICON_SVG =
    '<svg class="pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>';
  // Hourglass — marks a "manual" wait (you must remember to check it yourself).
  const HOURGLASS_ICON_SVG =
    '<svg class="pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/></svg>';

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
        badge.title = `${autoWatching} task${autoWatching === 1 ? '' : 's'} working on an agent`;
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
    if (options.skipTaskList) {
      renderSummary(project);
      updateWaitingPillLabels(project);
    } else {
      renderTasks(project);
      renderSummary(project);
    }
  }

  function renderSummary(project) {
    const open = project.tasks.filter((t) => t.status === 'todo').length;
    const waiting = project.tasks.filter((t) => t.status === 'waiting').length;
    const done = project.tasks.filter((t) => t.status === 'done').length;
    els.taskSummary.textContent = `${open} open · ${waiting} waiting · ${done} done`;
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
    clearTaskListElement();
    tasksToRender.forEach((task) => {
      els.taskList.appendChild(buildTaskItem(project, task));
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

  function buildTaskItem(project, task) {
    const li = document.createElement('li');
    li.className = 'task-item';
    li.dataset.id = task.id;
    if (task.status === 'done') li.classList.add('done');

    const main = document.createElement('div');
    main.className = 'task-item-main';

    const drag = document.createElement('span');
    drag.className = 'task-drag';
    drag.textContent = '⋮⋮';
    drag.title = 'Drag to reorder';

    const check = document.createElement('button');
    check.className = 'task-check';
    check.title = task.status === 'done' ? 'Mark as not done' : 'Mark as done';
    check.addEventListener('click', async () => {
      const next = task.status === 'done' ? 'todo' : 'done';
      await patchTask(project, task, { status: next });
    });

    main.append(drag, check);

    const progressHidden = state.taskProgressHiddenIds.has(task.id);
    if (progressHidden) li.classList.add('task-progress-hidden');

    const pills = document.createElement('div');
    pills.className = 'task-item-pills';

    const progressPill = document.createElement('button');
    progressPill.type = 'button';
    progressPill.className = `pill pill-toggle task-progress ${progressHidden ? '' : 'off'}`;
    progressPill.textContent = progressHidden ? 'show progress' : 'hide progress';
    progressPill.setAttribute('aria-pressed', String(progressHidden));
    progressPill.title = progressHidden
      ? 'Show waiting, working, and linked watcher on this task'
      : 'Hide waiting, working, and linked watcher on this task';
    progressPill.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.taskProgressHiddenIds.has(task.id)) state.taskProgressHiddenIds.delete(task.id);
      else state.taskProgressHiddenIds.add(task.id);
      writeTaskProgressHiddenIds(state.taskProgressHiddenIds);
      renderPane();
    });
    pills.appendChild(progressPill);

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
      pills.appendChild(focusPill);
    }

    const inBacklog = !!task.is_task_backlog;
    const backlogPill = document.createElement('button');
    backlogPill.type = 'button';
    backlogPill.className = `pill pill-toggle backlog ${inBacklog ? '' : 'off'}`;
    backlogPill.textContent = 'backlog';
    backlogPill.setAttribute('aria-pressed', String(inBacklog));
    backlogPill.title = inBacklog
      ? 'Remove from task backlog (shown in the main list when backlog is hidden)'
      : 'Send to task backlog (hidden from this list until you choose Show Backlog)';
    backlogPill.addEventListener('click', async (e) => {
      e.stopPropagation();
      await patchTask(project, task, { is_task_backlog: !inBacklog });
    });
    pills.appendChild(backlogPill);

    // Single "monitor" control. One pill with three looks:
    //  - nothing set   → neutral eye "monitor" (opens the picker)
    //  - agent watcher → blue robot "working" + source badge (auto-clears when done)
    //  - manual wait   → yellow hourglass "waiting" (you check it yourself)
    // An × next to an active pill clears it straight back to "monitor".
    const isWaiting = task.status === 'waiting';
    const tracking = getTaskWatchTracking(task);
    const hasWatcher = taskHasWatcher(task);
    const isFinished = task.status === 'todo' && !!task.watch_finished;
    if (task.status !== 'done') {
      const monitorBtn = document.createElement('button');
      monitorBtn.type = 'button';
      if (isFinished && task.watch_finished.needs_input) {
        monitorBtn.className = 'pill pill-toggle needsinput';
        setPillContent(monitorBtn, ALERT_ICON_SVG, 'needs input');
        monitorBtn.title =
          'Agent stopped and needs your input (a question or permission). Click to open working (re-link or set done); click × to dismiss to monitor.';
      } else if (isFinished) {
        monitorBtn.className = 'pill pill-toggle finished';
        setPillContent(monitorBtn, CHECK_ICON_SVG, 'done');
        monitorBtn.title =
          'Agent finished. Click to open working (re-link or set done); click × to dismiss to monitor.';
      } else if (isWaiting && hasWatcher) {
        monitorBtn.className = 'pill pill-toggle watching';
        setPillContent(monitorBtn, ROBOT_ICON_SVG, 'working');
        monitorBtn.title = 'Working on an agent — clears itself when it finishes. Click to change.';
      } else if (isWaiting) {
        monitorBtn.className = 'pill pill-toggle waiting';
        setPillContent(monitorBtn, HOURGLASS_ICON_SVG, formatWaiting(task.waiting_since));
        monitorBtn.title = 'Waiting — you check this one yourself. Click to switch to working on an agent.';
      } else {
        monitorBtn.className = 'pill pill-toggle monitor off';
        setPillContent(monitorBtn, EYE_ICON_SVG, 'monitor');
        monitorBtn.title =
          'Monitor this task — watch an agent (auto, clears itself) or just mark it waiting (manual)';
      }
      monitorBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await openCursorWaitModal(project, task);
      });
      pills.appendChild(monitorBtn);
    }

    if (task.status === 'waiting' && tracking && hasWatcher) {
      const badge = document.createElement('span');
      badge.className = 'cursor-tracking-badge';
      const err = tracking.last_error;
      badge.title = err
        ? `Watcher: ${err}`
        : 'Linked watcher. Waiting clears to Open when it finishes.';
      if (tracking.kind === 'process') {
        const pidLabel = tracking.pid ? `PID ${tracking.pid}` : 'PID ?';
        badge.textContent =
          tracking.source === 'ssh' && tracking.host
            ? `Process · ${tracking.host} · ${pidLabel}`
            : `Process · ${pidLabel}`;
      } else if (tracking.kind === 'notification') {
        badge.textContent = tracking.provider === 'claude' ? 'Claude' : 'ChatGPT';
      } else if (tracking.kind === 'browser_chat') {
        badge.textContent =
          tracking.provider === 'claude' ? 'Claude' : tracking.provider === 'gemini' ? 'Gemini' : 'ChatGPT';
      } else if (tracking.kind === 'ide_agent') {
        const providerLabel =
          tracking.provider === 'claude'
            ? 'Claude Code'
            : tracking.provider === 'claude_cowork'
              ? 'Claude Cowork'
              : tracking.provider === 'gemini'
                ? 'Gemini'
                : 'Codex';
        badge.textContent = tracking.source === 'ssh' && tracking.host ? `${providerLabel} · ${tracking.host}` : providerLabel;
      } else {
        badge.textContent = tracking.source === 'ssh' && tracking.host ? `Cursor · ${tracking.host}` : 'Cursor';
      }
      if (tracking.kind === 'cursor' && tracking.hook_completion_hint) {
        badge.textContent += ' · hint';
      }
      pills.appendChild(badge);
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
      pills.appendChild(clear);
    }

    // Text
    if (state.editingTaskId === task.id) {
      const input = document.createElement('textarea');
      input.rows = 1;
      input.spellcheck = true;
      input.value = state.editingTaskDraft != null ? state.editingTaskDraft : task.text;
      input.className = 'task-text-input';
      const finish = async (commit) => {
        state.editingTaskId = null;
        state.editingTaskDraft = null;
        const val = input.value.trim();
        if (commit && val && val !== task.text) {
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
      const text = document.createElement('span');
      text.className = 'task-text';
      text.textContent = task.text;
      text.addEventListener('click', () => {
        state.editingTaskId = task.id;
        state.editingTaskDraft = task.text;
        render();
      });
      main.appendChild(text);
    }

    // Task focus setup
    const focusEdit = document.createElement('button');
    focusEdit.className = 'task-focus-edit';
    focusEdit.type = 'button';
    focusEdit.textContent = focusCommands.length > 0 ? 'edit focus' : '+ focus';
    focusEdit.title = focusCommands.length > 0 ? 'Edit task focus targets' : 'Add task focus targets';
    focusEdit.addEventListener('click', (e) => {
      e.stopPropagation();
      openTaskFocusModal(project, task);
    });
    main.appendChild(focusEdit);

    // Delete
    const del = document.createElement('button');
    del.className = 'task-delete';
    del.textContent = '×';
    del.title = 'Delete task';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const taskIndex = project.tasks.findIndex((t) => t.id === task.id);
        await api('DELETE', `/api/projects/${project.id}/tasks/${task.id}`);
        state.deletedTasksStack.push({
          task: { ...task },
          projectId: project.id,
          index: taskIndex,
        });
        await refresh();
      } catch (err) {
        toast(err.message, true);
      }
    });
    main.appendChild(del);

    li.append(main, pills);

    return li;
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
    els.taskFocusTaskText.textContent = task.text || '';
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
      meta.textContent = row.meta || '';
      btn.append(title, meta);
      btn.addEventListener('click', () => {
        if (watchedBy) {
          const text = (watchedBy.text || '').trim() || 'Untitled Task';
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
        title: row.run_title,
        workspace_path: row.workspace_path,
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
      return {
        kind: 'ide_agent',
        provider: rowProvider,
        session_id: run.session_id,
        transcript_path: run.transcript_path,
        audit_path: run.audit_path || '',
        run_title: run.title || '',
        source: run.source || (isRemote ? 'ssh' : 'local'),
        host: run.host || null,
        projects_root: run.projects_root || null,
        state_location: run.state_location || '',
        workspace_path: run.workspace_path || '',
        last_user_preview: run.last_user_preview || '',
        log_path: run.log_path || '',
        log_request_id: run.log_request_id || '',
        log_started_at: run.log_started_at || '',
        log_done_at: run.log_done_at || '',
        label: primaryLabel,
        meta: [providerRowLabel(rowProvider), sourceScopeLabel(run.source || (isRemote ? 'ssh' : 'local'), run.host), detail]
          .filter(Boolean)
          .join(' · '),
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
      return {
        kind: 'cursor',
        source: rowSource,
        host: run.host,
        projects_root: run.projects_root,
        transcript_path: run.transcript_path,
        conversation_id: run.conversation_id,
        label: preview || id,
        meta: ['Cursor', sourceScopeLabel(rowSource, run.host), slug || 'hook'].filter(Boolean).join(' · '),
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
      return {
        kind: 'browser_chat',
        provider: snap.provider,
        conversation_id: snap.conversation_id,
        url: snap.url || '',
        displayTitle,
        last_user_preview: preview,
        tab_id: snap.tab_id,
        label: browserWatchRowLabel(preview, snap.title, snap.conversation_id, snap.url),
        meta: [providerRowLabel(snap.provider), 'Browser', metaTitle].filter(Boolean).join(' · '),
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
      source === 'provider-gemini'
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
      source === 'gemini-ide-remote'
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
    setCursorModalTab('watching');
    els.watchSearch.hidden = true;
    els.watchSearch.value = '';

    const savedKind = normalizeActiveWatchKind(project, task, readTaskActiveKindPreference(task));
    if (savedKind && WATCH_GROUPS[savedKind]) {
      await activateWatchGroup(project, task, savedKind);
    } else {
      resetWatchPickerUi();
      els.cursorRunList.innerHTML =
        '<li class="hint" style="padding:12px">Choose Cursor, ChatGPT, Claude, Gemini, or Process above.</li>';
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
          t.paused_watch_tracking
      )
    );
  }

  function startLinkedWaitingRefresh() {
    // Poll fairly often while a watch is active or paused so pill transitions
    // (tracking ↔ needs input ↔ done) feel responsive. Match the server's ~2s
    // watch poller so the UI is not the slower leg during needs-input gates.
    setInterval(() => {
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
      commandDetails.append(summary, createWorkspaceInput('command', 'Shell command', item.command || ''));
      fields.append(commandDetails);
    }

    fields.querySelectorAll('input, select').forEach((field) => {
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
        await api('POST', `/api/projects/${project.id}/tasks`, { text });
        await refresh();
      } catch (err) {
        toast(err.message, true);
        input.value = text;
      }
    });
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
      if (state.editingTaskId) {
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
  setupFocusButton();
  setupWorkspaceButton();
  setupNewTaskForm();
  setupDesktopBridge();
  setupProjectsSidebarToggle();
  setupKeyboardShortcuts();
  setupCursorRunModal();
  setupTaskFocusModal();
  setupLaunchPresetModal();
  startLinkedWaitingRefresh();
  startWaitingTicker();

  refresh().catch((err) => {
    toast(`Failed to load: ${err.message}`, true);
  });
})();
