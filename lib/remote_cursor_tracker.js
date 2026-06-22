const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { latestUserWordsPreviewFromTailText } = require('./transcript_preview');
const {
  buildRemoteConfigBackupLines,
  buildRemoteHookConfigWriteLines,
  parseRemoteBackupMarker,
} = require('./remote_hook_config');
const { buildHookForwarderBlock } = require('./hook_forwarder');
const { getHookEventsForProfile, normalizeHookProfile } = require('./signal_registry');

const DEFAULT_MAX_RUNS = 80;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_TAIL_BYTES = 512 * 1024;
const PREVIEW_MAX_WORDS = 10;
const SSH_CONNECT_TIMEOUT_SECONDS = 3;
const PREVIEW_BEGIN = '__ATT_PREVIEW_BEGIN__';
const PREVIEW_END = '__ATT_PREVIEW_END__';
const REMOTE_HOOK_SCRIPT_PATH = '$HOME/.cursor/hooks/task-app-cursor-hook.sh';
const REMOTE_HOOKS_JSON_PATH = '$HOME/.cursor/hooks.json';
const REMOTE_HOOK_LOG_PATH = '$HOME/.cursor/task-app-hook-events.jsonl';
const DEFAULT_REMOTE_PROJECTS_ROOT = '$HOME/.cursor/projects';

function workspacePathToProjectSlug(workspacePath) {
  if (typeof workspacePath !== 'string') return '';
  const trimmed = workspacePath.trim();
  if (!trimmed) return '';
  return path.posix
    .normalize(trimmed)
    .replace(/^\/+/, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function posixDirPrefix(root) {
  return root.endsWith('/') ? root : `${root}/`;
}

function normalizePosixAbsolute(p) {
  if (typeof p !== 'string') throw new Error('Path must be a string');
  const trimmed = p.trim();
  if (!trimmed.startsWith('/')) throw new Error('Path must be absolute');
  const normalized = path.posix.normalize(trimmed);
  if (normalized === '.') throw new Error('Path must be absolute');
  return normalized;
}

function normalizeRemoteProjectsRoot(rawRoot) {
  const value = typeof rawRoot === 'string' ? rawRoot.trim() : '';
  if (!value) return DEFAULT_REMOTE_PROJECTS_ROOT;
  if (value.startsWith('$HOME/')) {
    return path.posix.normalize(value);
  }
  return normalizePosixAbsolute(value);
}

function assertValidSshHost(host) {
  const value = typeof host === 'string' ? host.trim() : '';
  if (!value) throw new Error('cursor_remote.host is required');
  if (value.startsWith('-')) throw new Error('cursor_remote.host is invalid');
  if (!/^[A-Za-z0-9._-]+(?:@[A-Za-z0-9._-]+)?$/.test(value)) {
    throw new Error('cursor_remote.host is invalid');
  }
  return value;
}

function assertValidRemoteSource(remote) {
  const source = remote && typeof remote === 'object' ? remote : {};
  const host = assertValidSshHost(source.host);
  const projects_root = normalizeRemoteProjectsRoot(source.projects_root);
  return { host, projects_root };
}

function assertAllowedRemoteTranscriptPath(transcriptPath, projectsRoot) {
  const resolved = normalizePosixAbsolute(transcriptPath);
  const root = typeof projectsRoot === 'string' ? projectsRoot.trim() : '';
  if (root.startsWith('$HOME/')) {
    const marker = '/.cursor/projects/';
    const exact = '/.cursor/projects';
    if (!resolved.includes(marker) && !resolved.endsWith(exact)) {
      throw new Error('Remote transcript path must stay under cursor_remote.projects_root');
    }
  } else {
    const prefix = posixDirPrefix(root);
    if (resolved !== root && !resolved.startsWith(prefix)) {
      throw new Error('Remote transcript path must stay under cursor_remote.projects_root');
    }
  }
  if (!resolved.endsWith('.jsonl')) {
    throw new Error('Remote transcript path must be a .jsonl file');
  }
  return resolved;
}

let sshControlDirReady = false;
let sshControlDir = null;

function getSshControlDirCandidates() {
  const uid =
    typeof process.getuid === 'function' && Number.isInteger(process.getuid()) ? String(process.getuid()) : 'user';
  return [path.join('/tmp', `orchestra-ssh-${uid}`), path.join(os.tmpdir(), 'orchestra-ssh')];
}

function isShortEnoughControlPath(controlDir) {
  // OpenSSH expands %C to a SHA1 hash (40 hex chars) and Unix-domain socket
  // paths commonly cap out around 104 bytes on macOS.
  return Buffer.byteLength(path.join(controlDir, `cm-${'x'.repeat(40)}`)) < 100;
}

function ensureSshControlDir() {
  if (sshControlDirReady && sshControlDir) return sshControlDir;
  for (const candidate of getSshControlDirCandidates()) {
    if (!isShortEnoughControlPath(candidate)) continue;
    try {
      fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(candidate, 0o700);
      } catch {
        // Best effort; OpenSSH will reject unsafe permissions if they matter.
      }
      sshControlDir = candidate;
      sshControlDirReady = true;
      return sshControlDir;
    } catch {
      // Try the next candidate, then fall through and run without multiplexing.
    }
  }
  return '';
}

function buildSshArgs(host, remoteCommand) {
  const controlDir = ensureSshControlDir();
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
  ];
  if (sshControlDirReady && controlDir) {
    args.push(
      '-o',
      'ControlMaster=auto',
      '-o',
      `ControlPath=${path.join(controlDir, 'cm-%C')}`,
      '-o',
      'ControlPersist=60s'
    );
  }
  args.push(host, remoteCommand);
  return args;
}

