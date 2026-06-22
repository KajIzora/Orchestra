const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const SQLITE_BIN = '/usr/bin/sqlite3';

const KNOWN_BROWSER_APP_IDS = new Set([
  'com.google.chrome',
  'com.apple.safari',
  'company.thebrowser.browser',
  'com.brave.browser',
  'org.mozilla.firefox',
]);

function defaultNotificationTracking(provider) {
  return {
    kind: 'notification',
    provider,
    linked_at: new Date().toISOString(),
    since_rec_id: 0,
    last_seen_rec_id: 0,
    last_checked_at: null,
    last_error: null,
  };
}

function normalizeNotificationTracking(input) {
  if (!input || typeof input !== 'object') return null;
  const provider = input.provider === 'claude' ? 'claude' : input.provider === 'chatgpt' ? 'chatgpt' : null;
  if (!provider) return null;
  return {
    ...defaultNotificationTracking(provider),
    ...input,
    kind: 'notification',
    provider,
    since_rec_id: normalizeRecId(input.since_rec_id),
    last_seen_rec_id: normalizeRecId(input.last_seen_rec_id),
    last_checked_at: input.last_checked_at || null,
    last_error: input.last_error || null,
  };
}

function normalizeRecId(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return parsed;
}

function getNotificationDbCandidates(homeDir = os.homedir(), tempDir = os.tmpdir()) {
  const legacyRoot = path.resolve(path.join(tempDir, '..'));
  return [
    path.join(homeDir, 'Library', 'Group Containers', 'group.com.apple.usernoted', 'db2', 'db'),
    path.join(legacyRoot, '0', 'com.apple.notificationcenter', 'db2', 'db'),
  ];
}

function resolveNotificationDbPath(homeDir = os.homedir(), tempDir = os.tmpdir()) {
  const candidates = getNotificationDbCandidates(homeDir, tempDir);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function runSqliteJson(dbPath, sql) {
  const args = ['-readonly', '-json', dbPath, sql];
  const { stdout } = await execFileAsync(SQLITE_BIN, args, { timeout: 5000 });
  const trimmed = (stdout || '').trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function getLatestNotificationRecId() {
  const dbPath = resolveNotificationDbPath();
  if (!dbPath) return { maxRecId: 0, error: null };
  try {
    const rows = await runSqliteJson(dbPath, 'SELECT IFNULL(MAX(rec_id), 0) AS max_rec_id FROM record;');
    const maxRecId = normalizeRecId(rows[0]?.max_rec_id);
    return { maxRecId, error: null };
  } catch (err) {
    return { maxRecId: 0, error: normalizeDbError(err) };
  }
}

async function findMatchingProviderNotification({ provider, sinceRecId = 0 }) {
  const dbPath = resolveNotificationDbPath();
  if (!dbPath) {
    return { latestRecId: normalizeRecId(sinceRecId), matchedEvent: null, error: 'Notification database not found' };
  }
  const minRecId = normalizeRecId(sinceRecId);
  const sql =
    "SELECT record.rec_id AS rec_id, app.identifier AS app_identifier, hex(record.data) AS data_hex " +
    "FROM record LEFT JOIN app ON app.app_id = record.app_id " +
    `WHERE record.rec_id > ${minRecId} ` +
    'ORDER BY record.rec_id ASC LIMIT 200;';
  try {
    const rows = await runSqliteJson(dbPath, sql);
    let latestRecId = minRecId;
    for (const row of rows) {
      const recId = normalizeRecId(row.rec_id);
      if (recId > latestRecId) latestRecId = recId;
      const event = {
        rec_id: recId,
        app_identifier: String(row.app_identifier || ''),
        data_text: extractSearchableTextFromHex(row.data_hex),
      };
      if (isProviderNotificationEvent(provider, event)) {
        return { latestRecId, matchedEvent: event, error: null };
      }
    }
    return { latestRecId, matchedEvent: null, error: null };
  } catch (err) {
    return { latestRecId: minRecId, matchedEvent: null, error: normalizeDbError(err) };
  }
}

function isProviderNotificationEvent(provider, event) {
  const appId = (event.app_identifier || '').toLowerCase();
  const text = (event.data_text || '').toLowerCase();
  const hasChatGptToken = includesAny(text, ['chatgpt', 'openai']);
  const hasClaudeToken = includesAny(text, ['claude', 'anthropic']);

  if (provider === 'chatgpt') {
    if (includesAny(appId, ['chatgpt', 'openai'])) return true;
    if (KNOWN_BROWSER_APP_IDS.has(appId) && hasChatGptToken) return true;
    return false;
  }
  if (provider === 'claude') {
    if (includesAny(appId, ['claude', 'anthropic'])) return true;
    if (KNOWN_BROWSER_APP_IDS.has(appId) && hasClaudeToken) return true;
    return false;
  }
  return false;
}

function includesAny(value, terms) {
  return terms.some((term) => value.includes(term));
}

function extractSearchableTextFromHex(dataHex) {
  if (!dataHex || typeof dataHex !== 'string') return '';
  try {
    const cleanHex = dataHex.replace(/\s+/g, '');
    const decoded = Buffer.from(cleanHex, 'hex').toString('utf8');
    return decoded.replace(/[^\x20-\x7E]+/g, ' ').trim();
  } catch {
    return '';
  }
}

function normalizeDbError(err) {
  const message = err?.message || String(err);
  if (message.includes('unable to open database file') || message.includes('permission denied')) {
    return 'Notification access denied. Grant Full Disk Access to the app and restart it.';
  }
  return message;
}

module.exports = {
  defaultNotificationTracking,
  normalizeNotificationTracking,
  getLatestNotificationRecId,
  findMatchingProviderNotification,
  isProviderNotificationEvent,
  extractSearchableTextFromHex,
  getNotificationDbCandidates,
  resolveNotificationDbPath,
  KNOWN_BROWSER_APP_IDS,
};
