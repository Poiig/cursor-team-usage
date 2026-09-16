/**
 * 应用操作日志：落盘到 data/log，按日分文件，支持保留天数与过期清理。
 */

import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLogRetentionDays } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const LOG_DIR = path.join(ROOT_DIR, 'data', 'log');

/** @type {Promise<void>} */
let writeChain = Promise.resolve();

/**
 * 本地日历日期键，用于日志文件名 YYYY-MM-DD。
 * @param {Date} [d]
 */
export function logDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 当前日志文件绝对路径。
 * @param {Date} [d]
 */
export function logFilePathForDate(d = new Date()) {
  return path.join(LOG_DIR, `${logDateKey(d)}.log`);
}

/**
 * 格式化一行日志时间戳（本地时区）。
 * @param {Date} [d]
 */
function formatTimestamp(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}

/**
 * 账号可读标签，便于日志检索。
 * @param {{ id?: string, displayName?: string, email?: string, userId?: string, hostname?: string | null } | null | undefined} member
 */
export function memberLogLabel(member) {
  if (!member) return '未知账号';
  const name = (member.displayName || member.email || member.userId || member.id || '').trim();
  const parts = [name || '未命名'];
  if (member.id) parts.push(`id=${member.id}`);
  if (member.email && member.email !== name) parts.push(`email=${member.email}`);
  if (member.hostname) parts.push(`host=${member.hostname}`);
  return parts.join(' ');
}

/**
 * 把键值对拼成日志详情段。
 * @param {Record<string, unknown>} fields
 */
function formatFields(fields) {
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || v === '') continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}=${s}`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

/**
 * 串行追加写入，避免并发 append 交错。
 * @param {string} line
 */
async function appendLine(line) {
  writeChain = writeChain.then(async () => {
    await appendFile(logFilePathForDate(), `${line}\n`, 'utf8');
  });
  await writeChain;
}

/**
 * 写一条结构化操作日志。
 * @param {string} action 如 启动 / 注册 / 刷新 / 自动刷新
 * @param {Record<string, unknown>} [fields]
 */
export async function writeAppLog(action, fields = {}) {
  if (process.env.npm_lifecycle_event === 'test') return;
  const line = `[${formatTimestamp()}] [${action}]${formatFields(fields)}`;
  try {
    await appendLine(line);
  } catch (e) {
    console.error('写入应用日志失败:', e?.message || e);
  }
}

/**
 * 删除超过保留天数的 .log 文件（不含当天）。
 * @param {number} retentionDays
 * @param {Date} [now]
 * @param {string} [logDir]
 */
export async function pruneOldLogFiles(retentionDays, now = new Date(), logDir = LOG_DIR) {
  if (retentionDays <= 0) return 0;
  let removed = 0;
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - retentionDays);

  let names = [];
  try {
    names = await readdir(logDir);
  } catch (e) {
    if (e?.code === 'ENOENT') return 0;
    throw e;
  }

  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
    const key = name.slice(0, 10);
    const fileDate = new Date(`${key}T12:00:00`);
    if (Number.isNaN(fileDate.getTime())) continue;
    if (fileDate >= cutoff) continue;
    try {
      await unlink(path.join(logDir, name));
      removed += 1;
    } catch {
      /* 忽略单文件删除失败 */
    }
  }
  return removed;
}

/**
 * 启动时创建 log 目录并清理过期文件。
 */
export async function initAppLog() {
  if (process.env.npm_lifecycle_event === 'test') return;
  await mkdir(LOG_DIR, { recursive: true });
  const days = getLogRetentionDays();
  const removed = await pruneOldLogFiles(days);
  if (removed > 0) {
    console.log(`应用日志：已清理 ${removed} 个过期文件（保留 ${days} 天）`);
  }
}
