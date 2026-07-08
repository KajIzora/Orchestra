const fs = require('fs');
const path = require('path');

const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_POLL_INTERVAL_MS = 400;

function trimPath(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pausedTranscriptPath(watchTracking) {
  if (!watchTracking || watchTracking.source === 'ssh') return '';
  if (watchTracking.kind === 'cursor') return trimPath(watchTracking.transcript_path);
  if (watchTracking.kind === 'ide_agent') {
    if (watchTracking.provider === 'claude_cowork') {
      return trimPath(watchTracking.audit_path) || trimPath(watchTracking.transcript_path);
    }
    return trimPath(watchTracking.transcript_path);
  }
  return '';
}

function isPausedNeedsInputTask(task) {
  return !!(task?.status === 'todo' && task.watch_finished?.needs_input && task.paused_watch_tracking);
}

function collectPausedTranscriptPaths(state) {
  const paths = new Set();
  for (const project of state?.projects || []) {
    for (const task of project.tasks || []) {
      if (!isPausedNeedsInputTask(task)) continue;
      const p = pausedTranscriptPath(task.paused_watch_tracking);
      if (p) paths.add(path.resolve(p));
    }
  }
  return paths;
}

/**
 * Poll local agent transcript mtimes while a task is paused on needs-input so the
 * watch poller can resume as soon as the JSONL grows (permission answer / question).
 * Uses fs.watchFile (not fs.watch) so appends are detected reliably on macOS.
 */
function createPausedTranscriptWatcher(options = {}) {
  const debounceMs =
    Number.isFinite(options.debounceMs) && options.debounceMs >= 0
      ? options.debounceMs
      : DEFAULT_DEBOUNCE_MS;
  const pollIntervalMs =
    Number.isFinite(options.pollIntervalMs) && options.pollIntervalMs > 0
      ? options.pollIntervalMs
      : DEFAULT_POLL_INTERVAL_MS;
  const onActivity = typeof options.onActivity === 'function' ? options.onActivity : () => {};
  const watchers = new Map();
  const debounceTimers = new Map();

  function scheduleActivity(filePath) {
    const key = filePath;
    if (debounceTimers.has(key)) clearTimeout(debounceTimers.get(key));
    debounceTimers.set(
      key,
      setTimeout(() => {
        debounceTimers.delete(key);
        try {
          onActivity(filePath);
        } catch (err) {
          console.error('[paused_transcript_watch] onActivity failed:', err);
        }
      }, debounceMs)
    );
  }

  function unwatch(filePath) {
    const key = path.resolve(filePath);
    if (debounceTimers.has(key)) {
      clearTimeout(debounceTimers.get(key));
      debounceTimers.delete(key);
    }
    if (!watchers.has(key)) return;
    try {
      fs.unwatchFile(key);
    } catch {
      // ignore
    }
    watchers.delete(key);
  }

  function watch(filePath) {
    const key = path.resolve(filePath);
    if (watchers.has(key)) return;
    try {
      fs.statSync(key);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[paused_transcript_watch] stat failed for ${key}:`, err.message || err);
      }
      return;
    }
    const statWatcher = fs.watchFile(key, { interval: pollIntervalMs }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) scheduleActivity(key);
    });
    // Don't let the StatWatcher keep the process alive on its own. Production's event loop is
    // held by the HTTP server, so this changes nothing live — but if a test (or crash path)
    // skips close()/unwatch, the leaked watcher no longer prevents the process from exiting.
    if (statWatcher && typeof statWatcher.unref === 'function') statWatcher.unref();
    watchers.set(key, { pollIntervalMs });
  }

  function sync(state) {
    const wanted = collectPausedTranscriptPaths(state);
    for (const filePath of wanted) {
      watch(filePath);
    }
    for (const filePath of watchers.keys()) {
      if (!wanted.has(filePath)) unwatch(filePath);
    }
  }

  function close() {
    for (const filePath of [...watchers.keys()]) unwatch(filePath);
  }

  return { sync, close, collectPausedTranscriptPaths, pausedTranscriptPath, isPausedNeedsInputTask };
}

module.exports = {
  createPausedTranscriptWatcher,
  collectPausedTranscriptPaths,
  pausedTranscriptPath,
  isPausedNeedsInputTask,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_POLL_INTERVAL_MS,
};
