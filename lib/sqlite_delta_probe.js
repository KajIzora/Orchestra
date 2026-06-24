'use strict';

/**
 * Generic SQLite row/blob delta probe for signal:tail.
 *
 * This is the provider-agnostic generalization of lib/agy_app_db_tail_export.js. Given any
 * SQLite file, on each poll tick it diffs the table contents and emits *what* rows changed
 * (new + in-place updates), hex-encoding BLOB columns and best-effort decoding embedded JSON
 * out of both blob and text cells. That is what lets a signal like the cursor-cli `store.db`
 * question blob (a pending AskQuestion tool-call buried in a content-addressed blob store)
 * surface automatically during a tail — without an operator opening sqlite3 by hand.
 *
 * Strategy per table (auto-chosen each poll, no schema knowledge required):
 *   - small tables (count <= SMALL_TABLE_THRESHOLD): full fingerprint diff — catches both new
 *     rows and in-place updates (e.g. cursor's single `meta` head-pointer row).
 *   - large tables WITH rowid: incremental new-row detection by rowid > maxRowid — assumes
 *     append-only (e.g. cursor's immutable `blobs` content store). Cheap and unbounded-safe.
 *   - large tables WITHOUT rowid: count delta only (can't diff efficiently without a key).
 *
 * Like the agy exporter we shell out to the system sqlite3 READ-ONLY (no npm sqlite dep on
 * purpose) and never copy whole DB files — only bounded, hex-truncated row samples.
 */

const fs = require('fs');
const fsp = fs.promises;
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const SQLITE_BIN = '/usr/bin/sqlite3';

const DEFAULT_MAX_CELL_HEX = 16 * 1024; // hex chars retained per cell (8 KiB of bytes)
const DEFAULT_SMALL_TABLE_THRESHOLD = 256; // rows; below this we fingerprint-diff for updates
const DEFAULT_MAX_ROWS_PER_TABLE = 200; // rows emitted per table per poll
const DEFAULT_MAX_JSON_OBJECTS = 40; // decoded JSON objects emitted per snapshot

// Best-effort: pull every balanced top-level JSON object out of a (binary-framed) buffer. Cursor
// and other content-addressed stores wrap each message in an undocumented binary frame with embedded
// JSON; rather than decode the frame we scan for `{ … }` runs that JSON.parse cleanly. Non-UTF8
// bytes become replacement chars and are skipped. (Shared with cursor_cli_signal_session.js, which
// imports this so the two can't drift.)
function extractJsonObjectsFromBuffer(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j += 1) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            out.push(JSON.parse(text.slice(i, j + 1)));
            i = j;
          } catch {
            /* not JSON; keep scanning */
          }
          break;
        }
      }
    }
  }
  return out;
}

