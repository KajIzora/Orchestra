const path = require('path');
const { assertValidRemoteSource, createSshRunner } = require('./remote_cursor_tracker');
const { getGeminiTaskAppHookScript } = require('./gemini_hook_script');
const {
  buildRemoteHookConfigWriteLines,
  buildRemoteConfigBackupLines,
  parseRemoteBackupMarker,
} = require('./remote_hook_config');
const { getHookEventsForProfile, normalizeHookProfile } = require('./signal_registry');

const DEFAULT_TIMEOUT_MS = 3000;
const REMOTE_GEMINI_HOOK_SCRIPT_PATH = '$HOME/.gemini/hooks/task-app-gemini-hook.sh';
const REMOTE_GEMINI_AGY_HOOKS_JSON_PATH = '$HOME/.gemini/config/hooks.json';
const REMOTE_GEMINI_SETTINGS_PATH = '$HOME/.gemini/settings.json';
const AGY_HOOK_EVENTS = getHookEventsForProfile('gemini', 'production');
const AGY_LIFECYCLE_HOOK_EVENTS = ['PreInvocation', 'PostInvocation', 'Stop'];
const AGY_TOOL_HOOK_EVENTS = ['PreToolUse', 'PostToolUse'];

/**
 * Install Orchestra agy CLI hook script on a remote host and merge hook entries into
 * ~/.gemini/config/hooks.json (event name passed as argv to the forwarder).
 *
 * @param {{ host: string, projects_root?: string }} remote
 * @param {{ runSsh?: Function, timeoutMs?: number, getGeminiHookScript?: () => string, remoteApiBase?: string, localPort?: number, token?: string, appToken?: string }} [options]
 */
