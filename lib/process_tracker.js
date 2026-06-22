const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { assertValidRemoteSource, createSshRunner } = require('./remote_cursor_tracker');

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_CWD_RESOLVE = 300;
const LSOF_PID_CHUNK = 80;
const DOCKER_LOG_TAIL_LINES = 300;
/** Primary readiness line; exported as ISAAC_READY_PATTERN for backward compatibility. */
const ISAAC_READY_PATTERNS = Object.freeze([
  'Isaac Sim Full App is loaded.',
  'Simulation App Starting',
  'app ready',
]);
const ISAAC_READY_PATTERN = ISAAC_READY_PATTERNS[0];
const ISAAC_DEFAULT_CONTAINER = 'isaac-stream';
const ISAAC_WATCH_LABEL = 'Watch Isaac Sim launch';

const MAX_LOG_CONTAINS_PATTERNS = 12;
const MAX_LOG_CONTAIN_PATTERN_LEN = 256;

/**
 * @param {object|null|undefined} completion
 * @returns {string[]}
 */
function normalizeLogContainsPatterns(completion) {
  if (!completion || typeof completion !== 'object') {
    return [...ISAAC_READY_PATTERNS];
  }
  if (Array.isArray(completion.patterns)) {
    const out = [];
    for (const p of completion.patterns) {
      const s = String(p || '').trim();
      if (s.length > 0 && s.length <= MAX_LOG_CONTAIN_PATTERN_LEN) out.push(s);
      if (out.length >= MAX_LOG_CONTAINS_PATTERNS) break;
    }
    if (out.length) return out;
  }
  const single = String(completion.pattern || '').trim();
  if (single.length > 0 && single.length <= MAX_LOG_CONTAIN_PATTERN_LEN) return [single];
  return [...ISAAC_READY_PATTERNS];
}

/**
 * @param {string} logs
 * @param {string[]} patterns
 */
function dockerLogsMatchAnyPattern(logs, patterns) {
  const hay = String(logs || '').toLowerCase();
  return patterns.some((p) => hay.includes(String(p).toLowerCase()));
}

const NOISE_PREFIXES = [
  'zsh',
  'bash',
  'sh',
  'login',
  'tmux',
  'screen',
  'ps ',
  'grep ',
  'node server.js',
  'node /',
];

/** Extra hide rules for project-scoped process pickers (not legacy `/api/processes/local`). */
const AGGRESSIVE_CMD_PREFIXES = [
  '-zsh',
  '-bash',
  '-sh',
  '/usr/libexec/',
  '/system/library/',
  '/library/apple/',
  '/private/var/db/',
  '/usr/sbin/distnoted',
  '/usr/sbin/cfprefsd',
  '/usr/sbin/systemstats',
  'login -',
  '/usr/bin/login',
  '/bin/login',
];

const SHELL_BASENAMES = new Set(['bash', 'zsh', 'sh', 'dash', 'fish', 'ksh', 'csh', 'tcsh']);

/** Hide idle `conda run` / `mamba run` wrappers while the real `python …` child does the work. */
const CONDA_RUN_WRAPPER_MAX_PCPU = 5;

/**
 * First argv token (ps "command" column is lossy; good enough for shells).
 * @param {string} command
 */
function argv0Token(command) {
  const t = String(command || '').trim();
  if (!t) return '';
  const sp = t.indexOf(' ');
  return sp === -1 ? t : t.slice(0, sp);
}

/**
 * Everything after argv0.
 * @param {string} command
 */
function argvRest(command) {
  const t = String(command || '').trim();
  const sp = t.indexOf(' ');
  return sp === -1 ? '' : t.slice(sp + 1).trim();
}

/**
 * Basename of argv0, treating leading `-` on login shells (e.g. `-zsh`) as part of the name.
 * @param {string} command
 */
function argv0ShellBasename(command) {
  const tok = argv0Token(command);
  if (!tok) return '';
  const base = tok.includes('/') ? tok.slice(tok.lastIndexOf('/') + 1) : tok;
  return base.replace(/^-+/, '').toLowerCase() || base.toLowerCase();
}

/**
 * Strip shell-only interactive / init-file noise from argv tail; return trimmed remainder.
 * @param {string} rest
 */
