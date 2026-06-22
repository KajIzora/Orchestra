#!/usr/bin/env node

const path = require('path');

const { writeRuntimeEnv } = require('../lib/runtime_env');

const runtimeEnvPath = path.join(__dirname, '..', 'build', 'runtime-env.json');
const runtimeEnv = writeRuntimeEnv(runtimeEnvPath);
const keys = Object.keys(runtimeEnv);

if (keys.length) {
  console.log(`[runtime-env] baked ${keys.join(', ')} into ${runtimeEnvPath}`);
} else {
  console.log(`[runtime-env] wrote empty runtime config to ${runtimeEnvPath}`);
}
