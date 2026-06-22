const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { hookTokensFilePath } = require('./data_dir');

const KNOWN_PROVIDERS = new Set(['gemini', 'claude', 'codex', 'cursor']);
const DEFAULT_TOKEN_PATH = hookTokensFilePath();

/** Bind addresses treated as local-only (no LAN exposure). */
const LOCAL_BIND_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function isLocalBindHost(host) {
  if (typeof host !== 'string' || !host.trim()) return false;
  return LOCAL_BIND_HOSTS.has(host.trim().toLowerCase());
}

function isLoopbackClient(req) {
  const ip = (req.socket && req.socket.remoteAddress) || req.ip || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * Orchestra app token: proves the caller is allowed to use write/config APIs when the
 * server is bound to a non-local address. Persisted beside hook tokens as `app`.
 * Override with ORCHESTRA_APP_TOKEN for stable values across restarts.
 */
function getOrCreateAppToken() {
  const fromEnv = process.env.ORCHESTRA_APP_TOKEN;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  const tokens = readTokens();
  const existing = tokens.app;
  if (typeof existing === 'string' && existing.trim()) return existing.trim();
  const fresh = crypto.randomBytes(24).toString('hex');
  tokens.app = fresh;
  try {
    writeTokens(tokens);
  } catch {
    // If we can't persist, fall back to an ephemeral token so the server still works.
  }
  return fresh;
}

function extractAppToken(req) {
  const header =
    (typeof req.get === 'function' && (req.get('x-orchestra-app-token') || req.get('x-orchestra-token'))) ||
    null;
  const bodyToken = req.body && typeof req.body === 'object' ? req.body.app_token || req.body.token : undefined;
  const q = req.query && typeof req.query === 'object' ? req.query.app_token || req.query.token : undefined;
  const t = header || bodyToken || q;
  return typeof t === 'string' ? t : '';
}

function verifyAppToken(req, expectedToken) {
  const provided = extractAppToken(req);
  return Boolean(provided && provided === expectedToken);
}

function tokenPath() {
  return process.env.ORCHESTRA_HOOK_TOKEN_FILE
    ? path.resolve(process.env.ORCHESTRA_HOOK_TOKEN_FILE)
    : DEFAULT_TOKEN_PATH;
}

function readTokens() {
  let raw;
  try {
    raw = fs.readFileSync(tokenPath(), 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v.trim()) out[k] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}

function writeTokens(tokens) {
  const file = tokenPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort; file may be on a filesystem that ignores chmod
  }
}

function getOrCreateHookToken(provider) {
  if (!KNOWN_PROVIDERS.has(provider)) {
    throw new Error(`Unknown hook provider: ${provider}`);
  }
  const tokens = readTokens();
  const existing = tokens[provider];
  if (typeof existing === 'string' && existing.trim()) return existing.trim();
  const fresh = crypto.randomBytes(24).toString('hex');
  tokens[provider] = fresh;
  try {
    writeTokens(tokens);
  } catch {
    // If we can't persist, fall back to an ephemeral token so the server still works.
  }
  return fresh;
}

module.exports = {
  KNOWN_PROVIDERS,
  DEFAULT_TOKEN_PATH,
  LOCAL_BIND_HOSTS,
  tokenPath,
  readTokens,
  writeTokens,
  isLocalBindHost,
  isLoopbackClient,
  getOrCreateAppToken,
  extractAppToken,
  verifyAppToken,
  getOrCreateHookToken,
};