function createSshRunner(execFileImpl = execFile) {
  return function runSsh(host, remoteCommand, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      execFileImpl(
        'ssh',
        buildSshArgs(host, remoteCommand),
        { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const msg = (stderr || err.message || 'ssh command failed').trim();
            reject(new Error(msg));
            return;
          }
          resolve(stdout || '');
        }
      );
    });
  };
}

function parseRemoteRunPath(projectsRoot, transcriptPath) {
  const rel = path.posix.relative(projectsRoot, transcriptPath);
  const parts = rel.split('/').filter(Boolean);
  const project_slug = parts[0] || '';
  const run_id = path.posix.basename(transcriptPath, '.jsonl');
  return { project_slug, run_id };
}

function parseFindOutput(projectsRoot, output) {
  const runs = [];
  const lines = String(output || '').split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const [mtimeRaw, transcriptRaw] = line.split('\t');
    if (!mtimeRaw || !transcriptRaw) continue;
    let transcript_path;
    try {
      transcript_path = assertAllowedRemoteTranscriptPath(transcriptRaw, projectsRoot);
    } catch {
      continue;
    }
    const { project_slug, run_id } = parseRemoteRunPath(projectsRoot, transcript_path);
    const mtime_ms = Math.max(0, Number.parseFloat(mtimeRaw) * 1000) || 0;
    runs.push({
      source: 'ssh',
      host: null,
      projects_root: projectsRoot,
      run_id,
      transcript_path,
      project_slug,
      mtime_ms,
      user_preview: '',
    });
  }
  return runs;
}

function buildPreviewCommand(transcriptPaths, tailBytes) {
  const paths = transcriptPaths.map(shellQuote).join(' ');
  return (
    `for p in ${paths}; do ` +
    `printf '%s\\t%s\\n' ${shellQuote(PREVIEW_BEGIN)} "$p"; ` +
    `if [ -f "$p" ]; then ` +
    `tail -c ${tailBytes} "$p" 2>/dev/null | ` +
    `awk '/"role"[[:space:]]*:[[:space:]]*"user"/ { last=$0 } END { if (last) print last }'; ` +
    `fi; ` +
    `printf '%s\\n' ${shellQuote(PREVIEW_END)}; ` +
    `done`
  );
}

function parsePreviewOutput(projectsRoot, output) {
  const previews = new Map();
  let currentPath = null;
  let body = [];

  function finishCurrent() {
    if (!currentPath) return;
    previews.set(currentPath, body.join('\n'));
    currentPath = null;
    body = [];
  }

  for (const line of String(output || '').split('\n')) {
    if (line.startsWith(`${PREVIEW_BEGIN}\t`)) {
      finishCurrent();
      const rawPath = line.slice(PREVIEW_BEGIN.length + 1);
      try {
        currentPath = assertAllowedRemoteTranscriptPath(rawPath, projectsRoot);
        body = [];
      } catch {
        currentPath = null;
        body = [];
      }
      continue;
    }
    if (line === PREVIEW_END) {
      finishCurrent();
      continue;
    }
    if (currentPath) body.push(line);
  }

  finishCurrent();
  return previews;
}

