/**
 * 用扩展宿主自带的 Node 读写 Cursor state.vscdb，避免依赖本机 Python。
 * 优先 node:sqlite（不整库进内存）；不可用时再退到旁路 sql-wasm-inline.js。
 */

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const CURSOR_AUTH_KEYS = [
  'cursorAuth/accessToken',
  'cursorAuth/cachedEmail',
  'cursorAuth/refreshToken',
  'cursorAuth/stripeMembershipAuthId',
  'cursorAuth/cachedSignUpType',
] as const;

/** sql.js 整库加载上限：再大就明确报错，避免把扩展宿主撑爆。 */
const SQLJS_MAX_BYTES = 400 * 1024 * 1024;

type SqlJsDb = {
  exec: (sql: string) => Array<{ columns: string[]; values: unknown[][] }>;
  run: (sql: string, params?: unknown[]) => void;
  export: () => Uint8Array;
  close: () => void;
};

type SqlJsOpen = (data?: ArrayLike<number> | Buffer | null) => SqlJsDb;

let sqlJsOpen: Promise<SqlJsOpen> | null = null;
const require = createRequire(__filename);

/**
 * 懒加载 dist/sql-wasm-inline.js（构建时拷贝，不打进 extension.js）。
 */
async function getSqlJsOpen(): Promise<SqlJsOpen> {
  if (!sqlJsOpen) {
    sqlJsOpen = (async () => {
      const wasmPath = path.join(__dirname, 'sql-wasm-inline.js');
      const initSqlJs = require(wasmPath) as () => Promise<{
        Database: new (data?: ArrayLike<number> | null) => SqlJsDb;
      }>;
      const SQL = await initSqlJs();
      return (data?: ArrayLike<number> | Buffer | null) =>
        new SQL.Database(data ? new Uint8Array(data) : undefined);
    })();
  }
  return sqlJsOpen;
}

/**
 * 优先用 Node 内置 SQLite（扩展宿主若支持），失败返回 null 交给 sql.js。
 */
async function readKeysViaNodeSqlite(
  dbPath: string,
  keys: readonly string[],
): Promise<Map<string, string> | null> {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const placeholders = keys.map(() => '?').join(',');
      const stmt = db.prepare(
        `SELECT key, value FROM ItemTable WHERE key IN (${placeholders})`,
      );
      const rows = stmt.all(...keys) as Array<{ key: string; value: unknown }>;
      const out = new Map<string, string>();
      for (const row of rows) {
        if (row?.value != null) out.set(String(row.key), String(row.value));
      }
      return out;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * sql.js 只读：整文件进内存，仅作 node:sqlite 不可用时的兜底。
 */
async function readKeysViaSqlJs(
  dbPath: string,
  keys: readonly string[],
): Promise<Map<string, string>> {
  const buf = readFileSync(dbPath);
  if (buf.length > SQLJS_MAX_BYTES) {
    throw new Error(
      `Cursor 状态库过大（${Math.round(buf.length / 1024 / 1024)}MB），无法用内置引擎读取`,
    );
  }
  const open = await getSqlJsOpen();
  const db = open(buf);
  try {
    const inList = keys.map((k) => `'${k.replaceAll("'", "''")}'`).join(',');
    const result = db.exec(`SELECT key, value FROM ItemTable WHERE key IN (${inList})`);
    const out = new Map<string, string>();
    const table = result[0];
    if (!table) return out;
    const keyIdx = table.columns.indexOf('key');
    const valIdx = table.columns.indexOf('value');
    for (const row of table.values) {
      const k = row[keyIdx];
      const v = row[valIdx];
      if (k != null && v != null) out.set(String(k), String(v));
    }
    return out;
  } finally {
    db.close();
  }
}

/**
 * 从 state.vscdb 读指定 auth 键。
 */
export async function readCursorAuthKeys(
  dbPath: string,
  keys: readonly string[] = CURSOR_AUTH_KEYS,
): Promise<Map<string, string>> {
  const viaNode = await readKeysViaNodeSqlite(dbPath, keys);
  if (viaNode) return viaNode;
  return readKeysViaSqlJs(dbPath, keys);
}

/**
 * 优先 node:sqlite 写入；失败再 sql.js。
 */
async function writePairsViaNodeSqlite(
  dbPath: string,
  pairs: Array<[string, string]>,
): Promise<boolean> {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      const select = db.prepare('SELECT 1 AS x FROM ItemTable WHERE key = ?');
      const update = db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?');
      const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
      db.exec('BEGIN');
      for (const [key, value] of pairs) {
        if (select.get(key)) update.run(value, key);
        else insert.run(key, value);
      }
      db.exec('COMMIT');
      return true;
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/**
 * sql.js 写入：读改写整库。
 */
async function writePairsViaSqlJs(
  dbPath: string,
  pairs: Array<[string, string]>,
): Promise<void> {
  const buf = readFileSync(dbPath);
  if (buf.length > SQLJS_MAX_BYTES) {
    throw new Error(
      `Cursor 状态库过大（${Math.round(buf.length / 1024 / 1024)}MB），无法用内置引擎写入`,
    );
  }
  const open = await getSqlJsOpen();
  const db = open(buf);
  try {
    db.run('BEGIN');
    for (const [key, value] of pairs) {
      const hit = db.exec(`SELECT 1 AS x FROM ItemTable WHERE key = '${key.replaceAll("'", "''")}'`);
      if (hit[0]?.values?.length) {
        db.run('UPDATE ItemTable SET value = ? WHERE key = ?', [value, key]);
      } else {
        db.run('INSERT INTO ItemTable (key, value) VALUES (?, ?)', [key, value]);
      }
    }
    db.run('COMMIT');
    writeFileSync(dbPath, Buffer.from(db.export()));
  } finally {
    db.close();
  }
}

/**
 * 把 auth 键值写入 state.vscdb（仅允许已知 cursorAuth/*）。
 */
export async function writeCursorAuthPairs(
  dbPath: string,
  pairs: Array<[string, string]>,
): Promise<string[]> {
  if (!pairs.length) throw new Error('没有可写入的 auth 字段');
  const ok = await writePairsViaNodeSqlite(dbPath, pairs);
  if (!ok) await writePairsViaSqlJs(dbPath, pairs);
  return pairs.map(([k]) => k);
}
