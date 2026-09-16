/**
 * 运行时配置：加载仓库根目录 .env，再读 process.env（已存在的环境变量优先）。
 * 模板见 .env.example；改完需重启进程。
 */

import { access, appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const ENV_PATH = path.join(ROOT_DIR, '.env');
const ENV_EXAMPLE_PATH = path.join(ROOT_DIR, '.env.example');
const DEFAULT_SQLITE = path.join(DATA_DIR, 'app.sqlite');

/**
 * 出厂默认 Access Key，便于开箱联调插件。
 * 生产环境请在 .env 与扩展设置中同时改成自有密钥。
 */
export const DEFAULT_ACCESS_KEY = 'ctu-change-me';

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
  accessKey: DEFAULT_ACCESS_KEY,
  autoRefreshSec: 1800,
  sessionSecret: '',
};

/**
 * 解析 .env 文本为键值表；支持 # 注释与引号包裹的值。
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvFile(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

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
    accessKey: DEFAULT_ACCESS_KEY,
    autoRefreshSec: 1800, // 每账号距上次同步的刷新间隔（秒）
    sessionSecret: '',
  };
}

/**
 * 把 .env 键写入 process.env；已有非空环境变量不覆盖（便于 Docker / CI 注入）。
 * @param {Record<string, string>} vars
 */
function applyParsedEnv(vars) {
  for (const [key, value] of Object.entries(vars)) {
    const cur = process.env[key];
    if (cur == null || cur === '') process.env[key] = value;
  }
}

/**
 * 从 process.env 组装运行时配置。
 * @returns {AppConfig}
 */
function configFromProcessEnv() {
  const next = defaults();
  const envDriver = String(process.env.STORE_DRIVER || '').toLowerCase().trim();
  if (envDriver) {
    next.storeDriver = normalizeStoreDriver(envDriver);
  } else if (process.env.DATABASE_URL || process.env.PGHOST) {
    next.storeDriver = 'postgres';
  }

  if (process.env.DATABASE_URL) next.databaseUrl = process.env.DATABASE_URL;
  else if (process.env.PGHOST) {
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

  if (process.env.ACCESS_KEY != null || process.env.AGENT_ACCESS_KEY != null) {
    // 显式设为空字符串表示关闭插件上报；未设置则保留默认值。
    const raw = process.env.ACCESS_KEY ?? process.env.AGENT_ACCESS_KEY ?? '';
    next.accessKey = String(raw).trim();
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
  return path.isAbsolute(raw) ? raw : path.join(ROOT_DIR, raw);
}

/** 缺 .env 时从模板复制一份，方便本地启动。 */
async function ensureEnvFile() {
  try {
    await access(ENV_PATH);
    return false;
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }
  try {
    await access(ENV_EXAMPLE_PATH);
    await copyFile(ENV_EXAMPLE_PATH, ENV_PATH);
  } catch {
    await writeFile(ENV_PATH, '# cursor-team-usage\n', 'utf8');
  }
  // 单测时静默：Node 18 test runner 曾因中文日志触发 IPC 反序列化失败
  if (process.env.npm_lifecycle_event !== 'test') {
    console.log('已生成 .env（可参考 .env.example）');
  }
  return true;
}

/**
 * 首次无 SESSION_SECRET 时生成并追加到 .env，避免每次重启登录态失效。
 * @param {string} secret
 */
async function persistSessionSecret(secret) {
  const line = `\n# 首次启动自动生成\nSESSION_SECRET=${secret}\n`;
  await appendFile(ENV_PATH, line, 'utf8');
  if (process.env.npm_lifecycle_event !== 'test') {
    console.log('已写入 SESSION_SECRET 到 .env');
  }
}

/** 启动时加载 .env 并固化运行时配置。 */
export async function loadAppConfig() {
  await mkdir(DATA_DIR, { recursive: true });
  await ensureEnvFile();
  try {
    const raw = await readFile(ENV_PATH, 'utf8');
    applyParsedEnv(parseEnvFile(raw));
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }

  runtime = configFromProcessEnv();
  runtime.sqlitePath = resolveDataPath(runtime.sqlitePath);

  if (!runtime.sessionSecret) {
    const secret = randomBytes(24).toString('hex');
    runtime.sessionSecret = secret;
    process.env.SESSION_SECRET = secret;
    await persistSessionSecret(secret);
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
  return ENV_PATH;
}
