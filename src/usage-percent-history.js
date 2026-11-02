/**
 * 账单周期额度百分比的按日快照：用于对比昨日增量与日用量图表。
 * Cursor 返回的是周期累计%，日用量 = 今日累计 − 昨日累计。
 */

import { localDayKey } from './cursor-api.js';

/** 保留天数；超出则丢弃最旧记录。 */
const KEEP_DAYS = 60;

/**
 * @param {unknown} n
 * @returns {number | null}
 */
function num(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
}

/**
 * 从快照取出 Total / Cursor Models / Other Models 累计百分比。
 * @param {any} snapshot
 * @returns {{ total: number | null, auto: number | null, api: number | null }}
 */
export function percentsFromSnapshot(snapshot) {
  const m = snapshot?.meters || snapshot?.planMeters || {};
  return {
    total: num(m.totalPercentUsed ?? m.primaryPercent),
    auto: num(m.autoPercentUsed),
    api: num(m.apiPercentUsed),
  };
}

/**
 * 本地日历的「昨天」yyyy-MM-dd。
 * @param {number} [nowMs]
 */
export function yesterdayDayKey(nowMs = Date.now()) {
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  return localDayKey(start.getTime() - 86400000);
}

/**
 * 按日期 upsert 一条累计%快照，并裁剪长度。
 * @param {Array<{ date: string, total?: number | null, auto?: number | null, api?: number | null }> | null | undefined} history
 * @param {{ date: string, total?: number | null, auto?: number | null, api?: number | null }} row
 */
export function upsertUsagePercentDay(history, row) {
  const next = Array.isArray(history) ? history.filter((r) => r && r.date !== row.date) : [];
  next.push({
    date: row.date,
    total: row.total ?? null,
    auto: row.auto ?? null,
    api: row.api ?? null,
  });
  next.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return next.slice(-KEEP_DAYS);
}

/**
 * 同步成功时写入「今天」的最新累计%，供日终对比与图表。
 * @param {unknown} history
 * @param {any} snapshot
 * @param {number} [nowMs]
 */
export function recordSyncPercents(history, snapshot, nowMs = Date.now()) {
  const p = percentsFromSnapshot(snapshot);
  if (p.total == null && p.auto == null && p.api == null) {
    return Array.isArray(history) ? history : [];
  }
  return upsertUsagePercentDay(history, { date: localDayKey(nowMs), ...p });
}

/**
 * 凌晨归档：用当前快照盖写「昨天」收盘累计%（周期%不过零点，当前值即昨日收盘）。
 * @param {unknown} history
 * @param {any} snapshot
 * @param {number} [nowMs]
 */
export function archiveYesterdayPercents(history, snapshot, nowMs = Date.now()) {
  const p = percentsFromSnapshot(snapshot);
  if (p.total == null && p.auto == null && p.api == null) {
    return Array.isArray(history) ? history : [];
  }
  return upsertUsagePercentDay(history, { date: yesterdayDayKey(nowMs), ...p });
}

/**
 * 进度条标签 → 历史字段名。
 * @param {string} label
 * @returns {'total' | 'auto' | 'api' | null}
 */
export function fieldForProgressLabel(label) {
  if (label === 'Total usage') return 'total';
  if (label === 'Cursor Models') return 'auto';
  if (label === 'Other Models') return 'api';
  return null;
}

/**
 * 相邻两日累计差；换周期 / 新开通导致「今日 < 昨日」时按从 0 起算（用今日累计值）。
 * @param {number} current
 * @param {number} previous
 */
export function percentDayDelta(current, previous) {
  const cur = Number(current);
  const prev = Number(previous);
  if (!Number.isFinite(cur) || !Number.isFinite(prev)) return null;
  const raw = Math.round((cur - prev) * 10) / 10;
  // 账单重置或新开账号：累计%回落，不能出现 -45% 这种差额
  if (raw < 0) return Math.round(cur * 10) / 10;
  return raw;
}

/**
 * 当前累计% 相对昨日收盘的差值（今日用量）。
 * 换周期回落时返回 null（标签不展示负差额）；图表用 dailyPercentDeltas。
 * @param {Array<{ date: string, total?: number | null, auto?: number | null, api?: number | null }> | null | undefined} history
 * @param {'total' | 'auto' | 'api'} field
 * @param {number | null | undefined} current
 * @param {number} [nowMs]
 * @returns {number | null}
 */
export function deltaVsYesterday(history, field, current, nowMs = Date.now()) {
  if (current == null || !Number.isFinite(Number(current))) return null;
  const yKey = yesterdayDayKey(nowMs);
  const y = (history || []).find((r) => r && r.date === yKey);
  const prev = y?.[field];
  if (prev == null || !Number.isFinite(Number(prev))) return null;
  const raw = Math.round((Number(current) - Number(prev)) * 10) / 10;
  // 进度条旁只展示正向「今日增量」；换周期不挂奇怪的负数
  if (raw < 0) return null;
  return raw;
}

/**
 * 排行「今日%」：有昨日则用日增量；换周期回落则用当前累计（视为新周期已用）。
 * @param {Array<{ date: string, total?: number | null, auto?: number | null, api?: number | null }> | null | undefined} history
 * @param {'total' | 'auto' | 'api'} field
 * @param {number | null | undefined} current
 * @param {number} [nowMs]
 */
export function todayUsagePercent(history, field, current, nowMs = Date.now()) {
  if (current == null || !Number.isFinite(Number(current))) return null;
  const yKey = yesterdayDayKey(nowMs);
  const y = (history || []).find((r) => r && r.date === yKey);
  const prev = y?.[field];
  if (prev == null || !Number.isFinite(Number(prev))) return null;
  return percentDayDelta(Number(current), Number(prev));
}

/**
 * 相邻两日累计%之差 → 每日用量序列（供柱状图）。
 * @param {Array<{ date: string, total?: number | null, auto?: number | null, api?: number | null }> | null | undefined} history
 * @param {'total' | 'auto' | 'api'} [field]
 * @returns {Array<{ date: string, value: number }>}
 */
export function dailyPercentDeltas(history, field = 'total') {
  const rows = [...(history || [])]
    .filter((r) => r && r.date && r[field] != null && Number.isFinite(Number(r[field])))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  /** @type {Array<{ date: string, value: number }>} */
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const value = percentDayDelta(rows[i][field], rows[i - 1][field]);
    if (value == null) continue;
    out.push({ date: rows[i].date, value });
  }
  return out;
}

/**
 * 距下一本地日零点的毫秒数，供凌晨归档定时器对齐时钟。
 * @param {number} [nowMs]
 */
export function msUntilNextLocalMidnight(nowMs = Date.now()) {
  const next = new Date(nowMs);
  next.setHours(24, 0, 0, 0);
  return Math.max(1000, next.getTime() - nowMs);
}
