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
 * @typedef {{ normal: number, expiring: number }} SeatLimit
 *
 * @typedef {{
 *   storeDriver: 'sqlite' | 'postgres' | 'file',
 *   databaseUrl: string,
 *   sqlitePath: string,
 *   accessKey: string,
 *   autoRefreshSec: number,
 *   sessionSecret: string,
 *   logRetentionDays: number,
 *   proMaxUsers: SeatLimit,
 *   proPlusMaxUsers: SeatLimit,
 *   xMaxUsers: SeatLimit,
 *   notifyChannel: string,
 *   notifyBotId: string,
 *   notifyHour: number,
 *   notifyMinute: number,
 *   expiringWithinDays: number,
 *   blockSpeedingSwitch: boolean,
 *   blockSpeedingSwitchAdminExempt: boolean,
 * }} AppConfig
 */

/** 首次从 .env 文件读到的键；reload 时只回写这些键，避免覆盖外部注入（Docker/CI）变量。 */
let fileEnvKeys = new Set();

/** @type {AppConfig} */
let runtime = {
  storeDriver: 'sqlite',
  databaseUrl: '',
  sqlitePath: DEFAULT_SQLITE,
  accessKey: DEFAULT_ACCESS_KEY,
  autoRefreshSec: 900,
  sessionSecret: '',
  logRetentionDays: 30,
  proMaxUsers: { normal: 3, expiring: 3 },
  proPlusMaxUsers: { normal: 5, expiring: 5 },
  xMaxUsers: { normal: 3, expiring: 3 },
  notifyChannel: '',
  notifyBotId: '',
  notifyHour: 9,
  notifyMinute: 30,
  expiringWithinDays: 7,
  blockSpeedingSwitch: false,
  blockSpeedingSwitchAdminExempt: true,
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

/**
 * 解析席位上限：支持「正常,临期」两档（如 "2,3"）或单值（"3" 两档同用）。
 * 非法 / 空值回退到默认档。
 * @param {unknown} raw
 * @param {number} fallbackNormal
 * @returns {SeatLimit}
 */
export function parseSeatLimit(raw, fallbackNormal) {
  const fallback = { normal: fallbackNormal, expiring: fallbackNormal };
  const text = String(raw ?? '').trim();
  if (!text) return fallback;
  const parts = text.split(',').map((s) => s.trim());
  const normal = Number(parts[0]);
  const expiringRaw = parts[1] != null && parts[1] !== '' ? parts[1] : parts[0];
  const expiring = Number(expiringRaw);
  const out = {
    normal: Number.isFinite(normal) && normal > 0 ? Math.floor(normal) : fallbackNormal,
    expiring:
      Number.isFinite(expiring) && expiring > 0 ? Math.floor(expiring) : fallbackNormal,
  };
  return out;
}

/** 解析布尔型开关：true / 1 / on / yes → true，其余 false（推荐写 true/false）。 */
export function parseBoolFlag(value) {
  const s = String(value ?? '')
    .trim()
    .toLowerCase();
  return s === '1' || s === 'true' || s === 'on' || s === 'yes';
}

/** @returns {AppConfig} */
function defaults() {
  return {
    storeDriver: 'sqlite',
    databaseUrl: '',
    sqlitePath: DEFAULT_SQLITE,
    accessKey: DEFAULT_ACCESS_KEY,
    autoRefreshSec: 900, // 每账号距上次同步的刷新间隔（秒）
    sessionSecret: '',
    logRetentionDays: 30, // data/log 下日志保留天数，0=不自动删除
    proMaxUsers: { normal: 3, expiring: 3 },
    proPlusMaxUsers: { normal: 5, expiring: 5 },
    xMaxUsers: { normal: 3, expiring: 3 },
    notifyChannel: '',
    notifyBotId: '',
    notifyHour: 9,
    notifyMinute: 30,
    expiringWithinDays: 7,
    blockSpeedingSwitch: false,
    blockSpeedingSwitchAdminExempt: true,
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
  if (process.env.LOG_RETENTION_DAYS != null && process.env.LOG_RETENTION_DAYS !== '') {
    const n = Number(process.env.LOG_RETENTION_DAYS);
    if (Number.isFinite(n) && n >= 0) next.logRetentionDays = Math.floor(n);
  }
  if (process.env.PRO_MAX_USERS != null && process.env.PRO_MAX_USERS !== '') {
    next.proMaxUsers = parseSeatLimit(process.env.PRO_MAX_USERS, 3);
  }
  if (process.env.PRO_PLUS_MAX_USERS != null && process.env.PRO_PLUS_MAX_USERS !== '') {
    next.proPlusMaxUsers = parseSeatLimit(process.env.PRO_PLUS_MAX_USERS, 5);
  }
  // The X Subscription（Plus / Premium / Super / Ultra）席位；兼容 PREMIUM_MAX_USERS
  const xRaw = process.env.X_MAX_USERS ?? process.env.PREMIUM_MAX_USERS;
  if (xRaw != null && xRaw !== '') {
    next.xMaxUsers = parseSeatLimit(xRaw, 3);
  }
  if (process.env.BLOCK_SPEEDING_SWITCH != null && process.env.BLOCK_SPEEDING_SWITCH !== '') {
    next.blockSpeedingSwitch = parseBoolFlag(process.env.BLOCK_SPEEDING_SWITCH);
  }
  if (
    process.env.BLOCK_SPEEDING_SWITCH_ADMIN_EXEMPT != null &&
    process.env.BLOCK_SPEEDING_SWITCH_ADMIN_EXEMPT !== ''
  ) {
    next.blockSpeedingSwitchAdminExempt = parseBoolFlag(
      process.env.BLOCK_SPEEDING_SWITCH_ADMIN_EXEMPT,
    );
  }
  if (process.env.NOTIFY_CHANNEL != null) {
    next.notifyChannel = String(process.env.NOTIFY_CHANNEL).trim().toLowerCase();
  }
  if (process.env.NOTIFY_BOT_ID != null) {
    next.notifyBotId = String(process.env.NOTIFY_BOT_ID).trim();
  }
  if (process.env.NOTIFY_HOUR != null && process.env.NOTIFY_HOUR !== '') {
    const n = Number(process.env.NOTIFY_HOUR);
    if (Number.isFinite(n) && n >= 0 && n <= 23) next.notifyHour = Math.floor(n);
  }
  if (process.env.NOTIFY_MINUTE != null && process.env.NOTIFY_MINUTE !== '') {
    const n = Number(process.env.NOTIFY_MINUTE);
    if (Number.isFinite(n) && n >= 0 && n <= 59) next.notifyMinute = Math.floor(n);
  }
  if (process.env.EXPIRING_WITHIN_DAYS != null && process.env.EXPIRING_WITHIN_DAYS !== '') {
    const n = Number(process.env.EXPIRING_WITHIN_DAYS);
    if (Number.isFinite(n) && n >= 0) next.expiringWithinDays = Math.floor(n);
  }
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
    const vars = parseEnvFile(raw);
    fileEnvKeys = new Set(Object.keys(vars));
    applyParsedEnv(vars);
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

/**
 * 在线重载 .env：重新读取文件，回写「首次来自文件」的键后重建运行时配置。
 * 仅覆盖来自文件的键，外部注入（Docker/CI）的环境变量仍优先；SESSION_SECRET 缺省沿用当前值避免登录态失效。
 * 存储驱动 / 监听地址等需重启才生效的项不在本函数内处理（由调用方提示）。
 * @returns {Promise<AppConfig>}
 */
export async function reloadAppConfig() {
  let vars = {};
  try {
    const raw = await readFile(ENV_PATH, 'utf8');
    vars = parseEnvFile(raw);
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }
  // 回写之前来自文件的键（新增或更新），文件里删掉的键从 process.env 摘掉
  for (const key of fileEnvKeys) {
    if (key in vars) process.env[key] = vars[key];
    else delete process.env[key];
  }
  // 文件里新出现的键也写入
  for (const [key, value] of Object.entries(vars)) {
    if (!fileEnvKeys.has(key)) process.env[key] = value;
  }
  fileEnvKeys = new Set(Object.keys(vars));

  const prevSecret = runtime.sessionSecret;
  runtime = configFromProcessEnv();
  runtime.sqlitePath = resolveDataPath(runtime.sqlitePath);

  if (!runtime.sessionSecret) {
    const secret = prevSecret || randomBytes(24).toString('hex');
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

/** @returns {number} data/log 日志保留天数，0 表示不自动删除 */
export function getLogRetentionDays() {
  const n = getAppConfig().logRetentionDays;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 30;
}

export function getAccountUserLimits() {
  const config = getAppConfig();
  return {
    pro: { ...config.proMaxUsers },
    proPlus: { ...config.proPlusMaxUsers },
    x: { ...config.xMaxUsers },
  };
}

/** 是否禁止切换到超速账号；默认关闭。 */
export function getBlockSpeedingSwitch() {
  return Boolean(getAppConfig().blockSpeedingSwitch);
}

/** 管理员是否豁免「禁止切换超速账号」；默认开启。 */
export function getBlockSpeedingSwitchAdminExempt() {
  return Boolean(getAppConfig().blockSpeedingSwitchAdminExempt);
}

/** 额度重置「临期」阈值（天，含到期日）；看板筛选与企微推送共用。 */
export function getExpiringWithinDays() {
  const n = getAppConfig().expiringWithinDays;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 7;
}

/**
 * 通知通道配置。channel+botId 都有才算启用；目前仅 wecom。
 * @returns {{ enabled: boolean, channel: string, botId: string, hour: number, minute: number }}
 */
export function getNotifyConfig() {
  const config = getAppConfig();
  const channel = String(config.notifyChannel || '')
    .trim()
    .toLowerCase();
  const botId = String(config.notifyBotId || '').trim();
  const hour = Number.isFinite(config.notifyHour) ? config.notifyHour : 9;
  const minute = Number.isFinite(config.notifyMinute) ? config.notifyMinute : 30;
  return {
    enabled: Boolean(channel && botId),
    channel,
    botId,
    hour,
    minute,
  };
}

export function getConfigPath() {
  return ENV_PATH;
}