function isDbLockError(message = '') {
  return /unable to open database file|database is locked|SQLITE_BUSY|\(14\)|\(5\)/i.test(String(message || ''));
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function sqliteJson(dbPath, sql, timeoutMs = 4000) {
  const args = ['-readonly', '-cmd', '.timeout 100', '-json', dbPath, sql];
  const { stdout } = await execFileAsync(SQLITE_BIN, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return [];
  const rows = JSON.parse(trimmed);
  return Array.isArray(rows) ? rows : [];
}

async function listTables(dbPath) {
  const rows = await sqliteJson(
    dbPath,
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"
  );
  return rows.map((r) => r.name).filter(Boolean);
}

async function tableColumns(dbPath, table) {
  const rows = await sqliteJson(dbPath, `PRAGMA table_info(${quoteIdent(table)});`);
  return rows.map((r) => r.name).filter((n) => typeof n === 'string');
}

async function tableHasRowid(dbPath, table) {
  try {
    await sqliteJson(dbPath, `SELECT rowid FROM ${quoteIdent(table)} LIMIT 1;`);
    return true;
  } catch {
    return false;
  }
}

async function tableCount(dbPath, table) {
  const rows = await sqliteJson(dbPath, `SELECT COUNT(*) AS n FROM ${quoteIdent(table)};`);
  const n = rows[0]?.n;
  return Number.isFinite(Number(n)) ? Number(n) : 0;
}

// Build a SELECT that hex-encodes BLOB cells (so JSON output is safe) and carries a per-row
// types map so the caller knows which columns were blobs. Text/number cells pass through.
function rowSelect(table, columns, { withRowid }) {
  const cols = columns.map(
    (c) => `CASE WHEN typeof(${quoteIdent(c)})='blob' THEN hex(${quoteIdent(c)}) ELSE ${quoteIdent(c)} END AS ${quoteIdent(c)}`
  );
  const typeMap = `(${columns.map((c) => `typeof(${quoteIdent(c)})`).join("||'|'||")}) AS __types`;
  const head = withRowid ? ['rowid AS __rowid', ...cols, typeMap] : [...cols, typeMap];
  return `SELECT ${head.join(', ')} FROM ${quoteIdent(table)}`;
}

function truncateHex(value, maxHex) {
  const text = String(value == null ? '' : value);
  if (text.length <= maxHex) return { value: text, truncated: false };
  return { value: text.slice(0, maxHex), truncated: true };
}

// Normalize a raw sqlite3 -json row into { __rowid?, cells, blob_cols, truncated_cols } and pull any
// decodable JSON out of blob/text cells. Mutates nothing; returns the enriched record.
function enrichRow(table, raw, columns, maxCellHex, jsonSink, maxJson) {
  const types = String(raw.__types || '').split('|');
  const cells = {};
  const blobCols = [];
  const truncatedCols = [];
  columns.forEach((col, idx) => {
    const type = types[idx] || '';
    let value = raw[col];
    if (type === 'blob') {
      blobCols.push(col);
      const t = truncateHex(value, maxCellHex);
      value = t.value;
      if (t.truncated) truncatedCols.push(col);
      if (jsonSink.length < maxJson && value) {
        let buf = null;
        try {
          buf = Buffer.from(value, 'hex');
        } catch {
          buf = null;
        }
        if (buf) {
          for (const obj of extractJsonObjectsFromBuffer(buf)) {
            if (jsonSink.length >= maxJson) break;
            jsonSink.push({ table, column: col, rowid: raw.__rowid ?? null, json: obj });
          }
        }
      }
    } else if (typeof value === 'string' && value.length && jsonSink.length < maxJson) {
      const trimmed = value.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        for (const obj of extractJsonObjectsFromBuffer(Buffer.from(value, 'utf8'))) {
          if (jsonSink.length >= maxJson) break;
          jsonSink.push({ table, column: col, rowid: raw.__rowid ?? null, json: obj });
        }
      }
    }
    cells[col] = value;
  });
  const out = { table, cells, blob_cols: blobCols };
  if (raw.__rowid !== undefined) out.rowid = raw.__rowid;
  if (truncatedCols.length) out.truncated_cols = truncatedCols;
  return out;
}

function rowFingerprint(raw, columns) {
  return columns.map((c) => `${typeof raw[c]}:${raw[c]}`).join('');
}

function createSqliteDeltaProbe(options = {}) {
  const maxCellHex = Number.isInteger(options.maxCellHex) && options.maxCellHex > 0 ? options.maxCellHex : DEFAULT_MAX_CELL_HEX;
  const smallTableThreshold = Number.isInteger(options.smallTableThreshold) && options.smallTableThreshold > 0
    ? options.smallTableThreshold
    : DEFAULT_SMALL_TABLE_THRESHOLD;
  const maxRowsPerTable = Number.isInteger(options.maxRowsPerTable) && options.maxRowsPerTable > 0
    ? options.maxRowsPerTable
    : DEFAULT_MAX_ROWS_PER_TABLE;
  const maxJson = Number.isInteger(options.maxJsonObjects) && options.maxJsonObjects > 0
    ? options.maxJsonObjects
    : DEFAULT_MAX_JSON_OBJECTS;
  // When true, the FIRST snapshot of a DB returns its existing rows as new_rows (discovery mode).
  // When false (default, tail mode) the first snapshot seeds state silently and only later deltas
  // are emitted — matching the agy exporter.
  const includeSeed = !!options.includeSeed;

  const byDb = new Map();

  function getDbState(dbPath) {
    if (!byDb.has(dbPath)) {
      byDb.set(dbPath, { tables: new Map(), seeded: false, walOffset: 0, lastWalSize: 0 });
    }
    return byDb.get(dbPath);
  }

  function getTableState(dbState, table) {
    if (!dbState.tables.has(table)) {
      dbState.tables.set(table, { columns: null, hasRowid: null, maxRowid: 0, fingerprints: new Map(), count: 0 });
    }
    return dbState.tables.get(table);
  }

  async function statSize(filePath) {
    try {
      const st = await fsp.stat(filePath);
      return Number(st.size);
    } catch {
      return null;
    }
  }

  async function snapshotTable(dbPath, table, dbState, jsonSink, emitSeed) {
    const ts = getTableState(dbState, table);
    if (ts.columns === null) {
      ts.columns = await tableColumns(dbPath, table);
      ts.hasRowid = await tableHasRowid(dbPath, table);
    }
    const columns = ts.columns;
    if (!columns.length) return null;
    const firstSight = !ts.seen;
    const count = await tableCount(dbPath, table);
    const countDelta = firstSight ? 0 : count - ts.count;
    ts.count = count;
    // Baseline pass: record table state but emit nothing (tail mode). Discovery mode (emitSeed)
    // treats the existing rows as the delta instead.
    const seeding = firstSight && !emitSeed;

    const newRows = [];
    const updatedRows = [];

    if (count <= smallTableThreshold) {
      // Full fingerprint diff — catches new rows AND in-place updates (e.g. a head-pointer row).
      const base = rowSelect(table, columns, { withRowid: ts.hasRowid });
      const order = ts.hasRowid ? ' ORDER BY rowid ASC' : '';
      const raw = await sqliteJson(dbPath, `${base}${order} LIMIT ${smallTableThreshold + 1};`);
      const nextFps = new Map();
      for (const r of raw) {
        const key = ts.hasRowid ? String(r.__rowid) : rowFingerprint(r, columns);
        const fp = rowFingerprint(r, columns);
        nextFps.set(key, fp);
        if (ts.hasRowid) ts.maxRowid = Math.max(ts.maxRowid, Number(r.__rowid) || 0);
        if (seeding) continue;
        const prev = ts.fingerprints.get(key);
        if (prev === undefined) {
          if (newRows.length < maxRowsPerTable) newRows.push(enrichRow(table, r, columns, maxCellHex, jsonSink, maxJson));
        } else if (prev !== fp) {
          if (updatedRows.length < maxRowsPerTable) updatedRows.push(enrichRow(table, r, columns, maxCellHex, jsonSink, maxJson));
        }
      }
      ts.fingerprints = nextFps;
    } else if (ts.hasRowid) {
      // Large append-only: incremental new rows by rowid.
      if (seeding) {
        const tail = await sqliteJson(dbPath, `SELECT MAX(rowid) AS m FROM ${quoteIdent(table)};`);
        ts.maxRowid = Math.max(ts.maxRowid, Number(tail[0]?.m) || 0);
      } else {
        const base = rowSelect(table, columns, { withRowid: true });
        const raw = await sqliteJson(dbPath, `${base} WHERE rowid > ${ts.maxRowid} ORDER BY rowid ASC LIMIT ${maxRowsPerTable};`);
        for (const r of raw) {
          ts.maxRowid = Math.max(ts.maxRowid, Number(r.__rowid) || 0);
          newRows.push(enrichRow(table, r, columns, maxCellHex, jsonSink, maxJson));
        }
        // Advance past anything beyond the LIMIT so we don't re-read it forever.
        if (raw.length === maxRowsPerTable) {
          const tail = await sqliteJson(dbPath, `SELECT MAX(rowid) AS m FROM ${quoteIdent(table)};`);
          ts.maxRowid = Math.max(ts.maxRowid, Number(tail[0]?.m) || 0);
        }
      }
    }
    // else: large WITHOUT rowid — count delta only.

    ts.seen = true;
    if (seeding) return null;
    if (!newRows.length && !updatedRows.length && countDelta === 0) return null;
    return { name: table, count, count_delta: countDelta, new_rows: newRows, updated_rows: updatedRows };
  }

  async function snapshot(dbPath) {
    const dbState = getDbState(dbPath);
    const emitSeed = includeSeed && !dbState.seeded;
    const out = {
      db_path: dbPath,
      db_size: await statSize(dbPath),
      wal_path: `${dbPath}-wal`,
      wal_size: await statSize(`${dbPath}-wal`),
      wal_bytes_appended: 0,
      tables: [],
      json_objects: [],
      error: '',
    };

    if (Number.isFinite(out.wal_size)) {
      if (out.wal_size < dbState.walOffset || out.wal_size < dbState.lastWalSize) dbState.walOffset = 0;
      out.wal_bytes_appended = Math.max(0, out.wal_size - dbState.walOffset);
      dbState.walOffset = out.wal_size;
      dbState.lastWalSize = out.wal_size;
    }

    const jsonSink = out.json_objects;
    try {
      const tables = await listTables(dbPath);
      for (const table of tables) {
        let result = null;
        try {
          result = await snapshotTable(dbPath, table, dbState, jsonSink, emitSeed);
        } catch (err) {
          const message = err.message || String(err);
          if (isDbLockError(message)) {
            out.db_locked = true;
          } else {
            out.error = out.error || message;
          }
          continue;
        }
        if (result) out.tables.push(result);
      }
      dbState.seeded = true;
    } catch (err) {
      const message = err.message || String(err);
      if (isDbLockError(message)) out.db_locked = true;
      else out.error = out.error || message;
    }

    const hasRows = out.tables.some((t) => t.new_rows.length || t.updated_rows.length || t.count_delta);
    const hasWal = out.wal_bytes_appended > 0;
    if (!hasRows && !hasWal && !out.error && !out.db_locked) return null;
    return out;
  }

  return { snapshot, getDbState, listTables, extractJsonObjectsFromBuffer };
}

module.exports = {
  SQLITE_BIN,
  DEFAULT_MAX_CELL_HEX,
  DEFAULT_SMALL_TABLE_THRESHOLD,
  createSqliteDeltaProbe,
  extractJsonObjectsFromBuffer,
  isDbLockError,
};
