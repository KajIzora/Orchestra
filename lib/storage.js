const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { resolveDataDir } = require('./data_dir');

const DEFAULT_STATE = { version: 1, projects: [] };
const WRITE_DEBOUNCE_MS = 200;

let state = null;
let writeTimer = null;
let dirty = false;
let writingPromise = null;

function getPaths() {
  const DATA_DIR = resolveDataDir();
  return {
    DATA_DIR,
    DATA_FILE: path.join(DATA_DIR, 'data.json'),
    CONFIG_FILE: path.join(DATA_DIR, 'config.json'),
  };
}

async function ensureDir() {
  const { DATA_DIR } = getPaths();
  await fsp.mkdir(DATA_DIR, { recursive: true });
}

async function load() {
  const { DATA_FILE } = getPaths();
  await ensureDir();
  try {
    const raw = await fsp.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.projects)) {
      throw new Error('Malformed data.json: missing projects array');
    }
    state = parsed;
  } catch (err) {
    if (err.code === 'ENOENT') {
      state = JSON.parse(JSON.stringify(DEFAULT_STATE));
      await writeNow();
      return state;
    }
    const backupPath = `${DATA_FILE}.corrupt-${Date.now()}`;
    try {
      await fsp.rename(DATA_FILE, backupPath);
      console.error(`[storage] data.json was corrupt (${err.message}); backed up to ${backupPath}`);
    } catch (renameErr) {
      console.error(`[storage] data.json was corrupt and could not be backed up: ${renameErr.message}`);
    }
    state = JSON.parse(JSON.stringify(DEFAULT_STATE));
    await writeNow();
  }
  return state;
}

function getState() {
  if (!state) throw new Error('Storage not initialized; call load() first');
  return state;
}

async function writeNow() {
  const { DATA_FILE } = getPaths();
  await ensureDir();
  const tmp = `${DATA_FILE}.tmp`;
  const data = JSON.stringify(state, null, 2);
  await fsp.writeFile(tmp, data, 'utf8');
  await fsp.rename(tmp, DATA_FILE);
  dirty = false;
}

function save() {
  dirty = true;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    writingPromise = writeNow().catch((err) => {
      console.error('[storage] write failed:', err);
    });
  }, WRITE_DEBOUNCE_MS);
}

async function flush() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (dirty) {
    await writeNow();
  } else if (writingPromise) {
    await writingPromise;
  }
}

async function writeConfig(config) {
  const { CONFIG_FILE } = getPaths();
  await ensureDir();
  const tmp = `${CONFIG_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(config, null, 2), 'utf8');
  await fsp.rename(tmp, CONFIG_FILE);
}

module.exports = {
  getPaths,
  get DATA_DIR() {
    return getPaths().DATA_DIR;
  },
  get DATA_FILE() {
    return getPaths().DATA_FILE;
  },
  get CONFIG_FILE() {
    return getPaths().CONFIG_FILE;
  },
  load,
  save,
  flush,
  getState,
  writeConfig,
};