function stripShellOrnamentArgs(rest) {
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
 * True when argv0 is a shell and remaining args are only login/interactive/init noise (no -c, no script path).
 * @param {string} command
 */
function isShellOnlyOrnamentProcess(command) {
  const base = argv0ShellBasename(command);
  if (!SHELL_BASENAMES.has(base)) return false;
  const rest0 = argvRest(command);
  if (!rest0) return true;
  const stripped = stripShellOrnamentArgs(rest0);
  if (!stripped) return true;
  if (/^-c(\s|$)/i.test(stripped)) return false;
  return false;
}

/**
 * conda/mamba/micromamba `run` parent often sits near 0% CPU while the child runs training.
 * @param {object} proc
 */
function isCondaRunIdleWrapper(proc) {
  const lower = String(proc.command || '').toLowerCase();
  if (!/\bconda\s+run\b/.test(lower) && !/\bmamba\s+run\b/.test(lower) && !/\bmicromamba\s+run\b/.test(lower)) {
    return false;
  }
  const pcpu = Number.isFinite(proc.pcpu) ? proc.pcpu : Number.parseFloat(proc.pcpu || 0) || 0;
  return pcpu < CONDA_RUN_WRAPPER_MAX_PCPU;
}

/**
 * Ephemeral scratch dirs (conda/python helpers) that are not the workload to watch.
 * @param {object} proc
 */
function isEphemeralTmpScratchProcess(proc) {
  const cmd = String(proc.command || '').trim();
  if (!cmd) return false;
  if (/^\/tmp\/tmp[a-z0-9]{5,}\s*$/i.test(cmd)) return true;
  if (/^\/(?:bin|usr\/bin)\/(?:ba)?sh\s+\/tmp\/tmp[a-z0-9]{5,}\s*$/i.test(cmd)) return true;
  return false;
}

/**
 * Python multiprocessing worker processes.
 * @param {object} proc
 */
function isPythonMultiprocessingWorker(proc) {
  const cmd = String(proc.command || '');
  return (
    cmd.includes('--multiprocessing-fork') ||
    cmd.includes('multiprocessing.spawn') ||
    cmd.includes('multiprocessing.forkserver') ||
    cmd.includes('multiprocessing.semaphore_tracker') ||
    cmd.includes('multiprocessing.resource_tracker')
  );
}

/**
 * Antigravity CLI/agent process (agy, antigravity, antigravity-cli).
 * @param {string} command
 */
function isAgyProcess(command) {
  const tok = argv0Token(command).toLowerCase();
  if (!tok) return false;
  const base = tok.includes('/') ? tok.slice(tok.lastIndexOf('/') + 1) : tok;
  return base === 'agy' || base === 'antigravity' || base === 'antigravity-cli';
}

/**
 * @param {object} proc
 * @returns {boolean}
 */
function looksLikeAggressiveNoise(proc) {
  if (!proc || !proc.command) return true;
  const cmd = proc.command;
  const lower = cmd.toLowerCase();
  for (const p of AGGRESSIVE_CMD_PREFIXES) {
    if (lower.startsWith(p)) return true;
  }
  if (/\bssh-agent\b/.test(lower)) return true;
  if (/\bgpg-agent\b/.test(lower) && lower.includes('--daemon')) return true;
  if (isShellOnlyOrnamentProcess(cmd)) return true;
  if (isCondaRunIdleWrapper(proc)) return true;
  if (isEphemeralTmpScratchProcess(proc)) return true;
  if (isPythonMultiprocessingWorker(proc)) return true;
  if (isAgyProcess(cmd)) return true;
  if (lower.includes('chrome-devtools')) return true;
  return false;
}

function parsePsLine(line) {
  const m = String(line)
    .trim()
    .match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\d.]+)\s+(.*)$/);
  if (!m) return null;
  const pid = Number.parseInt(m[1], 10);
  const ppid = Number.parseInt(m[2], 10);
  const pgid = Number.parseInt(m[3], 10);
  const tty = m[4];
  const etime = m[5];
  const pcpu = Number.parseFloat(m[6]);
  const command = (m[7] || '').trim();
  if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid) || !command) {
    return null;
  }
  return {
    pid,
    ppid,
    pgid,
    tty,
    etime,
    pcpu: Number.isFinite(pcpu) ? pcpu : 0,
    command,
    cwd: '',
  };
}

