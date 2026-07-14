'use strict';

/*
 * File-redirect fallback for the §3.1 pull source. When a process's output goes to a file (a log,
 * or a `> out.log` redirect) instead of a terminal, discover that file from the process's open
 * file descriptors (lsof fd 1/2 = stdout/stderr) and tail it — the same append-only, byte-offset
 * bounded-tail machinery the codex/gemini adapters use (readNewRolloutBytes). execFile is injected
 * so discovery is unit-testable without a live process.
 */

const { execFile } = require('child_process');
const { readNewRolloutBytes } = require('./live_feed_codex_notes');

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_INITIAL_BYTES = 64 * 1024;
const DEFAULT_MAX_BYTES = 256 * 1024;

// Parse `lsof -F ftn` output into { <fd>: path } for REG (regular file) descriptors only. A tty is
// type CHR and a pipe is FIFO/PIPE — both excluded, so we only ever surface a real output FILE.
function parseLsofFdFiles(stdout) {
  let fd = null;
  let type = null;
  let name = null;
  const out = {};
  const flush = () => {
    if (fd && type === 'REG' && name) out[fd] = name;
  };
  for (const line of String(stdout == null ? '' : stdout).split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'f') {
      flush();
      fd = val;
      type = null;
      name = null;
    } else if (tag === 't') {
      type = val;
    } else if (tag === 'n') {
      name = val;
    }
  }
  flush();
  return out;
}

// Prefer stdout (fd 1) over stderr (fd 2).
function pickOutputFile(fdFiles) {
  return (fdFiles && (fdFiles['1'] || fdFiles['2'])) || null;
}

/**
 * Discover a pid's stdout/stderr redirect target (a regular file), or null. Never rejects.
 */
function discoverOutputFile(pid, { execFileImpl = execFile, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const n = Number.parseInt(pid, 10);
    if (!Number.isInteger(n) || n <= 0) return resolve(null);
    execFileImpl(
      'lsof',
      ['-a', '-p', String(n), '-d', '1,2', '-F', 'ftn'],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      // lsof exits non-zero when nothing matches; parse whatever stdout it printed regardless.
      (_err, stdout) => resolve(pickOutputFile(parseLsofFdFiles(stdout || '')))
    );
  });
}

/**
 * Tail new complete lines from `filePath` since `fromOffset` (null/undefined = first read, bounded
 * catch-up). Returns { lines, offset }. Never throws.
 */
async function readFileTail(filePath, fromOffset, opts = {}) {
  try {
    const { lines, nextOffset } = await readNewRolloutBytes(filePath, fromOffset, {
      initialBytes: Number.isFinite(opts.initialBytes) ? opts.initialBytes : DEFAULT_INITIAL_BYTES,
      maxBytes: Number.isFinite(opts.maxBytes) ? opts.maxBytes : DEFAULT_MAX_BYTES,
    });
    return { lines: lines || [], offset: Number.isFinite(nextOffset) ? nextOffset : (Number.isFinite(fromOffset) ? fromOffset : null) };
  } catch {
    return { lines: [], offset: Number.isFinite(fromOffset) ? fromOffset : null };
  }
}

module.exports = { discoverOutputFile, readFileTail, parseLsofFdFiles, pickOutputFile };
