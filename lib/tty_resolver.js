'use strict';

/*
 * Resolve a process id to its controlling terminal device (tty), and normalize tty strings for
 * comparison. Used by the terminal tail adapter (§3.1) to connect a PICKER-linked process watch
 * to the Cursor extension's output: the extension reports the terminal's SHELL pid, while the
 * picker links a CHILD process — different pids, but they share one controlling tty. Resolving the
 * shell pid to that tty lets the adapter match by terminal device instead of by exact pid.
 *
 * Local only (macOS/Linux `ps`). execFile is injectable for tests.
 */

const { execFile } = require('child_process');

/**
 * Normalize a tty token so equivalent forms compare equal:
 *   '/dev/ttys009' → 's009', 'ttys009' → 's009', 's009' → 's009', 'pts/3' → 'pts/3'
 * A process with no controlling terminal ('?' / '??' / '') normalizes to '' (never matches).
 */
function normTty(s) {
  if (typeof s !== 'string') return '';
  let t = s.trim();
  if (!t || t === '?' || t === '??') return '';
  t = t.replace(/^\/dev\//, '');
  t = t.replace(/^tty/, '');
  return t;
}

/**
 * Resolve `pid`'s controlling tty via `ps -o tty=`. Resolves to the raw tty token (same format the
 * process picker records, e.g. 'ttys009') or null when the process has no tty / the lookup fails.
 * Never rejects.
 */
function resolveTtyForPid(pid, { execFileImpl = execFile, timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    const n = Number.parseInt(pid, 10);
    if (!Number.isInteger(n) || n <= 0) return resolve(null);
    execFileImpl('ps', ['-o', 'tty=', '-p', String(n)], { timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve(null);
      const raw = String(stdout || '').trim().split(/\s+/)[0] || '';
      resolve(normTty(raw) ? raw : null);
    });
  });
}

module.exports = { normTty, resolveTtyForPid };