async function addRemotePreviews(remote, runs, options = {}) {
  if (!runs.length) return;
  const tailBytes =
    Number.isInteger(options.previewTailBytes) && options.previewTailBytes > 0
      ? options.previewTailBytes
      : DEFAULT_TAIL_BYTES;
  const runSsh = options.runSsh || createSshRunner();
  const cmd = buildPreviewCommand(
    runs.map((run) => run.transcript_path),
    tailBytes
  );

  let stdout;
  try {
    stdout = await runSsh(remote.host, cmd, options.timeoutMs);
  } catch {
    return;
  }

  const previews = parsePreviewOutput(remote.projects_root, stdout);
  for (const run of runs) {
    const tailText = previews.get(run.transcript_path);
    if (!tailText) continue;
    run.user_preview = latestUserWordsPreviewFromTailText(tailText, PREVIEW_MAX_WORDS);
  }
}

async function discoverRemoteCursorRuns(remote, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const maxRuns = Number.isInteger(options.maxRuns) && options.maxRuns > 0 ? options.maxRuns : DEFAULT_MAX_RUNS;
  const runSsh = options.runSsh || createSshRunner();
  const workspacePaths = Array.isArray(options.workspacePaths) ? options.workspacePaths : [];
  const workspaceSlugs = [...new Set(workspacePaths.map((p) => workspacePathToProjectSlug(p)).filter(Boolean))];
  const findTargets = workspaceSlugs.length
    ? workspaceSlugs.map((slug) => shellQuote(path.posix.join(cfg.projects_root, slug, 'agent-transcripts'))).join(' ')
    : shellQuote(cfg.projects_root);
  const cmd =
    `find ${findTargets} -type f -path '*/agent-transcripts/*/*.jsonl' ` +
    "-printf '%T@\\t%p\\n' 2>/dev/null | sort -nr | head -n " +
    String(maxRuns);
  const stdout = await runSsh(cfg.host, cmd, options.timeoutMs);
  const runs = parseFindOutput(cfg.projects_root, stdout);
  const runsWithHost = runs.map((run) => ({ ...run, host: cfg.host }));
  await addRemotePreviews(cfg, runsWithHost, { ...options, runSsh });

  return runsWithHost;
}

function parseTailOutput(stdout) {
  const all = String(stdout || '');
  if (all.startsWith('__MISSING__')) {
    return { missing: true, mtimeMs: null, tailText: null };
  }
  const nl = all.indexOf('\n');
  if (nl === -1) {
    throw new Error('Could not parse remote transcript metadata');
  }
  const meta = all.slice(0, nl);
  const body = all.slice(nl + 1);
  const m = meta.match(/^__MTIME__:(\d+)$/);
  if (!m) {
    throw new Error('Could not parse remote transcript mtime');
  }
  return { missing: false, mtimeMs: Number.parseInt(m[1], 10) * 1000, tailText: body };
}

async function readRemoteTranscriptTailText(remote, transcriptPath, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const resolved = assertAllowedRemoteTranscriptPath(transcriptPath, cfg.projects_root);
  const tailBytes = Number.isInteger(options.tailBytes) && options.tailBytes > 0 ? options.tailBytes : DEFAULT_TAIL_BYTES;
  const runSsh = options.runSsh || createSshRunner();
  const quotedPath = shellQuote(resolved);
  const cmd =
    `if [ ! -f ${quotedPath} ]; then echo "__MISSING__"; exit 0; fi; ` +
    `mtime=$(stat -c %Y ${quotedPath} 2>/dev/null || stat -f %m ${quotedPath}); ` +
    'echo "__MTIME__:$mtime"; ' +
    `tail -c ${tailBytes} ${quotedPath} 2>/dev/null || true`;
  const stdout = await runSsh(cfg.host, cmd, options.timeoutMs);
  return parseTailOutput(stdout);
}

