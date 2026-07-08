const path = require('path');
const { assertValidRemoteSource, createSshRunner } = require('./remote_cursor_tracker');
const { getClaudeTaskAppHookScript } = require('./claude_hook_script');
const {
  buildRemoteHookConfigWriteLines,
  buildRemoteConfigBackupLines,
  parseRemoteBackupMarker,
} = require('./remote_hook_config');
const { getHookEventsForProfile, normalizeHookProfile } = require('./signal_registry');

// Control-plane (install-remote) budget: a remote Mac's cold ssh handshake measured ~2.9s, so 3000ms
// made the first call after ControlPersist expiry a coin-flip (2026-07 ssh round, SH-3).
const DEFAULT_TIMEOUT_MS = 15000;
const REMOTE_CLAUDE_HOOK_SCRIPT_PATH = '$HOME/.claude/hooks/task-app-claude-hook.sh';
const REMOTE_CLAUDE_SETTINGS_PATH = '$HOME/.claude/settings.json';

const CLAUDE_HOOK_EVENTS = getHookEventsForProfile('claude', 'production');

/**
 * Install Orchestra Claude hook script on a remote host and merge hook entries into
 * the remote ~/.claude/settings.json without replacing unrelated remote settings.
 *
 * @param {{ host: string, projects_root?: string }} remote
 * @param {{ runSsh?: Function, timeoutMs?: number, getClaudeHookScript?: () => string, remoteApiBase?: string, localPort?: number, token?: string }} [options]
 */
async function ensureRemoteClaudeHooks(remote, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const backupTs = Date.now();
  const profile = normalizeHookProfile(options.profile);
  const hookEvents = getHookEventsForProfile('claude', profile);

  const remoteHome = (await runSsh(cfg.host, 'printf %s "$HOME"', timeoutMs)).trim();
  if (!remoteHome || remoteHome.includes('\n') || !remoteHome.startsWith('/')) {
    throw new Error('Could not resolve remote HOME');
  }

  const scriptBody =
    typeof options.getClaudeHookScript === 'function' ? options.getClaudeHookScript() : getClaudeTaskAppHookScript();
  const scriptB64 = Buffer.from(scriptBody, 'utf8').toString('base64');
  const hookScriptAbs = path.posix.join(remoteHome, '.claude', 'hooks', 'task-app-claude-hook.sh');
  const legacyHookRel = 'hooks/task-app-claude-hook.sh';

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
      if (sshClientIp && /^[\d.]+$/.test(sshClientIp)) {
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
      remoteConfigLines = buildRemoteHookConfigWriteLines({ provider: 'claude', configObj, timestampMs: backupTs });
    } catch {
      // Invalid URL — skip writing config.json on remote
    }
  }

  const settingsBackupLines = buildRemoteConfigBackupLines({
    pathExpr: 'sp',
    backupPathVar: '_claude_settings_backup',
    markerTag: 'SETTINGS',
    timestampMs: backupTs,
  });

  const py = [
    'import base64,json,os,shutil',
    'h=os.path.expanduser("~")',
    'p=os.path.join(h,".claude","hooks","task-app-claude-hook.sh")',
    'os.makedirs(os.path.dirname(p),exist_ok=True)',
    `open(p,"wb").write(base64.b64decode(${JSON.stringify(scriptB64)}))`,
    'os.chmod(p,0o755)',
    'sp=os.path.join(h,".claude","settings.json")',
    'os.makedirs(os.path.dirname(sp),exist_ok=True)',
    ...settingsBackupLines,
    'try:',
    '    settings=json.load(open(sp,"r",encoding="utf-8"))',
    'except Exception:',
    '    settings={}',
    'if not isinstance(settings,dict):',
    '    settings={}',
    'hooks=settings.get("hooks")',
    'if not isinstance(hooks,dict):',
    '    hooks={}',
    `hook_cmd=${JSON.stringify(hookScriptAbs)}`,
    `legacy_cmd=${JSON.stringify(legacyHookRel)}`,
    'def hook_matches(hook):',
    '    if not isinstance(hook,dict) or hook.get("type")!="command":',
    '        return False',
    '    cmd=hook.get("command")',
    '    return cmd==hook_cmd or cmd==legacy_cmd',
    'def ensure_hook(ev):',
    '    arr=hooks.get(ev)',
    '    if not isinstance(arr,list):',
    '        arr=[]',
    '    found=False',
    '    for entry in arr:',
    '        if not isinstance(entry,dict) or not isinstance(entry.get("hooks"),list):',
    '            continue',
    '        for hook in entry.get("hooks",[]):',
    '            if hook_matches(hook):',
    '                found=True',
    '                break',
    '        if found:',
    '            break',
    '    if not found:',
    '        arr.append({"hooks":[{"type":"command","command":hook_cmd,"timeout":10}]})',
    '    hooks[ev]=arr',
    `for ev in ${JSON.stringify(hookEvents)}:`,
    '    ensure_hook(ev)',
    'settings["hooks"]=hooks',
    'open(sp,"w",encoding="utf-8").write(json.dumps(settings,indent=2)+"\\n")',
    ...remoteConfigLines,
  ].join('\n');

  const cmd = `python3 - <<'PY'\n${py}\nPY`;
  const stdout = await runSsh(cfg.host, cmd, timeoutMs);

  const settingsJsonAbs = path.posix.join(remoteHome, '.claude', 'settings.json');

  return {
    ok: true,
    host: cfg.host,
    hook_script: hookScriptAbs,
    settings_json: settingsJsonAbs,
    settings_backup: parseRemoteBackupMarker(stdout, 'SETTINGS'),
    att_config_backup: parseRemoteBackupMarker(stdout, 'ATT_CONFIG'),
    profile,
    hook_events: hookEvents,
  };
}

