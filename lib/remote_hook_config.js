const fs = require('fs');

/**
 * Suffix for timestamped Orchestra config backups.
 * @param {number} [timestampMs]
 */
function orchestraBackupSuffix(timestampMs = Date.now()) {
  return `.orchestra-backup-${timestampMs}`;
}

/**
 * Copy an existing local config file before Orchestra modifies it.
 * @param {string} filePath
 * @returns {string|null} backup path, or null when the source file did not exist
 */
function backupLocalHookConfigFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const backupPath = filePath + orchestraBackupSuffix();
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

/**
 * Parse a backup path marker printed by remote installer Python.
 * @param {string} stdout
 * @param {string} tag e.g. SETTINGS, HOOKS_JSON
 */
function parseRemoteBackupMarker(stdout, tag) {
  const re = new RegExp(`__ORCHESTRA_BACKUP_${tag}__:([^\\n]+)`);
  const m = String(stdout || '').match(re);
  if (!m) return null;
  const value = m[1].trim();
  return value || null;
}

/**
 * Python lines: backup config at pathExpr when it exists (sets backupPathVar).
 * Requires `import shutil` in the surrounding script.
 *
 * @param {{ pathExpr: string, backupPathVar?: string, markerTag: string, timestampMs?: number }} opts
 */
function buildRemoteConfigBackupLines({
  pathExpr,
  backupPathVar = '_orchestra_cfg_backup',
  markerTag,
  timestampMs,
}) {
  if (!markerTag || typeof markerTag !== 'string') {
    throw new Error('buildRemoteConfigBackupLines: markerTag required');
  }
  const ts = Number.isFinite(timestampMs) ? timestampMs : Date.now();
  const suffixLit = JSON.stringify(orchestraBackupSuffix(ts));
  const markerLit = JSON.stringify(`__ORCHESTRA_BACKUP_${markerTag}__:`);
  return [
    `${backupPathVar}=None`,
    `if os.path.isfile(${pathExpr}):`,
    `    ${backupPathVar}=${pathExpr}+${suffixLit}`,
    `    shutil.copy2(${pathExpr}, ${backupPathVar})`,
    `    print(${markerLit}+${backupPathVar})`,
  ];
}

/**
 * Build Python lines (inside the heredoc each remote installer already runs)
 * that read-modify-write `~/.agent-task-tracker/config.json` on the remote host.
 *
 * The remote hook script fans an event back to every Orchestra app that has
 * installed hooks on this host. To support that, we maintain a `targets[]` list
 * — one entry per app instance, keyed by (host, port) — and upsert this
 * instance's entry (merging `tokens.<provider>` without clobbering the other
 * instance's tokens). Stale entries not refreshed in 3 days are pruned so the
 * list does not grow without bound across port changes.
 *
 * The legacy top-level `host`/`port`/`token`/`tokens` fields are still written
 * (pointing at this instance) for backward compatibility with hook scripts that
 * predate `targets[]`.
 *
 * Pre-requisite: the surrounding heredoc must already `import base64,json,os,shutil`.
 */
function buildRemoteHookConfigWriteLines({ provider, configObj, timestampMs }) {
  if (typeof provider !== 'string' || !provider.trim()) {
    throw new Error('buildRemoteHookConfigWriteLines: provider required');
  }
  if (!configObj || typeof configObj !== 'object') {
    throw new Error('buildRemoteHookConfigWriteLines: configObj required');
  }
  const providerLit = JSON.stringify(provider.trim());
  const incomingB64 = Buffer.from(JSON.stringify(configObj), 'utf8').toString('base64');
  const ts = Number.isFinite(timestampMs) ? timestampMs : Date.now();
  const suffixLit = JSON.stringify(orchestraBackupSuffix(ts));
  return [
    'import time as _time',
    'cp=os.path.join(h,".agent-task-tracker","config.json")',
    'os.makedirs(os.path.dirname(cp),exist_ok=True)',
    '_att_cfg_backup=None',
    'if os.path.isfile(cp):',
    `    _att_cfg_backup=cp+${suffixLit}`,
    '    shutil.copy2(cp,_att_cfg_backup)',
    '    print("__ORCHESTRA_BACKUP_ATT_CONFIG__:"+_att_cfg_backup)',
    'try:',
    '    existing=json.load(open(cp,"r",encoding="utf-8"))',
    '    if not isinstance(existing,dict):',
    '        existing={}',
    'except Exception:',
    '    existing={}',
    `incoming=json.loads(base64.b64decode(${JSON.stringify(incomingB64)}).decode("utf-8"))`,
    'merged=dict(existing)',
    '# Legacy top-level fields (back-compat with pre-targets hook scripts).',
    'for k in ("host","port","remote_host","app_token","appToken"):',
    '    if k in incoming:',
    '        merged[k]=incoming[k]',
    'tokens=merged.get("tokens") if isinstance(merged.get("tokens"),dict) else {}',
    `if isinstance(incoming.get("token"),str) and incoming["token"].strip():`,
    `    tokens[${providerLit}]=incoming["token"]`,
    `    merged["token"]=incoming["token"]`,
    'merged["tokens"]=tokens',
    '# Upsert this instance into targets[] (one entry per app, keyed by host:port).',
    '_now=int(_time.time())',
    '_tgts=merged.get("targets") if isinstance(merged.get("targets"),list) else []',
    '_tgts=[e for e in _tgts if isinstance(e,dict) and e.get("port") and (_now-int(e.get("updated_at") or 0))<259200]',
    '_ihost=incoming.get("host")',
    '_iport=incoming.get("port")',
    '_entry=None',
    'for e in _tgts:',
    '    if e.get("host")==_ihost and e.get("port")==_iport:',
    '        _entry=e',
    '        break',
    'if _entry is None:',
    '    _entry={"host":_ihost,"port":_iport}',
    '    _tgts.append(_entry)',
    'if "remote_host" in incoming:',
    '    _entry["remote_host"]=incoming["remote_host"]',
    'for k in ("app_token","appToken"):',
    '    if k in incoming:',
    '        _entry[k]=incoming[k]',
    '_etoks=_entry.get("tokens") if isinstance(_entry.get("tokens"),dict) else {}',
    `if isinstance(incoming.get("token"),str) and incoming["token"].strip():`,
    `    _etoks[${providerLit}]=incoming["token"]`,
    '_entry["tokens"]=_etoks',
    '_entry["updated_at"]=_now',
    'merged["targets"]=_tgts',
    'open(cp,"w",encoding="utf-8").write(json.dumps(merged))',
  ];
}

module.exports = {
  orchestraBackupSuffix,
  backupLocalHookConfigFile,
  parseRemoteBackupMarker,
  buildRemoteConfigBackupLines,
  buildRemoteHookConfigWriteLines,
};