async function readRemoteTranscriptTail(remote, transcriptPath, options = {}) {
  const r = await readRemoteTranscriptTailText(remote, transcriptPath, options);
  if (r.missing) return { missing: true, mtimeMs: null, lastLine: null };
  const lines = String(r.tailText || '').split('\n').filter((line) => line.trim().length > 0);
  const lastLine = lines.length ? lines[lines.length - 1] : null;
  return { missing: false, mtimeMs: r.mtimeMs, lastLine };
}

module.exports = {
  DEFAULT_MAX_RUNS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TAIL_BYTES,
  assertValidSshHost,
  assertValidRemoteSource,
  assertAllowedRemoteTranscriptPath,
  createSshRunner,
  discoverRemoteCursorRuns,
  readRemoteTranscriptTailText,
  readRemoteTranscriptTail,
  workspacePathToProjectSlug,
  REMOTE_HOOK_SCRIPT_PATH,
  REMOTE_HOOKS_JSON_PATH,
  REMOTE_HOOK_LOG_PATH,
  DEFAULT_REMOTE_PROJECTS_ROOT,
  ensureRemoteCursorHooks,
  readRemoteHookEvents,
  shellQuote,
};

async function ensureRemoteCursorHooks(remote, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  const token = options.token || '';
  const profile = normalizeHookProfile(options.profile);
  const hookEvents = getHookEventsForProfile('cursor', profile);
  const backupTs = Date.now();
  const scriptPath = '$HOME/.cursor/hooks/task-app-cursor-hook.sh';
  const hooksJsonPath = '$HOME/.cursor/hooks.json';
  const hookLogPath = '$HOME/.cursor/task-app-hook-events.jsonl';
  const remoteHostLiteral = JSON.stringify(cfg.host);
  const forwarder = buildHookForwarderBlock({
    envApiBase: 'CURSOR_HOOK_API_BASE',
    envToken: 'CURSOR_HOOK_TOKEN',
    envRemoteHost: 'CURSOR_HOOK_REMOTE_HOST',
    tokenField: 'cursor',
    endpoint: '/api/cursor-hooks/event',
    header: 'X-Cursor-Hook-Token',
    configEndpoint: '/api/cursor-hooks/config',
  });
  const script = `#!/bin/bash
set +e
LOG_FILE="$HOME/.cursor/task-app-hook-events.jsonl"
mkdir -p "$(dirname "$LOG_FILE")"
payload="$(cat)"
printf '%s\\n' "$payload" >> "$LOG_FILE"
REMOTE_HOST=${remoteHostLiteral}
payload="$(CURSOR_HOOK_PAYLOAD="$payload" CURSOR_REMOTE_HOST="$REMOTE_HOST" python3 - <<'PY' 2>/dev/null
import json, os, sys
raw = os.environ.get("CURSOR_HOOK_PAYLOAD", "")
try:
    data = json.loads(raw or "{}")
    if not isinstance(data, dict):
        data = {}
except Exception:
    data = {}
data["source"] = "ssh"
data["host"] = os.environ.get("CURSOR_REMOTE_HOST", "")
data["remote_host"] = data["host"]
sys.stdout.write(json.dumps(data))
PY
)"
CURSOR_HOOK_REMOTE_HOST="$REMOTE_HOST"
${forwarder}
exit 0`;
  const hooksBackupPy = buildRemoteConfigBackupLines({
    pathExpr: 'p',
    backupPathVar: '_cursor_hooks_backup',
    markerTag: 'HOOKS_JSON',
    timestampMs: backupTs,
  }).join('\n');
  let remoteConfigLines = [];
  const explicitBase =
    typeof options.remoteApiBase === 'string' && options.remoteApiBase.trim()
      ? options.remoteApiBase.trim()
      : null;
  if (explicitBase) {
    try {
      const u = new URL(explicitBase);
      const apiHost = u.hostname;
      const apiPort = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
      const configObj = { host: apiHost, port: apiPort, remote_host: cfg.host };
      if (token) configObj.token = token;
      remoteConfigLines = buildRemoteHookConfigWriteLines({
        provider: 'cursor',
        configObj,
        timestampMs: backupTs,
      });
    } catch {
      // Invalid explicit URL — skip remote config write.
    }
  }

  const cmd =
    `mkdir -p "$HOME/.cursor/hooks" && ` +
    `cat > "${scriptPath}" <<'EOF'\n${script}\nEOF\n` +
    `chmod +x "${scriptPath}" && ` +
    `python3 - <<'PY'\n` +
    `import base64,json,os,shutil\n` +
    `h=os.path.expanduser("~")\n` +
    `p=os.path.expandvars(${JSON.stringify(hooksJsonPath)})\n` +
    `os.makedirs(os.path.dirname(p),exist_ok=True)\n` +
    `${hooksBackupPy}\n` +
    `cmd=${JSON.stringify(scriptPath)}\n` +
    `try:\n` +
    `  with open(p,'r',encoding='utf-8') as f: cfg=json.load(f)\n` +
    `except Exception:\n` +
    `  cfg={"version":1,"hooks":{}}\n` +
    `if not isinstance(cfg,dict): cfg={"version":1,"hooks":{}}\n` +
    `hooks=cfg.setdefault("hooks",{})\n` +
    `if not isinstance(hooks,dict): hooks={}; cfg["hooks"]=hooks\n` +
    `for ev in ${JSON.stringify(hookEvents)}:\n` +
    `  arr=hooks.get(ev)\n` +
    `  if not isinstance(arr,list): arr=[]\n` +
    `  if not any(isinstance(x,dict) and x.get("command")==cmd for x in arr):\n` +
    `    arr.append({"command":cmd})\n` +
    `  hooks[ev]=arr\n` +
    `with open(p,'w',encoding='utf-8') as f: json.dump(cfg,f,indent=2)\n` +
    `${remoteConfigLines.join('\n')}\n` +
    `PY`;
  const stdout = await runSsh(cfg.host, cmd, options.timeoutMs);
  if (token) {
    // Best-effort export helper for remote shell users if they source this file.
    await runSsh(
      cfg.host,
      `mkdir -p ~/.cursor/hooks && printf '%s\\n' ${shellQuote(`export TASK_APP_HOOK_TOKEN=${token}`)} > ~/.cursor/hooks/task-app-env.sh`,
      options.timeoutMs
    ).catch(() => {});
  }
  return {
    ok: true,
    host: cfg.host,
    script_path: REMOTE_HOOK_SCRIPT_PATH,
    hooks_json_path: REMOTE_HOOKS_JSON_PATH,
    hooks_json_backup: parseRemoteBackupMarker(stdout, 'HOOKS_JSON'),
    profile,
    hook_events: hookEvents,
  };
}

