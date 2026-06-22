const {
  resolveLocalWorkspaceRootsRealpath,
  normalizeRemoteWorkspaceRootsPosix,
  isCwdUnderAnyLocalRoot,
  isCwdUnderAnyPosixRoot,
} = require('./process_tracker');

function normalizePathList(paths) {
  const list = Array.isArray(paths) ? paths : [paths];
  return list.map((p) => String(p || '').trim()).filter(Boolean);
}

/**
 * True when any candidate path is the same as or under one of the configured local roots.
 * Empty configuredRoots means no filter (always true).
 */
function anyLocalPathUnderConfiguredRoots(configuredRoots, paths) {
  const roots = normalizePathList(configuredRoots);
  if (!roots.length) return true;
  const candidates = normalizePathList(paths);
  if (!candidates.length) return false;
  const resolvedRoots = resolveLocalWorkspaceRootsRealpath(roots);
  return candidates.some((candidate) => isCwdUnderAnyLocalRoot(resolvedRoots, candidate));
}

/**
 * True when any candidate POSIX path is the same as or under one of the configured remote roots.
 * Empty configuredRoots means no filter (always true).
 */
function anyPosixPathUnderConfiguredRoots(configuredRoots, paths) {
  const roots = normalizePathList(configuredRoots);
  if (!roots.length) return true;
  const candidates = normalizePathList(paths);
  if (!candidates.length) return false;
  const posixRoots = normalizeRemoteWorkspaceRootsPosix(roots);
  return candidates.some((candidate) => isCwdUnderAnyPosixRoot(posixRoots, candidate));
}

module.exports = {
  anyLocalPathUnderConfiguredRoots,
  anyPosixPathUnderConfiguredRoots,
};
