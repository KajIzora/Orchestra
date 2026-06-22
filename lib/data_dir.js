const os = require('os');
const path = require('path');

/** Legacy default when ORCHESTRA_DATA_DIR is unset. */
const LEGACY_DIR_NAME = '.agent-task-tracker';

/** Dev instance (browser + agents) — set by ./dev-start.sh */
const DEV_DIR_NAME = '.orchestra/dev';

/** Stable desktop instance — baked into packaged app via ./stable-update.sh */
const STABLE_DIR_NAME = '.orchestra/stable';

function expandHome(value) {
  if (typeof value !== 'string' || !value.trim()) return value;
  const trimmed = value.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

/**
 * Resolve Orchestra state directory (data.json, config.json, hook tokens).
 * Override with ORCHESTRA_DATA_DIR (supports ~/…).
 */
function resolveDataDir(env = process.env) {
  const fromEnv = env.ORCHESTRA_DATA_DIR;
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return path.resolve(expandHome(fromEnv.trim()));
  }
  return path.join(os.homedir(), LEGACY_DIR_NAME);
}

function configFilePath(env = process.env) {
  return path.join(resolveDataDir(env), 'config.json');
}

function dataFilePath(env = process.env) {
  return path.join(resolveDataDir(env), 'data.json');
}

function hookTokensFilePath(env = process.env) {
  return path.join(resolveDataDir(env), 'hook-tokens.json');
}

function electronDesktopLogPath(env = process.env) {
  return path.join(resolveDataDir(env), 'electron-desktop.log');
}

module.exports = {
  LEGACY_DIR_NAME,
  DEV_DIR_NAME,
  STABLE_DIR_NAME,
  expandHome,
  resolveDataDir,
  configFilePath,
  dataFilePath,
  hookTokensFilePath,
  electronDesktopLogPath,
};
