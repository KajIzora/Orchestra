'use strict';

/*
 * Terminal.app / iTerm2 window-text reader for the §3.1 pull source (macOS only).
 *
 * Neither app has a shell-integration API like VS Code, but both expose a tab's text through
 * AppleScript. Given a process's controlling tty (from the process watch), we find the matching
 * tab/session and read its current text; lib/terminal_scrape_diff.js turns successive reads into
 * new-output notes. Reading another app's window requires a one-time macOS Automation permission
 * grant (System Settings → Privacy & Security → Automation); until granted, osascript errors and
 * we degrade to nothing (never crash, never invent output).
 *
 * execFile is injected so the script generation + app-fallback logic is unit-testable without the
 * apps or an Automation grant.
 */

const { execFile } = require('child_process');
const { normTty } = require('./tty_resolver');

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

// A ps tty token → the macOS device path AppleScript reports: 'ttys009'/'s009'/'/dev/ttys009'
// → '/dev/ttys009'. (pts/* is Linux — harmless here since AppleScript is macOS-only.)
function ttyDevicePath(tty) {
  const n = normTty(tty);
  if (!n) return '';
  if (n.includes('/')) return `/dev/${n}`;
  return `/dev/tty${n}`;
}

// Drop quotes/backslashes so the device can't break out of the AppleScript string literal. The
// device is always a /dev/tty* path (validated shape), so this is belt-and-suspenders.
function escapeForAppleScript(s) {
  return String(s).replace(/["\\]/g, '');
}

function terminalAppScript(device) {
  const d = escapeForAppleScript(device);
  return [
    'tell application "Terminal"',
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
    `      if (tty of t) is "${d}" then return (contents of t)`,
    '    end repeat',
    '  end repeat',
    'end tell',
    'return ""',
  ].join('\n');
}

function iterm2Script(device) {
  const d = escapeForAppleScript(device);
  return [
    'tell application "iTerm2"',
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
    '      repeat with s in sessions of t',
    `        if (tty of s) is "${d}" then return (text of s)`,
    '      end repeat',
    '    end repeat',
    '  end repeat',
    'end tell',
    'return ""',
  ].join('\n');
}

function runOsascript(script, execFileImpl, timeoutMs) {
  return new Promise((resolve) => {
    execFileImpl(
      'osascript',
      ['-e', script],
      { timeout: timeoutMs, maxBuffer: DEFAULT_MAX_BUFFER },
      (err, stdout) => {
        // app not running / not scriptable / Automation permission not granted → degrade to null
        if (err) return resolve(null);
        resolve(String(stdout == null ? '' : stdout));
      }
    );
  });
}

/**
 * Read the current window text for `tty` from Terminal.app, then iTerm2.
 * @returns {Promise<{app: 'terminal_app'|'iterm', text: string}|null>} null if neither owns the tty
 *          / not readable.
 */
async function readTerminalText(tty, { execFileImpl = execFile, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const device = ttyDevicePath(tty);
  if (!device) return null;
  const t1 = await runOsascript(terminalAppScript(device), execFileImpl, timeoutMs);
  if (t1 && t1.trim()) return { app: 'terminal_app', text: t1 };
  const t2 = await runOsascript(iterm2Script(device), execFileImpl, timeoutMs);
  if (t2 && t2.trim()) return { app: 'iterm', text: t2 };
  return null;
}

module.exports = {
  readTerminalText,
  ttyDevicePath,
  terminalAppScript,
  iterm2Script,
  escapeForAppleScript,
};