function looksLikeNoise(proc, selfPid = null, aggressiveClean = false) {
  if (!proc || !proc.command) return true;
  if (selfPid && proc.pid === selfPid) return true;
  const cmd = proc.command.toLowerCase();
  if (proc.tty === '?' || proc.tty === '??') return true;
  if (aggressiveClean && looksLikeAggressiveNoise(proc)) return true;
  return NOISE_PREFIXES.some((prefix) => cmd.startsWith(prefix));
}

function matchesQuery(proc, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const haystack = [proc.command, proc.tty, String(proc.pid), String(proc.ppid), String(proc.pgid), proc.cwd || '']
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

function parsePsOutput(output) {
  return String(output || '')
    .split('\n')
    .map((line) => parsePsLine(line))
    .filter(Boolean);
}

function sortLikelyFirst(items) {
  return [...items].sort((a, b) => {
    if (b.pcpu !== a.pcpu) return b.pcpu - a.pcpu;
    return b.pid - a.pid;
  });
}

function parseDockerContainerName(command) {
  const text = String(command || '');
  const m = text.match(/(?:^|\s)--name\s+([A-Za-z0-9][A-Za-z0-9_.-]{0,127})(?=\s|$)/);
  return m ? m[1] : null;
}

function detectIsaacWatchPreset(command) {
  const text = String(command || '');
  const lower = text.toLowerCase();
  const hasIsaacMarker =
    lower.includes('nvcr.io/nvidia/isaac-sim') ||
    lower.includes('isaac-sim-launch.sh') ||
    lower.includes('wppdemo_enabled=1') ||
    lower.includes('--name isaac-stream');
  if (!hasIsaacMarker) return null;
  return {
    watch_preset: 'isaac-sim-launch',
    watch_label: ISAAC_WATCH_LABEL,
    completion: {
      mode: 'log_contains',
      patterns: [...ISAAC_READY_PATTERNS],
      docker_container: parseDockerContainerName(text) || ISAAC_DEFAULT_CONTAINER,
    },
  };
}

function attachWatchPreset(proc) {
  const preset = detectIsaacWatchPreset(proc.command);
  if (!preset) return proc;
  return { ...proc, ...preset };
}

function assertValidDockerContainerName(containerName) {
  const value = String(containerName || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw new Error('Invalid docker container name');
  }
  return value;
}

/**
 * PyTorch DataLoader and similar tools fork workers with the same argv as the parent.
 * Drop child rows when another process in the same host+command+pgid group is their parent.
 * @param {object[]} procs
 * @returns {object[]}
 */
function collapseDuplicateCommandWorkers(procs) {
  if (!Array.isArray(procs) || procs.length <= 1) return procs || [];
  const groups = new Map();
  for (const proc of procs) {
    const host = String(proc.host || '');
    const command = String(proc.command || '');
    const pgid = Number.isInteger(proc.pgid) ? proc.pgid : '';
    const key = `${host}\0${command}\0${pgid}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(proc);
  }
  const kept = [];
  for (const group of groups.values()) {
    if (group.length <= 1) {
      kept.push(...group);
      continue;
    }
    const pids = new Set(group.map((p) => p.pid));
    for (const proc of group) {
      if (pids.has(proc.ppid) && proc.ppid !== proc.pid) continue;
      kept.push(proc);
    }
  }
  return kept;
}

function filterProcesses(items, options = {}) {
  const includeAll = !!options.includeAll;
  const selfPid = Number.isInteger(options.selfPid) ? options.selfPid : null;
  const aggressiveClean = !!options.aggressiveClean;
  const query = options.query || '';
  const all = items.filter((proc) => matchesQuery(proc, query));
  let likely = all.filter((proc) => !looksLikeNoise(proc, selfPid, aggressiveClean));
  if (aggressiveClean && !includeAll) {
    likely = collapseDuplicateCommandWorkers(likely);
  }
  return {
    likely: sortLikelyFirst(likely),
    all: sortLikelyFirst(all),
    items: sortLikelyFirst(includeAll ? all : likely),
  };
}

function runExecFile(file, args, timeoutMs = DEFAULT_TIMEOUT_MS, execFileImpl = execFile) {
  return new Promise((resolve, reject) => {
    execFileImpl(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || err.message || `${file} failed`).trim()));
        return;
      }
      resolve(stdout || '');
    });
  });
}

/**
 * Parse `lsof -Fn` output for cwd-only queries: lines `p<pid>` then `n<path>`.
 * @param {string} text
 * @returns {Map<number, string>}
 */
function parseLsofFnCwdOutput(text) {
  const map = new Map();
  let currentPid = null;
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    if (line.startsWith('p')) {
      currentPid = Number.parseInt(line.slice(1), 10);
      if (!Number.isInteger(currentPid)) currentPid = null;
      continue;
    }
    if (line.startsWith('n') && currentPid !== null) {
      map.set(currentPid, line.slice(1));
      currentPid = null;
    }
  }
  return map;
}

function normalizeWorkspaceRootStrings(rawRoots) {
  if (!Array.isArray(rawRoots)) return [];
  const out = [];
  for (const r of rawRoots) {
    const s = String(r || '').trim();
    if (s) out.push(s);
  }
  return out;
}

/**
 * Resolve local filesystem workspace roots with realpath where possible.
 * @param {string[]} roots
 * @returns {string[]}
 */
function resolveLocalWorkspaceRootsRealpath(roots) {
  const out = [];
  for (const s of normalizeWorkspaceRootStrings(roots)) {
    try {
      out.push(fs.realpathSync(s));
    } catch {
      try {
        out.push(path.resolve(s));
      } catch {
        // skip
      }
    }
  }
  return [...new Set(out)];
}

/**
 * Normalize remote (POSIX) workspace roots for prefix matching; do not touch local FS.
 * @param {string[]} roots
 * @returns {string[]}
 */
function normalizeRemoteWorkspaceRootsPosix(roots) {
  const out = [];
  for (const s of normalizeWorkspaceRootStrings(roots)) {
    const n = path.posix.normalize(s.replace(/\/+$/, '') || '/');
    if (n) out.push(n);
  }
  return [...new Set(out)];
}

/**
 * @param {string} root
 * @param {string} cwd
 * @returns {boolean}
 */
function isLocalCwdUnderRoot(root, cwd) {
  let rr;
  let cc;
  try {
    rr = fs.realpathSync(root);
  } catch {
    rr = path.resolve(root);
  }
  try {
    cc = fs.realpathSync(cwd);
  } catch {
    cc = path.resolve(cwd);
  }
  if (cc === rr) return true;
  const rel = path.relative(rr, cc);
  return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
}

/**
 * @param {string[]} resolvedLocalRoots from resolveLocalWorkspaceRootsRealpath
 * @param {string} cwd
 * @returns {boolean}
 */
function isCwdUnderAnyLocalRoot(resolvedLocalRoots, cwd) {
  if (!cwd || !resolvedLocalRoots.length) return false;
  return resolvedLocalRoots.some((root) => isLocalCwdUnderRoot(root, cwd));
}

/**
 * @param {string[]} posixRoots normalized remote paths
 * @param {string} cwd posix cwd from remote host
 */
function isPosixCwdUnderRoot(root, cwd) {
  const r = path.posix.normalize(String(root || '').trim() || '/');
  const c = path.posix.normalize(String(cwd || '').trim() || '');
  if (!c || !c.startsWith('/')) return false;
  if (r === '/') return true;
  const rTrim = r.replace(/\/+$/, '') || '/';
  if (c === rTrim) return true;
  return c.startsWith(`${rTrim}/`);
}

function isCwdUnderAnyPosixRoot(posixRoots, cwd) {
  if (!cwd || !posixRoots.length) return false;
  const c = path.posix.normalize(String(cwd).trim());
  return posixRoots.some((root) => isPosixCwdUnderRoot(root, c));
}

/**
 * lsof exits non-zero when any -p pid is missing, but still prints cwd for live pids.
 * Keep stdout on partial failure so workspace filtering does not drop every process.
 */
async function runLsofCwdQuery(pids, timeoutMs, execFileImpl) {
  const list = pids.join(',');
  return new Promise((resolve) => {
    execFileImpl(
      'lsof',
      ['-a', '-d', 'cwd', '-p', list, '-Fn'],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (_err, stdout) => {
        resolve(stdout || '');
      }
    );
  });
}

async function resolveCwdsLsofChunks(pids, timeoutMs, execFileImpl) {
  const map = new Map();
  for (let i = 0; i < pids.length; i += LSOF_PID_CHUNK) {
    const chunk = pids.slice(i, i + LSOF_PID_CHUNK);
    const stdout = await runLsofCwdQuery(chunk, timeoutMs, execFileImpl);
    const part = parseLsofFnCwdOutput(stdout);
    for (const [k, v] of part) map.set(k, v);
  }
  return map;
}

async function resolveCwdsProcReadlink(pids) {
  const map = new Map();
  const chunkSize = 64;
  for (let i = 0; i < pids.length; i += chunkSize) {
    const slice = pids.slice(i, i + chunkSize);
    const results = await Promise.all(
      slice.map(async (pid) => {
        if (!Number.isInteger(pid) || pid <= 0) return null;
        try {
          const target = await fs.promises.readlink(`/proc/${pid}/cwd`);
          return [pid, target];
        } catch {
          return null;
        }
      })
    );
    for (const entry of results) {
      if (entry) map.set(entry[0], entry[1]);
    }
  }
  return map;
}

async function resolveLocalProcessCwds(pids, options = {}) {
  if (!pids.length) return new Map();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const execFileImpl = options.execFileImpl || execFile;
  if (process.platform === 'linux') {
    return resolveCwdsProcReadlink(pids);
  }
  return resolveCwdsLsofChunks(pids, timeoutMs, execFileImpl);
}

async function resolveRemoteProcessCwds(remote, pids, options = {}) {
  if (!pids.length) return new Map();
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const map = new Map();
  for (let i = 0; i < pids.length; i += LSOF_PID_CHUNK) {
    const chunk = pids.slice(i, i + LSOF_PID_CHUNK);
    const list = chunk.join(',');
    const cmd = `lsof -a -d cwd -p ${list} -Fn 2>/dev/null || true`;
    let stdout = '';
    try {
      stdout = await runSsh(cfg.host, cmd, timeoutMs);
    } catch {
      stdout = '';
    }
    const part = parseLsofFnCwdOutput(stdout);
    for (const [k, v] of part) map.set(k, v);
  }
  return map;
}

/**
 * @param {{ likely: object[], all: object[], items: object[] }} filtered
 * @param {object} opts
 */
async function applyWorkspaceCwdFilter(filtered, opts) {
  const {
    workspaceRoots,
    remote,
    includeAll,
    selfPid,
    maxCwdResolve,
    timeoutMs,
    execFileImpl,
    runSsh,
    mode,
    aggressiveClean,
  } = opts;
  const cap = Number.isInteger(maxCwdResolve) && maxCwdResolve > 0 ? maxCwdResolve : DEFAULT_MAX_CWD_RESOLVE;
  const roots = normalizeWorkspaceRootStrings(workspaceRoots);
  if (!roots.length) {
    return {
      likely: filtered.likely,
      all: filtered.all,
      items: filtered.items,
      truncated: false,
      workspace_roots_applied: false,
      no_match_reason: null,
    };
  }

  let resolvedLocalRoots = [];
  let posixRoots = [];
  if (mode === 'remote') {
    posixRoots = normalizeRemoteWorkspaceRootsPosix(roots);
    if (!posixRoots.length) {
      return {
        likely: filtered.likely,
        all: filtered.all,
        items: filtered.items,
        truncated: false,
        workspace_roots_applied: false,
        no_match_reason: null,
      };
    }
  } else {
    resolvedLocalRoots = resolveLocalWorkspaceRootsRealpath(roots);
    if (!resolvedLocalRoots.length) {
      return {
        likely: filtered.likely,
        all: filtered.all,
        items: filtered.items,
        truncated: false,
        workspace_roots_applied: false,
        no_match_reason: null,
      };
    }
  }

  let toResolve = [...filtered.items];
  let truncated = false;
  if (toResolve.length > cap) {
    truncated = true;
    toResolve = toResolve.slice(0, cap);
  }
  const pids = toResolve.map((p) => p.pid);
  let cwdMap;
  if (mode === 'remote') {
    cwdMap = await resolveRemoteProcessCwds(remote, pids, { timeoutMs, runSsh });
  } else {
    cwdMap = await resolveLocalProcessCwds(pids, { timeoutMs, execFileImpl });
  }

  const withCwd = toResolve.map((p) => ({ ...p, cwd: cwdMap.get(p.pid) || '' }));
  const underRoot = (cwd) =>
    mode === 'remote' ? isCwdUnderAnyPosixRoot(posixRoots, cwd) : isCwdUnderAnyLocalRoot(resolvedLocalRoots, cwd);

  const matched = withCwd.filter((p) => p.cwd && underRoot(p.cwd));
  let no_match_reason = null;
  if (matched.length === 0 && withCwd.length > 0) {
    no_match_reason = 'workspace';
  }

  const matchedSorted = sortLikelyFirst(matched);
  let matchedNonNoise = matchedSorted.filter((p) => !looksLikeNoise(p, selfPid, !!aggressiveClean));
  if (aggressiveClean && !includeAll) {
    matchedNonNoise = collapseDuplicateCommandWorkers(matchedNonNoise);
  }
  const itemsOut = sortLikelyFirst(includeAll ? matchedSorted : matchedNonNoise);
  const likelyOut = sortLikelyFirst(matchedNonNoise);
  const allOut = matchedSorted;

  return {
    likely: likelyOut,
    all: allOut,
    items: itemsOut,
    truncated,
    workspace_roots_applied: true,
    no_match_reason,
  };
}

async function listLocalProcesses(options = {}) {
  const stdout = await runExecFile(
    'ps',
    ['-ax', '-o', 'pid=,ppid=,pgid=,tty=,etime=,pcpu=,command='],
    options.timeoutMs,
    options.execFileImpl
  );
  const parsed = parsePsOutput(stdout).map((proc) => attachWatchPreset(proc));
  const filtered = filterProcesses(parsed, {
    includeAll: options.includeAll,
    query: options.query,
    selfPid: options.selfPid || process.pid,
    aggressiveClean: !!options.aggressiveClean,
  });
  const maxCwd = options.maxCwdResolve ?? DEFAULT_MAX_CWD_RESOLVE;
  if (!normalizeWorkspaceRootStrings(options.workspaceRoots).length) {
    return {
      ...filtered,
      truncated: false,
      workspace_roots_applied: false,
      no_match_reason: null,
    };
  }
  return applyWorkspaceCwdFilter(filtered, {
    workspaceRoots: options.workspaceRoots,
    includeAll: !!options.includeAll,
    selfPid: options.selfPid || process.pid,
    maxCwdResolve: maxCwd,
    timeoutMs: options.timeoutMs,
    execFileImpl: options.execFileImpl,
    mode: 'local',
    aggressiveClean: !!options.aggressiveClean,
  });
}

function remoteProcessListSshErrorMessage(host, err) {
  const h = String(host || '').trim() || 'remote';
  if (err && err.killed) {
    return `${h} server down`;
  }
  const raw = String((err && err.message) || err || '').trim();
  const oneLine = raw.replace(/\s+/g, ' ').slice(0, 160);
  if (
    /timed out|timeout|connection refused|no route|could not resolve|name or service not known|network is unreachable/i.test(
      oneLine
    )
  ) {
    return `${h} server down`;
  }
  return oneLine ? `${h}: ${oneLine}` : `${h} server down`;
}

async function listRemoteProcesses(remote, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  let stdout = '';
  try {
    stdout = await runSsh(
      cfg.host,
      "ps -ax -o pid=,ppid=,pgid=,tty=,etime=,pcpu=,command= 2>/dev/null || true",
      options.timeoutMs
    );
  } catch (err) {
    return {
      likely: [],
      all: [],
      items: [],
      truncated: false,
      workspace_roots_applied: false,
      no_match_reason: null,
      remote_error: remoteProcessListSshErrorMessage(cfg.host, err),
    };
  }
  const parsed = parsePsOutput(stdout).map((p) => attachWatchPreset({ ...p, host: cfg.host }));
  const filtered = filterProcesses(parsed, {
    includeAll: options.includeAll,
    query: options.query,
    aggressiveClean: !!options.aggressiveClean,
  });
  const maxCwd = options.maxCwdResolve ?? DEFAULT_MAX_CWD_RESOLVE;
  if (!normalizeWorkspaceRootStrings(options.workspaceRoots).length) {
    return {
      ...filtered,
      truncated: false,
      workspace_roots_applied: false,
      no_match_reason: null,
    };
  }
  return applyWorkspaceCwdFilter(filtered, {
    workspaceRoots: options.workspaceRoots,
    remote,
    includeAll: !!options.includeAll,
    selfPid: null,
    maxCwdResolve: maxCwd,
    timeoutMs: options.timeoutMs,
    runSsh,
    mode: 'remote',
    aggressiveClean: !!options.aggressiveClean,
  });
}

async function isLocalPidAlive(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const stdout = await runExecFile(
      'ps',
      ['-p', String(pid), '-o', 'pid='],
      options.timeoutMs,
      options.execFileImpl
    );
    return stdout.trim() === String(pid);
  } catch {
    return false;
  }
}

/**
 * Prefer `/proc/<pid>` on Linux (remote), then `ps`.
 * `unknown` so watchers do not treat flakes as “process exited”.
 *
 * @param {{ host: string, projects_root?: string }} remote
 * @param {number} pid
 * @param {{ runSsh?: Function, timeoutMs?: number }} [options]
 * @returns {Promise<{ status: 'alive' | 'dead' | 'unknown', error?: string }>}
 */
async function probeRemotePidAlive(remote, pid, options = {}) {
  const p = Number.isInteger(pid) ? pid : Number.parseInt(pid, 10);
  if (!Number.isInteger(p) || p <= 0) {
    return { status: 'unknown', error: 'Invalid PID' };
  }
  const pidStr = String(p);
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  const remoteCmd = `sh -lc 'x=${pidStr}; if [ -d "/proc/$x" ]; then echo "$x"; else o=$(ps -p "$x" -o pid= 2>/dev/null || true); o=$(printf "%s" "$o" | tr -d " \\t\\r\\n"); if [ "$o" = "$x" ]; then echo "$x"; fi; fi'`;
  try {
    const out = await runSsh(cfg.host, remoteCmd, options.timeoutMs);
    const trimmed = String(out || '').trim();
    if (trimmed === pidStr) return { status: 'alive' };
    if (trimmed === '') return { status: 'dead' };
    return {
      status: 'unknown',
      error: `Unexpected remote pid probe output: ${JSON.stringify(trimmed.slice(0, 120))}`,
    };
  } catch (err) {
    return { status: 'unknown', error: err.message || String(err) };
  }
}

async function isRemotePidAlive(remote, pid, options = {}) {
  const r = await probeRemotePidAlive(remote, pid, options);
  return r.status === 'alive';
}

async function readLocalDockerLogs(containerName, options = {}) {
  const container = assertValidDockerContainerName(containerName);
  return runExecFile(
    'docker',
    ['logs', '--tail', String(DOCKER_LOG_TAIL_LINES), container],
    options.timeoutMs,
    options.execFileImpl
  );
}

async function readRemoteDockerLogs(remote, containerName, options = {}) {
  const container = assertValidDockerContainerName(containerName);
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  const cmd = `docker logs --tail ${DOCKER_LOG_TAIL_LINES} ${container} 2>&1 || true`;
  return runSsh(cfg.host, cmd, options.timeoutMs);
}

module.exports = {
  ISAAC_READY_PATTERN,
  ISAAC_READY_PATTERNS,
  normalizeLogContainsPatterns,
  dockerLogsMatchAnyPattern,
  parsePsLine,
  parsePsOutput,
  parseDockerContainerName,
  detectIsaacWatchPreset,
  assertValidDockerContainerName,
  collapseDuplicateCommandWorkers,
  filterProcesses,
  listLocalProcesses,
  listRemoteProcesses,
  readLocalDockerLogs,
  readRemoteDockerLogs,
  isLocalPidAlive,
  probeRemotePidAlive,
  isRemotePidAlive,
  parseLsofFnCwdOutput,
  normalizeWorkspaceRootStrings,
  resolveLocalWorkspaceRootsRealpath,
  normalizeRemoteWorkspaceRootsPosix,
  isCwdUnderAnyLocalRoot,
  isCwdUnderAnyPosixRoot,
  looksLikeAggressiveNoise,
  stripShellOrnamentArgs,
  isShellOnlyOrnamentProcess,
  isCondaRunIdleWrapper,
  isEphemeralTmpScratchProcess,
  isPythonMultiprocessingWorker,
  isAgyProcess,
};