async function ensureRemoteGeminiHooks(remote, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const profile = normalizeHookProfile(options.profile);
  const hookEvents = getHookEventsForProfile('gemini', profile);
  const lifecycleEvents = hookEvents.filter((ev) => !AGY_TOOL_HOOK_EVENTS.includes(ev));
  const toolEvents = hookEvents.filter((ev) => AGY_TOOL_HOOK_EVENTS.includes(ev));

  const backupTs = Date.now();
  const remoteHome = (await runSsh(cfg.host, 'printf %s "$HOME"', timeoutMs)).trim();
  if (!remoteHome || remoteHome.includes('\n') || !remoteHome.startsWith('/')) {
    throw new Error('Could not resolve remote HOME');
  }

  const scriptBody =
    typeof options.getGeminiHookScript === 'function' ? options.getGeminiHookScript() : getGeminiTaskAppHookScript();
  const scriptB64 = Buffer.from(scriptBody, 'utf8').toString('base64');
  const hookScriptAbs = path.posix.join(remoteHome, '.gemini', 'hooks', 'task-app-gemini-hook.sh');
  const agyHooksJsonAbs = path.posix.join(remoteHome, '.gemini', 'config', 'hooks.json');

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
  const remoteAppToken =
    typeof options.appToken === 'string' && options.appToken.trim() ? options.appToken.trim() : null;

  let remoteConfigLines = [];
  if (resolvedApiBase) {
    try {
      const u = new URL(resolvedApiBase);
      const apiHost = u.hostname;
      const apiPort = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
      const configObj = { host: apiHost, port: apiPort, remote_host: cfg.host };
      if (remoteToken) configObj.token = remoteToken;
      if (remoteAppToken) configObj.app_token = remoteAppToken;
      remoteConfigLines = buildRemoteHookConfigWriteLines({ provider: 'gemini', configObj, timestampMs: backupTs });
    } catch {
      // Invalid URL — skip writing config.json on remote
    }
  }

  const agyHooksBackupLines = buildRemoteConfigBackupLines({
    pathExpr: 'hp',
    backupPathVar: '_agy_hooks_backup',
    markerTag: 'AGY_HOOKS',
    timestampMs: backupTs,
  });

  const py = [
    'import base64,json,os,shutil',
    'h=os.path.expanduser("~")',
    'p=os.path.join(h,".gemini","hooks","task-app-gemini-hook.sh")',
    'os.makedirs(os.path.dirname(p),exist_ok=True)',
    `open(p,"wb").write(base64.b64decode(${JSON.stringify(scriptB64)}))`,
    'os.chmod(p,0o755)',
    'hp=os.path.join(h,".gemini","config","hooks.json")',
    'os.makedirs(os.path.dirname(hp),exist_ok=True)',
    ...agyHooksBackupLines,
    'try:',
    '    hooks_cfg=json.load(open(hp,"r",encoding="utf-8"))',
    'except Exception:',
    '    hooks_cfg={}',
    'if not isinstance(hooks_cfg,dict):',
    '    hooks_cfg={}',
    'hooks=hooks_cfg.get("hooks")',
    'if not isinstance(hooks,dict):',
    '    hooks={}',
    'task_hooks=hooks_cfg.get("task-app-hooks")',
    'if not isinstance(task_hooks,dict):',
    '    task_hooks={}',
    'task_hooks["enabled"]=True',
    `hook_script=${JSON.stringify(hookScriptAbs)}`,
    'def strip_hook_cmd(arr, cmd):',
    '    if not isinstance(arr,list):',
    '        return []',
    '    out=[]',
    '    for entry in arr:',
    '        if not isinstance(entry,dict):',
    '            out.append(entry)',
    '            continue',
    '        if entry.get("type")=="command" and entry.get("command")==cmd:',
    '            continue',
    '        hs=entry.get("hooks")',
    '        if not isinstance(hs,list):',
    '            out.append(entry)',
    '            continue',
    '        kept=[]',
    '        for h in hs:',
    '            if isinstance(h,dict) and h.get("type")=="command" and h.get("command")==cmd:',
    '                continue',
    '            kept.append(h)',
    '        if kept:',
    '            e=dict(entry)',
    '            e["hooks"]=kept',
    '            out.append(e)',
    '    return out',
    'def ensure_lifecycle_direct(ev):',
    '    arr=task_hooks.get(ev)',
    '    if not isinstance(arr,list):',
    '        arr=[]',
    '    cmd=hook_script+" "+ev',
    '    found=False',
    '    for entry in arr:',
    '        if isinstance(entry,dict) and entry.get("type")=="command" and entry.get("command")==cmd:',
    '            found=True',
    '            break',
    '    if not found:',
    '        arr.append({"type":"command","command":cmd})',
    '    task_hooks[ev]=arr',
    'def ensure_tool_matcher(ev):',
    '    arr=hooks.get(ev)',
    '    if not isinstance(arr,list):',
    '        arr=[]',
    '    cmd=hook_script+" "+ev',
    '    found=False',
    '    for entry in arr:',
    '        if not isinstance(entry,dict) or not isinstance(entry.get("hooks"),list):',
    '            continue',
    '        for hook in entry.get("hooks",[]):',
    '            if isinstance(hook,dict) and hook.get("type")=="command" and hook.get("command")==cmd:',
    '                found=True',
    '                break',
    '        if found:',
    '            break',
    '    if not found:',
    '        arr.append({"matcher":"*","hooks":[{"name":"task-app-"+ev.lower(),"type":"command","command":cmd}]})',
    '    hooks[ev]=arr',
    `for ev in ${JSON.stringify(lifecycleEvents)}:`,
    '    cmd=hook_script+" "+ev',
    '    ensure_lifecycle_direct(ev)',
    '    cleaned=strip_hook_cmd(hooks.get(ev), cmd)',
    '    if cleaned:',
    '        hooks[ev]=cleaned',
    '    else:',
    '        hooks.pop(ev, None)',
    `for ev in ${JSON.stringify(toolEvents)}:`,
    '    cmd=hook_script+" "+ev',
    '    ensure_tool_matcher(ev)',
    '    cleaned=strip_hook_cmd(task_hooks.get(ev), cmd)',
    '    if cleaned:',
    '        task_hooks[ev]=cleaned',
    '    else:',
    '        task_hooks.pop(ev, None)',
    'hooks_cfg["hooks"]=hooks',
    'hooks_cfg["task-app-hooks"]=task_hooks',
    'open(hp,"w",encoding="utf-8").write(json.dumps(hooks_cfg,indent=2)+"\\n")',
    ...remoteConfigLines,
  ].join('\n');

  const cmd = `python3 - <<'PY'\n${py}\nPY`;
  const stdout = await runSsh(cfg.host, cmd, timeoutMs);

  return {
    ok: true,
    host: cfg.host,
    hook_script: hookScriptAbs,
    agy_hooks_json: agyHooksJsonAbs,
    agy_hooks_backup: parseRemoteBackupMarker(stdout, 'AGY_HOOKS'),
    att_config_backup: parseRemoteBackupMarker(stdout, 'ATT_CONFIG'),
    profile,
    hook_events: hookEvents,
  };
}

module.exports = {
  ensureRemoteGeminiHooks,
  REMOTE_GEMINI_HOOK_SCRIPT_PATH,
  REMOTE_GEMINI_AGY_HOOKS_JSON_PATH,
  REMOTE_GEMINI_SETTINGS_PATH,
  AGY_HOOK_EVENTS,
};
