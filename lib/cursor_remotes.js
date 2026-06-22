const crypto = require('crypto');
const path = require('path');
const { assertValidRemoteSource } = require('./remote_cursor_tracker');
const { workspacePathToProjectSlug } = require('./cursor_tracker');

function newRemoteId() {
  return crypto.randomUUID();
}

function normalizeRemoteRow(raw, options = {}) {
  const row = raw && typeof raw === 'object' ? raw : {};
  let id = typeof row.id === 'string' ? row.id.trim() : '';
  if (!id && options.generateId) id = newRemoteId();
  const host = typeof row.host === 'string' ? row.host.trim() : '';
  const projects_root = typeof row.projects_root === 'string' ? row.projects_root.trim() : '';
  if (!host) throw new Error('Each cursor_remotes entry needs a host');
  const cfg = assertValidRemoteSource({ host, projects_root: projects_root || undefined });
  if (!id) throw new Error('Each cursor_remotes entry needs an id');
  const normalized = { id, host: cfg.host, projects_root: cfg.projects_root };
  const remote_hook_tunnel_port = Number(row.remote_hook_tunnel_port);
  if (Number.isInteger(remote_hook_tunnel_port) && remote_hook_tunnel_port > 0 && remote_hook_tunnel_port <= 65535) {
    normalized.remote_hook_tunnel_port = remote_hook_tunnel_port;
  }
  if (typeof row.remote_hook_tunnel_api_base === 'string' && row.remote_hook_tunnel_api_base.trim()) {
    normalized.remote_hook_tunnel_api_base = row.remote_hook_tunnel_api_base.trim();
  }
  return normalized;
}

function dedupeRemoteIds(rows) {
  const seen = new Set();
  return rows.map((r) => {
    let { id } = r;
    if (seen.has(id)) id = newRemoteId();
    seen.add(id);
    return { ...r, id };
  });
}

/** Normalize persisted `cursor_remotes`, migrate legacy `cursor_remote`, sync primary `cursor_remote`. */
function normalizeStoredCursorRemotes(project) {
  let rows = [];
  if (Array.isArray(project.cursor_remotes) && project.cursor_remotes.length) {
    for (const r of project.cursor_remotes) {
      try {
        rows.push(normalizeRemoteRow(r, { generateId: true }));
      } catch {
        // skip invalid
      }
    }
  }
  if (!rows.length && project.cursor_remote && typeof project.cursor_remote === 'object') {
    try {
      const cfg = assertValidRemoteSource(project.cursor_remote);
      rows = [{ id: newRemoteId(), host: cfg.host, projects_root: cfg.projects_root }];
    } catch {
      rows = [];
    }
  }
  rows = dedupeRemoteIds(rows);
  project.cursor_remotes = rows;
  project.cursor_remote = rows[0] ? { host: rows[0].host, projects_root: rows[0].projects_root } : null;
}

function assignProjectCursorRemotes(project, rows) {
  const normalized = dedupeRemoteIds(
    (Array.isArray(rows) ? rows : []).map((r) => normalizeRemoteRow(r, { generateId: true }))
  );
  project.cursor_remotes = normalized;
  project.cursor_remote = normalized[0] ? { host: normalized[0].host, projects_root: normalized[0].projects_root } : null;
}

function getProjectRemoteList(project) {
  if (Array.isArray(project.cursor_remotes) && project.cursor_remotes.length) return project.cursor_remotes;
  if (project.cursor_remote && project.cursor_remote.host) return [project.cursor_remote];
  return [];
}

function resolveCursorRemoteEntry(project, remoteId) {
  const remotes = getProjectRemoteList(project);
  if (!remotes.length) return null;
  const rid = typeof remoteId === 'string' ? remoteId.trim() : '';
  if (rid) {
    const hit = remotes.find((r) => r && r.id === rid);
    if (hit) return assertValidRemoteSource(hit);
  }
  return assertValidRemoteSource(remotes[0]);
}

/** When `remoteId` is non-empty, require a matching row (no fallback to first host). */
function resolveCursorRemoteEntryStrict(project, remoteId) {
  const rid = typeof remoteId === 'string' ? remoteId.trim() : '';
  if (!rid) return null;
  const remotes = getProjectRemoteList(project);
  const hit = remotes.find((r) => r && r.id === rid);
  if (!hit) throw new Error('Unknown remote_id for this project');
  return assertValidRemoteSource(hit);
}

function remoteConfigKey(cfg) {
  const c = assertValidRemoteSource(cfg);
  return `${c.host}\0${c.projects_root}`;
}

/** @returns {Map<string, { remote: ReturnType<typeof assertValidRemoteSource>, paths: string[] }>} */
function groupSshWorkspacePathsByRemote(project) {
  const map = new Map();
  const workspaces = Array.isArray(project?.cursor_workspaces) ? project.cursor_workspaces : [];
  for (const w of workspaces) {
    if (!w || w.source !== 'ssh' || typeof w.workspace_path !== 'string') continue;
    let cfg;
    try {
      cfg = resolveCursorRemoteEntry(project, w.remote_id);
    } catch {
      continue;
    }
    const key = remoteConfigKey(cfg);
    const trimmed = w.workspace_path.trim();
    if (!trimmed) continue;
    if (!map.has(key)) map.set(key, { remote: cfg, paths: [] });
    map.get(key).paths.push(trimmed);
  }
  return map;
}

function workspaceRootsForRemoteConfig(project, remoteCfg) {
  const key = remoteConfigKey(remoteCfg);
  const bucket = groupSshWorkspacePathsByRemote(project).get(key);
  if (!bucket) return [];
  return [...new Set(bucket.paths)];
}

/** Used when listing hook runs: match remote events to configured SSH workspace rows. */
function buildSshWorkspaceMatchers(project) {
  const matchers = [];
  const workspaces = Array.isArray(project?.cursor_workspaces) ? project.cursor_workspaces : [];
  for (const w of workspaces) {
    if (!w || w.source !== 'ssh' || typeof w.workspace_path !== 'string') continue;
    let cfg;
    try {
      cfg = resolveCursorRemoteEntry(project, w.remote_id);
    } catch {
      continue;
    }
    const slug = workspacePathToProjectSlug(w.workspace_path, 'ssh');
    if (!slug) continue;
    matchers.push({ host: cfg.host, slug });
  }
  return matchers;
}

module.exports = {
  newRemoteId,
  normalizeRemoteRow,
  normalizeStoredCursorRemotes,
  assignProjectCursorRemotes,
  getProjectRemoteList,
  resolveCursorRemoteEntry,
  resolveCursorRemoteEntryStrict,
  remoteConfigKey,
  groupSshWorkspacePathsByRemote,
  workspaceRootsForRemoteConfig,
  buildSshWorkspaceMatchers,
};
