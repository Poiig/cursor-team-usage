/**
 * 用扩展宿主自带的 Node 读写 Cursor state.vscdb，避免依赖本机 Python。
 * 优先 node:sqlite（不整库进内存）；不可用时再退到旁路 sql-wasm-inline.js。
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

/** 只声明用到的 node:sqlite 接口；插件依赖的 @types/node 20 尚无该模块类型。 */
type NodeSqlite = {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean; timeout?: number },
  ) => {
    prepare: (sql: string) => {
      all: (...params: unknown[]) => unknown[];
      get: (...params: unknown[]) => unknown;
      run: (...params: unknown[]) => unknown;
    };
    exec: (sql: string) => void;
    close: () => void;
  };
};

/**
 * 只有扩展宿主没有 node:sqlite 时才返回 null 走 sql.js；
 * 锁冲突等运行期错误必须原样抛出，不能落到会整库读写的兜底。
 */
async function loadNodeSqlite(): Promise<NodeSqlite | null> {
  try {
    return (await import('node:sqlite')) as NodeSqlite;
  } catch {
    return null;
  }
}

/** 单次同步忙等上限：DatabaseSync 等锁会卡住扩展宿主线程，所以只等很短，靠外层异步重试。 */
const BUSY_TIMEOUT_MS = 200;
/** 异步重试总时长：Cursor 跑 Agent 时写库频繁，留足时间等它提交。 */
const BUSY_RETRY_TOTAL_MS = 10_000;

/**
 * Cursor 正持有写锁时报 database is locked / busy；在两次尝试之间让出事件循环再重试。
 */
async function withBusyRetry<T>(fn: () => T): Promise<T> {
  const deadline = Date.now() + BUSY_RETRY_TOTAL_MS;
  for (;;) {
    try {
      return fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/locked|busy/i.test(msg) || Date.now() >= deadline) {
        throw new Error(`读写 Cursor 状态库失败：${msg}`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

function readKeysViaNodeSqlite(
  sqlite: NodeSqlite,
  dbPath: string,
  keys: readonly string[],
): Map<string, string> {
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    const placeholders = keys.map(() => '?').join(',');
    const stmt = db.prepare(`SELECT key, value FROM ItemTable WHERE key IN (${placeholders})`);
    const rows = stmt.all(...keys) as Array<{ key: string; value: unknown }>;
    const out = new Map<string, string>();
    for (const row of rows) {
      if (row?.value != null) out.set(String(row.key), String(row.value));
    }
    return out;
  } finally {
    db.close();
  }
}

/**
 * sql.js 整库读进内存：先按文件大小拦截，避免同步读几百 MB 把扩展宿主卡死后才报错。
 */
function readDbFileForSqlJs(dbPath: string): Buffer {
  const size = statSync(dbPath).size;
  if (size > SQLJS_MAX_BYTES) {
    throw new Error(
      `Cursor 状态库过大（${Math.round(size / 1024 / 1024)}MB），当前 Cursor 不支持内置 SQLite，无法读写`,
    );
  }
  return readFileSync(dbPath);
}

/**
 * sql.js 只读：整文件进内存，仅作 node:sqlite 不可用时的兜底。
 */
async function readKeysViaSqlJs(
  dbPath: string,
  keys: readonly string[],
): Promise<Map<string, string>> {
  const buf = readDbFileForSqlJs(dbPath);
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
  const sqlite = await loadNodeSqlite();
  if (sqlite) return withBusyRetry(() => readKeysViaNodeSqlite(sqlite, dbPath, keys));
  return readKeysViaSqlJs(dbPath, keys);
}

/**
 * BEGIN IMMEDIATE 一开始就拿写锁：普通 BEGIN 先读后写，在 WAL 下中途升级写锁会直接失败，
 * 拿锁失败时整笔重试即可，不会写一半。
 */
function writePairsViaNodeSqlite(
  sqlite: NodeSqlite,
  dbPath: string,
  pairs: Array<[string, string]>,
): void {
  const db = new sqlite.DatabaseSync(dbPath, { timeout: BUSY_TIMEOUT_MS });
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const select = db.prepare('SELECT 1 AS x FROM ItemTable WHERE key = ?');
      const update = db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?');
      const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
      for (const [key, value] of pairs) {
        if (select.get(key)) update.run(value, key);
        else insert.run(key, value);
      }
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    }
  } finally {
    db.close();
  }
}

/**
 * sql.js 写入：读改写整库，仅用于没有 node:sqlite 的旧 Cursor。
 * 整文件覆盖会丢掉 -wal 里尚未合并的数据并可能写坏正在使用的库，有未合并 WAL 时拒绝写。
 */
async function writePairsViaSqlJs(
  dbPath: string,
  pairs: Array<[string, string]>,
): Promise<void> {
  const wal = `${dbPath}-wal`;
  if (existsSync(wal) && statSync(wal).size > 0) {
    throw new Error('当前 Cursor 不支持内置 SQLite，且状态库正在使用中，请关闭 Cursor 后重试');
  }
  const buf = readDbFileForSqlJs(dbPath);
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
  const sqlite = await loadNodeSqlite();
  if (sqlite) await withBusyRetry(() => writePairsViaNodeSqlite(sqlite, dbPath, pairs));
  else await writePairsViaSqlJs(dbPath, pairs);
  return pairs.map(([k]) => k);
}
