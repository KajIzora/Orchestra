const { assertValidRemoteSource, createSshRunner } = require('./remote_cursor_tracker');
const { parseHookDebugBlocks } = require('./antigravity_hook_signals');

// Read budget aligned with remote_cursor_tracker's DEFAULT_TIMEOUT_MS (cold-handshake headroom).
const DEFAULT_TIMEOUT_MS = 10000;
const REMOTE_AGY_HOOK_DEBUG_PATH = '$HOME/.gemini/antigravity-cli/scratch/hook-debug.log';

/**
 * Tail remote agy hook-debug.log and parse HOOK START/END blocks into hook event bodies.
 *
 * @param {{ host: string, projects_root?: string }} remote
 * @param {{ runSsh?: Function, timeoutMs?: number, offset?: number, limit?: number }} [options]
 */
async function readRemoteGeminiHookDebugEvents(remote, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  const offset = Number.isInteger(options.offset) && options.offset >= 0 ? options.offset : 0;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 80;
  const cmd =
    `if [ ! -f "$HOME/.gemini/antigravity-cli/scratch/hook-debug.log" ]; then echo "__NOFILE__"; exit 0; fi; ` +
    `python3 - <<'PY'\n` +
    `import os\n` +
    `p=os.path.expandvars(${JSON.stringify(REMOTE_AGY_HOOK_DEBUG_PATH)})\n` +
    `off=${offset}\n` +
    `limit=${limit}\n` +
    // File truncated/rotated since the caller's stored offset: re-anchor at the new EOF instead of
    // seeking past it (which reads nothing but also never recovers) — and never replay from 0.
    `size=os.path.getsize(p)\n` +
    `if off>size: off=size\n` +
    `with open(p,'r',encoding='utf-8',errors='ignore') as f:\n` +
    `  f.seek(off)\n` +
    `  data=f.read(256*1024)\n` +
    `  new_off=f.tell()\n` +
    `print('__OFFSET__:'+str(new_off))\n` +
    `print(data, end='')\n` +
    `PY`;
  const stdout = await runSsh(cfg.host, cmd, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (String(stdout).startsWith('__NOFILE__')) return { events: [], offset };
  const lines = String(stdout).split('\n');
  const meta = lines.shift() || '';
  const m = meta.match(/^__OFFSET__:(\d+)$/);
  const nextOffset = m ? Number.parseInt(m[1], 10) : offset;
  const chunk = lines.join('\n');
  const events = parseHookDebugBlocks(chunk).map((event) => ({
    ...event,
    remote_host: cfg.host,
    source_kind: 'hook',
  }));
  return { events, offset: nextOffset };
}

module.exports = {
  readRemoteGeminiHookDebugEvents,
  REMOTE_AGY_HOOK_DEBUG_PATH,
};
