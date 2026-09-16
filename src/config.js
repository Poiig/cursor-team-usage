/**
 * 运行时配置：优先 data/config.json，环境变量可覆盖（便于 Docker）。
 * 模板见仓库根目录 config.example.json；改文件后需重启进程。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const DEFAULT_SQLITE = path.join(DATA_DIR, 'app.sqlite');

/**
 * @typedef {{
 *   storeDriver: 'sqlite' | 'postgres' | 'file',
 *   databaseUrl: string,
 *   sqlitePath: string,
 *   accessKey: string,
 *   autoRefreshSec: number,
 *   sessionSecret: string,
 * }} AppConfig
 */

/** @type {AppConfig} */
let runtime = {
  storeDriver: 'sqlite',
  databaseUrl: '',
  sqlitePath: DEFAULT_SQLITE,
  accessKey: '',
  autoRefreshSec: 1800,
  sessionSecret: '',
};

/**
 * 归一化驱动名：空 / 未知 → sqlite；兼容 pg 别名与遗留 file。
 * @param {unknown} value
 * @returns {'sqlite' | 'postgres' | 'file'}
 */
export function normalizeStoreDriver(value) {
  const s = String(value || '')
    .toLowerCase()
    .trim();
  if (s === 'postgres' || s === 'pg' || s === 'postgresql') return 'postgres';
  if (s === 'file' || s === 'json') return 'file';
  return 'sqlite';
}

/** @returns {AppConfig} */
function defaults() {
  return {
    storeDriver: 'sqlite',
    databaseUrl: '',
    sqlitePath: DEFAULT_SQLITE,
    accessKey: '',
    autoRefreshSec: 1800, // 30 分钟后台刷新全员用量
    sessionSecret: randomBytes(24).toString('hex'),
  };
}

/**
 * 环境变量覆盖（部署时注入优先于文件）。
 * @param {AppConfig} cfg
 */
function applyEnvOverrides(cfg) {
  const next = { ...cfg };
  const envDriver = String(process.env.STORE_DRIVER || '').toLowerCase().trim();
  if (envDriver) {
    next.storeDriver = normalizeStoreDriver(envDriver);
  } else if (!next.databaseUrl && (process.env.DATABASE_URL || process.env.PGHOST)) {
    // 未显式指定驱动但给了 PG 连接信息时，自动走 postgres。
    next.storeDriver = 'postgres';
  }

  if (process.env.DATABASE_URL) next.databaseUrl = process.env.DATABASE_URL;
  else if (process.env.PGHOST && !next.databaseUrl) {
    const port = process.env.PGPORT || '5432';
    const user = encodeURIComponent(process.env.PGUSER || 'postgres');
    const pass = encodeURIComponent(process.env.PGPASSWORD || '');
    const db = process.env.PGDATABASE || 'cursor_team_usage';
    const auth = pass ? `${user}:${pass}` : user;
    next.databaseUrl = `postgresql://${auth}@${process.env.PGHOST}:${port}/${db}`;
  }

  if (process.env.SQLITE_PATH) {
    next.sqlitePath = String(process.env.SQLITE_PATH).trim() || DEFAULT_SQLITE;
  }

  if (process.env.ACCESS_KEY || process.env.AGENT_ACCESS_KEY) {
    next.accessKey = String(process.env.ACCESS_KEY || process.env.AGENT_ACCESS_KEY).trim();
  }
  if (process.env.AUTO_REFRESH_SEC != null && process.env.AUTO_REFRESH_SEC !== '') {
    const n = Number(process.env.AUTO_REFRESH_SEC);
    if (Number.isFinite(n) && n >= 0) next.autoRefreshSec = Math.floor(n);
  }
  if (process.env.SESSION_SECRET) next.sessionSecret = String(process.env.SESSION_SECRET);
  return next;
}

/**
 * 相对路径相对仓库根解析，避免 cwd 变化导致库文件漂移。
 * @param {string} p
 */
function resolveDataPath(p) {
  const raw = String(p || '').trim() || DEFAULT_SQLITE;
  return path.isAbsolute(raw) ? raw : path.join(__dirname, '..', raw);
}

/** 把可落盘字段写成 data/config.json（首次启动时）。 */
async function writeConfigFile(cfg) {
  await mkdir(DATA_DIR, { recursive: true });
  const disk = {
    storeDriver: normalizeStoreDriver(cfg.storeDriver),
    databaseUrl: cfg.databaseUrl || '',
    sqlitePath: cfg.sqlitePath || 'data/app.sqlite',
    accessKey: cfg.accessKey || '',
    autoRefreshSec: Number(cfg.autoRefreshSec) || 0,
    sessionSecret: cfg.sessionSecret || defaults().sessionSecret,
  };
  await writeFile(CONFIG_PATH, JSON.stringify(disk, null, 2), 'utf8');
}

/** 启动时读取配置文件；不存在则按默认值生成一份。 */
export async function loadAppConfig() {
  let fileCfg = defaults();
  let missing = false;
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const sqliteRaw = String(parsed.sqlitePath || 'data/app.sqlite').trim() || 'data/app.sqlite';
    fileCfg = {
      ...fileCfg,
      storeDriver: normalizeStoreDriver(parsed.storeDriver),
      databaseUrl: String(parsed.databaseUrl || ''),
      sqlitePath: resolveDataPath(sqliteRaw),
      accessKey: String(parsed.accessKey || ''),
      autoRefreshSec:
        parsed.autoRefreshSec != null && parsed.autoRefreshSec !== ''
          ? Math.max(0, Math.floor(Number(parsed.autoRefreshSec) || 0))
          : fileCfg.autoRefreshSec,
      sessionSecret: String(parsed.sessionSecret || fileCfg.sessionSecret),
    };
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
    missing = true;
  }
  runtime = applyEnvOverrides(fileCfg);
  // sqlitePath 经 env 覆盖后仍可能是相对路径，统一解析到绝对路径。
  runtime.sqlitePath = resolveDataPath(runtime.sqlitePath);
  if (missing) {
    await writeConfigFile({
      ...runtime,
      sqlitePath: path.relative(path.join(__dirname, '..'), runtime.sqlitePath) || 'data/app.sqlite',
    });
    console.log('已生成 data/config.json（可参考仓库根目录 config.example.json）');
  }
  return getAppConfig();
}

/** @returns {AppConfig} */
export function getAppConfig() {
  return { ...runtime };
}

export function getListenConfig() {
  return {
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 3780),
  };
}

/** @returns {'sqlite' | 'postgres' | 'file'} */
export function getStoreDriver() {
  return normalizeStoreDriver(getAppConfig().storeDriver);
}

/** @returns {string} */
export function getSqlitePath() {
  return getAppConfig().sqlitePath || DEFAULT_SQLITE;
}

/** @returns {string | null} */
export function getDatabaseUrl() {
  const url = getAppConfig().databaseUrl.trim();
  return url || null;
}

/** @returns {string | null} */
export function getAccessKey() {
  const key = getAppConfig().accessKey.trim();
  return key || null;
}

export function getServerAutoRefreshSec() {
  const n = getAppConfig().autoRefreshSec;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function getSessionSecret() {
  return getAppConfig().sessionSecret || 'dev-insecure-session-secret';
}

export function getConfigPath() {
  return CONFIG_PATH;
}