async function readRemoteHookEvents(remote, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  const offset = Number.isInteger(options.offset) && options.offset >= 0 ? options.offset : 0;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 100;
  const cmd =
    `if [ ! -f "$HOME/.cursor/task-app-hook-events.jsonl" ]; then echo "__NOFILE__"; exit 0; fi; ` +
    `python3 - <<'PY'\n` +
    `import json\n` +
    `import os\n` +
    `p=os.path.expandvars(${JSON.stringify(REMOTE_HOOK_LOG_PATH)})\n` +
    `off=${offset}\n` +
    `limit=${limit}\n` +
    `with open(p,'r',encoding='utf-8',errors='ignore') as f:\n` +
    `  f.seek(off)\n` +
    `  lines=[]\n` +
    `  for _ in range(limit):\n` +
    `    line=f.readline()\n` +
    `    if not line: break\n` +
    `    lines.append(line.rstrip('\\n'))\n` +
    `  new_off=f.tell()\n` +
    `print('__OFFSET__:'+str(new_off))\n` +
    `for line in lines:\n` +
    `  print(line)\n` +
    `PY`;
  const stdout = await runSsh(cfg.host, cmd, options.timeoutMs);
  if (stdout.startsWith('__NOFILE__')) return { events: [], offset };
  const lines = String(stdout).split('\n');
  const meta = lines.shift() || '';
  const m = meta.match(/^__OFFSET__:(\d+)$/);
  const nextOffset = m ? Number.parseInt(m[1], 10) : offset;
  const events = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      // Ignore malformed remote lines.
    }
  }
  return { events, offset: nextOffset };
}
