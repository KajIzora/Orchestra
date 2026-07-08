const path = require('path');
const { assertValidRemoteSource, createSshRunner } = require('./remote_cursor_tracker');
const { getCodexTaskAppHookScript } = require('./codex_hook_script');
const {
  buildRemoteHookConfigWriteLines,
  buildRemoteConfigBackupLines,
  parseRemoteBackupMarker,
} = require('./remote_hook_config');
const { getHookEventsForProfile } = require('./signal_registry');

// Control-plane (install-remote) budget: see remote_claude_hooks.js — 3000ms flaked on cold handshake.
const DEFAULT_TIMEOUT_MS = 15000;
const REMOTE_CODEX_HOOK_SCRIPT_PATH = '$HOME/.codex/hooks/task-app-codex-hook.sh';
const REMOTE_CODEX_CONFIG_TOML_PATH = '$HOME/.codex/config.toml';

const CODEX_HOOK_EVENTS = getHookEventsForProfile('codex', 'production');

function buildCodexHookConfigBlock(hookScriptAbs, options = {}) {
  const hookEvents = getHookEventsForProfile('codex', options.profile);
  const lines = [
    '# Orchestra Codex hooks begin',
    '# Managed by Orchestra. These hooks forward lifecycle payloads to the local app.',
  ];
  for (const eventName of hookEvents) {
    lines.push(
      `[[hooks.${eventName}]]`,
      'matcher = "*"',
      `[[hooks.${eventName}.hooks]]`,
      'type = "command"',
      `command = ${JSON.stringify(hookScriptAbs)}`,
      'timeout = 10',
      `statusMessage = "Orchestra ${eventName}"`,
      ''
    );
  }
  lines.push('# Orchestra Codex hooks end');
  return lines.join('\n');
}

/**
 * Install Orchestra Codex hook script on a remote host and merge hook entries into
 * the remote ~/.codex/config.toml without replacing unrelated remote settings.
 *
 * @param {{ host: string, projects_root?: string }} remote
 * @param {{ runSsh?: Function, timeoutMs?: number, getCodexHookScript?: () => string, remoteApiBase?: string, localPort?: number, token?: string }} [options]
 */
async function ensureRemoteCodexHooks(remote, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const backupTs = Date.now();
  const remoteHome = (await runSsh(cfg.host, 'printf %s "$HOME"', timeoutMs)).trim();
  if (!remoteHome || remoteHome.includes('\n') || !remoteHome.startsWith('/')) {
    throw new Error('Could not resolve remote HOME');
  }

  const scriptBody =
    typeof options.getCodexHookScript === 'function' ? options.getCodexHookScript() : getCodexTaskAppHookScript();
  const scriptB64 = Buffer.from(scriptBody, 'utf8').toString('base64');
  const hookScriptAbs = path.posix.join(remoteHome, '.codex', 'hooks', 'task-app-codex-hook.sh');
  const configTomlAbs = path.posix.join(remoteHome, '.codex', 'config.toml');

  const configBlock = buildCodexHookConfigBlock(hookScriptAbs, { profile: options.profile });
  const configBlockB64 = Buffer.from(configBlock, 'utf8').toString('base64');

  // Resolve the API base the remote machine should POST hook events to.
  let resolvedApiBase = null;
  const explicitBase =
    typeof options.remoteApiBase === 'string' && options.remoteApiBase.trim()
      ? options.remoteApiBase.trim()
      : null;
  if (explicitBase) {
    resolvedApiBase = explicitBase;
  } else if (options.localPort) {
    try {
      const sshClientRaw = (await runSsh(cfg.host, 'printf %s "$SSH_CLIENT"', timeoutMs)).trim();
      const sshClientIp = sshClientRaw.split(/\s+/)[0];
      if (sshClientIp && (sshClientIp.includes('.') || sshClientIp.includes(':'))) {
        resolvedApiBase = `http://${sshClientIp}:${options.localPort}`;
      }
    } catch {
      // SSH_CLIENT unavailable — skip
    }
  }

  const remoteToken =
    typeof options.token === 'string' && options.token.trim() ? options.token.trim() : null;

  let remoteConfigLines = [];
  if (resolvedApiBase) {
    try {
      const u = new URL(resolvedApiBase);
      const apiHost = u.hostname;
      const apiPort = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
      const configObj = { host: apiHost, port: apiPort, remote_host: cfg.host };
      if (remoteToken) configObj.token = remoteToken;
      remoteConfigLines = buildRemoteHookConfigWriteLines({ provider: 'codex', configObj, timestampMs: backupTs });
    } catch {
      // Invalid URL — skip writing config.json on remote
    }
  }

  const tomlBackupLines = buildRemoteConfigBackupLines({
    pathExpr: 'cp_toml',
    backupPathVar: '_codex_toml_backup',
    markerTag: 'CODEX_TOML',
    timestampMs: backupTs,
  });

  const py = [
    'import base64,json,os,re,shutil',
    'h=os.path.expanduser("~")',
    'p=os.path.join(h,".codex","hooks","task-app-codex-hook.sh")',
    'os.makedirs(os.path.dirname(p),exist_ok=True)',
    `open(p,"wb").write(base64.b64decode(${JSON.stringify(scriptB64)}))`,
    'os.chmod(p,0o755)',
    'cp_toml=os.path.join(h,".codex","config.toml")',
    'os.makedirs(os.path.dirname(cp_toml),exist_ok=True)',
    ...tomlBackupLines,
    'try:',
    '    raw=open(cp_toml,"r",encoding="utf-8").read()',
    'except Exception:',
    '    raw=""',
    `block=base64.b64decode(${JSON.stringify(configBlockB64)}).decode("utf-8")`,
    'cleaned=re.sub(r"\\n?# Orchestra Codex hooks begin\\n[\\s\\S]*?\\n# Orchestra Codex hooks end\\n?","\\n",raw).rstrip()',
    'prefix=(cleaned+"\\n\\n") if cleaned else ""',
    'open(cp_toml,"w",encoding="utf-8").write(prefix+block+"\\n")',
    ...remoteConfigLines,
  ].join('\n');

  const cmd = `python3 - <<'PY'\n${py}\nPY`;
  const stdout = await runSsh(cfg.host, cmd, timeoutMs);

  return {
    ok: true,
    host: cfg.host,
    hook_script: hookScriptAbs,
    config_toml: configTomlAbs,
    config_toml_backup: parseRemoteBackupMarker(stdout, 'CODEX_TOML'),
    att_config_backup: parseRemoteBackupMarker(stdout, 'ATT_CONFIG'),
    profile: options.profile === 'maximal' ? 'maximal' : 'production',
    hook_events: getHookEventsForProfile('codex', options.profile),
  };
}

module.exports = {
  ensureRemoteCodexHooks,
  buildCodexHookConfigBlock,
  REMOTE_CODEX_HOOK_SCRIPT_PATH,
  REMOTE_CODEX_CONFIG_TOML_PATH,
  CODEX_HOOK_EVENTS,
};
