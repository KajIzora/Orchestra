const { exec, spawn } = require('child_process');
const os = require('os');
const path = require('path');

const TIMEOUT_MS = 5000;
const INTER_COMMAND_DELAY_MS = 700;
// Cursor's LaunchServices bundle id (keep in sync with the copies in
// public/default_launch_commands.js, lib/workspace_items.js, and
// scripts/ax_focus_window.swift).
const CURSOR_BUNDLE_ID = 'com.todesktop.230313mzl4w4u92';
const EXTRA_DESKTOP_PATHS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  '/Applications/Cursor.app/Contents/Resources/app/bin',
  path.join(os.homedir(), 'Applications', 'Cursor.app', 'Contents', 'Resources', 'app', 'bin'),
];

function buildLaunchPath(currentPath = process.env.PATH || '') {
  const parts = currentPath.split(path.delimiter).filter(Boolean);
  for (const entry of EXTRA_DESKTOP_PATHS) {
    if (!parts.includes(entry)) parts.push(entry);
  }
  return parts.join(path.delimiter);
}

function buildLaunchEnvironment(env = process.env) {
  return {
    ...env,
    PATH: buildLaunchPath(env.PATH || ''),
  };
}

function getLaunchCwd() {
  return os.homedir() || '/';
}

function normalizeLaunchCommands(commandOrCommands) {
  const commands = Array.isArray(commandOrCommands) ? commandOrCommands : [commandOrCommands];
  return commands.filter((command) => typeof command === 'string').map((command) => command.trim()).filter(Boolean);
}