/**
 * Clear the `permissions` block in a remote host's ~/.claude/settings.json so the permission
 * scenario's tools (Bash/Write/Read/...) actually raise a gate instead of being auto-approved.
 * Only the `permissions` key is replaced — `hooks` (and everything else the tunnel install merged
 * in) is preserved. Returns a snapshot with the original file bytes so restore is byte-exact.
 *
 * @param {{ host: string }} remote
 * @param {{ runSsh?: Function, timeoutMs?: number }} [options]
 * @returns {Promise<{ host: string, existed: boolean, textB64: string, settingsPath: string|null }>}
 */
async function clearRemoteClaudePermissions(remote, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const py = [
    'import base64,json,os',
    'h=os.path.expanduser("~")',
    'sp=os.path.join(h,".claude","settings.json")',
    'existed=os.path.exists(sp)',
    'orig=open(sp,"rb").read() if existed else b""',
    'print("SNAPSHOT_EXISTED:"+("1" if existed else "0"))',
    'print("SNAPSHOT_B64:"+base64.b64encode(orig).decode("ascii"))',
    'try:',
    '    settings=json.loads(orig.decode("utf-8")) if orig.strip() else {}',
    'except Exception:',
    '    settings={}',
    'if not isinstance(settings,dict):',
    '    settings={}',
    'settings["permissions"]={"allow":[],"ask":[]}',
    'os.makedirs(os.path.dirname(sp),exist_ok=True)',
    'open(sp,"w",encoding="utf-8").write(json.dumps(settings,indent=2)+"\\n")',
    'print("SNAPSHOT_PATH:"+sp)',
  ].join('\n');
  const stdout = String(await runSsh(cfg.host, `python3 - <<'PY'\n${py}\nPY`, timeoutMs));
  const b64 = stdout.match(/SNAPSHOT_B64:([A-Za-z0-9+/=]*)/);
  const sp = stdout.match(/SNAPSHOT_PATH:(.+)/);
  return {
    host: cfg.host,
    existed: /SNAPSHOT_EXISTED:1/.test(stdout),
    textB64: b64 ? b64[1] : '',
    settingsPath: sp ? sp[1].trim() : null,
  };
}

/**
 * Restore a remote ~/.claude/settings.json from a {@link clearRemoteClaudePermissions} snapshot:
 * write the original bytes back, or remove the file if it did not exist before.
 *
 * @param {{ host: string, existed: boolean, textB64: string }} snapshot
 * @param {{ runSsh?: Function, timeoutMs?: number }} [options]
 */
async function restoreRemoteClaudePermissions(snapshot, options = {}) {
  if (!snapshot || !snapshot.host) return { restored: false };
  const runSsh = options.runSsh || createSshRunner();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const py = [
    'import base64,os',
    'h=os.path.expanduser("~")',
    'sp=os.path.join(h,".claude","settings.json")',
    `data=base64.b64decode(${JSON.stringify(snapshot.textB64 || '')})`,
    `if ${snapshot.existed ? 'True' : 'False'}:`,
    '    os.makedirs(os.path.dirname(sp),exist_ok=True)',
    '    open(sp,"wb").write(data)',
    'else:',
    '    try:',
    '        os.remove(sp)',
    '    except FileNotFoundError:',
    '        pass',
    'print("RESTORED")',
  ].join('\n');
  const stdout = String(await runSsh(snapshot.host, `python3 - <<'PY'\n${py}\nPY`, timeoutMs));
  return { restored: /RESTORED/.test(stdout), host: snapshot.host };
}

module.exports = {
  ensureRemoteClaudeHooks,
  clearRemoteClaudePermissions,
  restoreRemoteClaudePermissions,
  REMOTE_CLAUDE_HOOK_SCRIPT_PATH,
  REMOTE_CLAUDE_SETTINGS_PATH,
  CLAUDE_HOOK_EVENTS,
};
