const fs = require('fs');
const path = require('path');

const RUNTIME_ENV_KEYS = ['HOST', 'PORT', 'ORCHESTRA_DATA_DIR'];

function pickRuntimeEnv(sourceEnv = process.env) {
  const runtimeEnv = {};
  for (const key of RUNTIME_ENV_KEYS) {
    const value = sourceEnv[key];
    if (value === undefined || value === null) continue;
    const normalized = String(value).trim();
    if (!normalized) continue;
    runtimeEnv[key] = normalized;
  }
  return runtimeEnv;
}

function readRuntimeEnv(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return pickRuntimeEnv(parsed);
}

function writeRuntimeEnv(filePath, sourceEnv = process.env) {
  const runtimeEnv = pickRuntimeEnv(sourceEnv);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(runtimeEnv, null, 2)}\n`, 'utf8');
  return runtimeEnv;
}

module.exports = {
  RUNTIME_ENV_KEYS,
  pickRuntimeEnv,
  readRuntimeEnv,
  writeRuntimeEnv,
};
