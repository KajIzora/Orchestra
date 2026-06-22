/**
 * Pure helpers for menu bar tray labels (shared with tests).
 * @param {object} project
 * @param {Array<{ text?: string, status?: string, created_at?: string, cursor_tracking?: object|null }>} project.tasks
 */

function parseCreatedMs(task) {
  if (!task || !task.created_at) return 0;
  const t = new Date(task.created_at).getTime();
  return Number.isFinite(t) ? t : 0;
}

function byCreatedAtDesc(a, b) {
  return parseCreatedMs(b) - parseCreatedMs(a);
}

function isBacklogTask(task) {
  return !!task?.is_task_backlog;
}

/**
 * Newest non-done task by created_at; if all done, newest task overall.
 * @param {{ tasks?: object[] }} project
 * @returns {object|null}
 */
function selectLatestTask(project) {
  const tasks = (Array.isArray(project?.tasks) ? project.tasks : []).filter((t) => !isBacklogTask(t));
  if (tasks.length === 0) return null;
  const current = [...tasks].sort(byCreatedAtDesc).find((t) => t && t.status !== 'done');
  if (current) return current;
  return [...tasks].sort(byCreatedAtDesc)[0] || null;
}

/**
 * Plain waiting: waiting status without Cursor transcript link.
 * @param {{ status?: string, cursor_tracking?: object|null }} task
 */
function isPlainWaiting(task) {
  if (!task || task.status !== 'waiting') return false;
  return !task.watch_tracking && !task.cursor_tracking;
}

/**
 * Watching: waiting status with a Cursor transcript link.
 * @param {{ status?: string, cursor_tracking?: object|null }} task
 */
function isWatching(task) {
  if (!task || task.status !== 'waiting') return false;
  return !!task.watch_tracking || !!task.cursor_tracking;
}

function getTaskTrayStatus(task) {
  if (!task) return 'none';
  if (task.status === 'todo' && task.watch_finished?.needs_input) return 'needs_input';
  if (task.status === 'todo' && task.watch_finished) return 'done';
  if (isWatching(task)) return 'watching';
  if (isPlainWaiting(task)) return 'waiting';
  if (task.status === 'done') return 'done';
  return 'todo';
}

function getTaskTrayStatusDot(status) {
  switch (status) {
    case 'needs_input':
      return '●';
    case 'watching':
      return '●';
    case 'waiting':
      return '●';
    case 'done':
      return '●';
    default:
      return '';
  }
}

function getTaskTrayStatusColor(status) {
  switch (status) {
    case 'needs_input':
      return '#e06a5a';
    case 'watching':
      return '#4a7dc9';
    case 'waiting':
      return '#d79a2a';
    case 'done':
      return '#2d9d78';
    default:
      return '';
  }
}

function withStatusDot(label, status, opts = {}) {
  if (!opts.statusDots) return label;
  const dot = getTaskTrayStatusDot(status);
  return dot ? `${dot} ${label}` : label;
}

function isBacklogProject(project) {
  return !!project?.is_backlog;
}

function getVisibleTasks(project) {
  return (Array.isArray(project?.tasks) ? project.tasks : []).filter((t) => !isBacklogTask(t));
}

function getOpenVisibleTasks(project) {
  return getVisibleTasks(project).filter((t) => t && t.status !== 'done');
}

function getMenuBarProjects(projects) {
  if (!Array.isArray(projects)) return [];
  return projects.filter((project) => !isBacklogProject(project));
}

function truncate(s, maxLen) {
  const str = String(s || '');
  if (str.length <= maxLen) return str;
  if (maxLen <= 1) return '…';
  return `${str.slice(0, maxLen - 1)}…`;
}

/**
 * @param {{ name?: string, tasks?: object[] }} project
 * @param {{ maxTaskLen?: number }} [opts]
 */
function formatProjectTrayLabel(project, opts = {}) {
  const maxTaskLen = opts.maxTaskLen ?? 70;
  const name = (project && project.name) || 'Untitled';
  const task = selectLatestTask(project);
  if (!task) return `${name} - (no tasks)`;
  const status = getTaskTrayStatus(task);
  const taskPart = truncate(task.text, maxTaskLen);
  return withStatusDot(`${name} - ${taskPart}`, status, opts);
}

function formatTaskTrayLabel(project, task, opts = {}) {
  const maxTaskLen = opts.maxTaskLen ?? 70;
  const name = (project && project.name) || 'Untitled';
  const status = getTaskTrayStatus(task);
  const taskPart = truncate(task?.text, maxTaskLen);
  return withStatusDot(`${name} - ${taskPart}`, status, opts);
}

/**
 * One item per open task. If none are open, falls back to latest task or no tasks.
 * @param {{ name?: string, tasks?: object[] }} project
 * @param {{ maxTaskLen?: number }} [opts]
 * @returns {Array<{ label: string, status: string, task: object|null }>}
 */
function getProjectTrayItems(project, opts = {}) {
  const openTasks = getOpenVisibleTasks(project);
  if (openTasks.length === 0) {
    const task = selectLatestTask(project);
    return [{ label: formatProjectTrayLabel(project, opts), status: getTaskTrayStatus(task), task }];
  }
  return openTasks.map((task) => ({
    label: formatTaskTrayLabel(project, task, opts),
    status: getTaskTrayStatus(task),
    task,
  }));
}

/**
 * One label per open (non-done) task. If none are open, falls back to latest task or no tasks.
 * @param {{ name?: string, tasks?: object[] }} project
 * @param {{ maxTaskLen?: number }} [opts]
 * @returns {string[]}
 */
function formatProjectTrayLabels(project, opts = {}) {
  return getProjectTrayItems(project, opts).map((item) => item.label);
}

module.exports = {
  selectLatestTask,
  isPlainWaiting,
  isWatching,
  getTaskTrayStatus,
  getTaskTrayStatusDot,
  getTaskTrayStatusColor,
  isBacklogProject,
  getVisibleTasks,
  getOpenVisibleTasks,
  getMenuBarProjects,
  getProjectTrayItems,
  formatProjectTrayLabel,
  formatProjectTrayLabels,
  parseCreatedMs,
};