// The Cursor focus commands launch the folder as a fallback when no existing
// window can be raised. That fallback historically used the `cursor` node CLI,
// which takes ~1.1s just to hand off; `open -b <bundle>` does the same job
// (focus the folder's window, switch to its Space) via LaunchServices in ~0.05s.
// Rewrite LOCAL cursor launches — a bare `cursor '<path>'` (including the one at
// the tail of the raise-or-open command) and legacy `open -a Cursor <path>` — to
// `open -b`. `cursor --remote ssh-remote+...` is left alone (open can't express a
// remote workspace: the next token after `cursor ` is `--`, not a quoted path).
function rewriteCursorOpenCommand(command) {
  return String(command || '')
    .trim()
    .replace(/\bopen -a (?:'Cursor'|"Cursor"|Cursor) /g, `open -b ${CURSOR_BUNDLE_ID} `)
    .replace(/(^|[\s|;&])cursor (['"])/g, `$1open -b ${CURSOR_BUNDLE_ID} $2`);
}

function normalizeTaskFocusCommandsForRun(commandOrCommands) {
  return normalizeLaunchCommands(commandOrCommands).map(rewriteCursorOpenCommand);
}

function parseSimpleCommandLine(command) {
  const input = String(command || '').trim();
  if (!input) return null;
  const tokens = [];
  let token = '';
  let quote = null;
  let hasToken = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (!quote && /[;&|<>(){}\n\r]/.test(ch)) return null;
    if (quote !== "'" && /[$`\n\r]/.test(ch)) return null;

    if (ch === '\\' && quote !== "'") {
      i += 1;
      if (i >= input.length) return null;
      token += input[i];
      hasToken = true;
      continue;
    }

    if ((ch === "'" || ch === '"') && (!quote || quote === ch)) {
      if (quote === ch) quote = null;
      else quote = ch;
      hasToken = true;
      continue;
    }

    if (!quote && /\s/.test(ch)) {
      if (hasToken) {
        tokens.push(token);
        token = '';
        hasToken = false;
      }
      continue;
    }

    token += ch;
    hasToken = true;
  }

  if (quote) return null;
  if (hasToken) tokens.push(token);
  return tokens.length ? tokens : null;
}

function getDirectLaunchSpec(command) {
  const tokens = parseSimpleCommandLine(command);
  if (!tokens || tokens.length === 0) return null;
  const executable = tokens[0];
  if (executable !== 'open' && executable !== 'cursor') return null;
  return { executable, args: tokens.slice(1) };
}

function normalizeTimeoutMs(value) {
  if (value == null) return TIMEOUT_MS;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return TIMEOUT_MS;
  return ms;
}

function spawnLaunchCommand(command, spec, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    let output = '';
    let error = '';
    let done = false;
    const child = spawn(spec.executable, spec.args, {
      env: buildLaunchEnvironment(),
      cwd: getLaunchCwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ ok: false, command, error: `Command timed out after ${timeoutMs}ms`, output });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      error += chunk.toString();
    });
    child.on('error', (err) => {
      finish({ ok: false, command, error: err.message, output });
    });
    child.on('close', (code, signal) => {
      if (code === 0) {
        finish({ ok: true, command, output, error });
        return;
      }
      const detail = error || (signal ? `Command exited with signal ${signal}` : `Command exited with code ${code}`);
      finish({ ok: false, command, error: detail, output });
    });
  });
}

function execLaunchCommand(command, opts = {}) {
  const timeoutMs = normalizeTimeoutMs(opts.timeoutMs);
  const directSpec = getDirectLaunchSpec(command);
  if (directSpec) return spawnLaunchCommand(command, directSpec, timeoutMs);

  return new Promise((resolve) => {
    exec(
      command,
      {
        timeout: timeoutMs,
        shell: '/bin/bash',
        maxBuffer: 1024 * 1024,
        env: buildLaunchEnvironment(),
        cwd: getLaunchCwd(),
      },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            command,
            error: err.killed ? `Command timed out after ${timeoutMs}ms` : (stderr || err.message),
            output: stdout || '',
          });
          return;
        }
        resolve({ ok: true, command, output: stdout || '', error: stderr || '' });
      }
    );
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeInterCommandDelayMs(value) {
  if (value == null) return INTER_COMMAND_DELAY_MS;
  const delayMs = Number(value);
  if (!Number.isFinite(delayMs)) return INTER_COMMAND_DELAY_MS;
  return Math.max(0, delayMs);
}

function summarizeLaunchResults(results) {
  const output = results.map((result) => result.output).filter(Boolean).join('\n');
  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) {
    return {
      ok: false,
      output,
      error: failures.map((result) => `${result.command}: ${result.error}`).join('\n'),
    };
  }

  return {
    ok: true,
    output,
    error: results.map((result) => result.error).filter(Boolean).join('\n'),
  };
}

async function runLaunchCommand(commandOrCommands, opts = {}) {
  const commands = normalizeLaunchCommands(commandOrCommands);
  if (commands.length === 0) {
    return { ok: false, error: 'No launch command set' };
  }

  const interCommandDelayMs = normalizeInterCommandDelayMs(opts.interCommandDelayMs);
  const results = [];
  for (let i = 0; i < commands.length; i += 1) {
    if (i > 0 && interCommandDelayMs > 0) {
      await delay(interCommandDelayMs);
    }
    results.push(await execLaunchCommand(commands[i]));
  }

  return summarizeLaunchResults(results);
}

async function runLaunchCommandsParallel(commandOrCommands) {
  const commands = normalizeLaunchCommands(commandOrCommands);
  if (commands.length === 0) {
    return { ok: false, error: 'No launch command set' };
  }

  return summarizeLaunchResults(await Promise.all(commands.map((command) => execLaunchCommand(command))));
}

// Delay (ms) we wait for a Mission Control desktop switch to finish animating
// before raising windows on the destination desktop.
const FOCUS_SWITCH_SETTLE_MS = 500;

// Recognizes the Mission Control desktop-switch command produced by the
// "Open Window" / Desktop launch preset, e.g.
//   osascript -e 'tell application "System Events" to key code 19 using control down'
function isDesktopSwitchCommand(command) {
  const text = String(command || '');
  return /System Events/.test(text) && /key code\s+\d+\s+using\s+control down/.test(text);
}

// Runs a focus action's commands. Normally everything fires at once (fast). But
// when the first command is a desktop switch, we run it ALONE, wait for the
// desktop transition to settle, and only then fire the rest together. This stops
// a single-window raise from landing mid-transition, where macOS would reassert
// the destination desktop's saved stacking order and clobber it.
//
// Trade-off ("naive" approach): the settle wait is paid every time the first
// command is a desktop switch — including when you are already on that desktop
// (the switch is then a harmless no-op, but you still wait).
async function runFocusCommands(commandOrCommands, opts = {}) {
  const commands = normalizeLaunchCommands(commandOrCommands);
  if (commands.length === 0) {
    return { ok: false, error: 'No launch command set' };
  }

  const execOpts = { timeoutMs: opts.timeoutMs };

  if (commands.length > 1 && isDesktopSwitchCommand(commands[0])) {
    const settleMs = normalizeInterCommandDelayMs(
      opts.switchSettleMs == null ? FOCUS_SWITCH_SETTLE_MS : opts.switchSettleMs
    );
    const first = await execLaunchCommand(commands[0], execOpts);
    if (settleMs > 0) await delay(settleMs);
    const rest = await Promise.all(commands.slice(1).map((command) => execLaunchCommand(command, execOpts)));
    return summarizeLaunchResults([first, ...rest]);
  }

  return summarizeLaunchResults(await Promise.all(commands.map((command) => execLaunchCommand(command, execOpts))));
}

module.exports = {
  runLaunchCommand,
  runLaunchCommandsParallel,
  runFocusCommands,
  isDesktopSwitchCommand,
  FOCUS_SWITCH_SETTLE_MS,
  normalizeLaunchCommands,
  normalizeTaskFocusCommandsForRun,
  rewriteCursorOpenCommand,
  getDirectLaunchSpec,
  parseSimpleCommandLine,
  buildLaunchPath,
  buildLaunchEnvironment,
  getLaunchCwd,
  INTER_COMMAND_DELAY_MS,
};
