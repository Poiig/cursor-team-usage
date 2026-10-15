/**
 * 上个账单周期：时间窗、收尾使用率留存、按事件汇总（纯函数，便于单测）。
 */

import { localDayKey } from './cursor-api.js';
import { percentsFromSnapshot } from './usage-percent-history.js';

/** 快照里最多留几个周期的收尾使用率。 */
const KEEP_CYCLES = 6;

/**
 * Cursor Models 额度只含 Auto 与 Composer；cursor-grok 等托管第三方模型算 Other。
 * @param {string} model
 */
export function isCursorModel(model) {
  const m = String(model || '').toLowerCase();
  return m === 'auto' || m === 'default' || m.includes('composer');
}

/**
 * 当前周期起点往前推一个自然月，得到上个周期窗口。
 * @param {any} snapshot
 * @returns {{ startMs: number, endMs: number } | null}
 */
export function previousCycleWindow(snapshot) {
  const endMs = Date.parse(snapshot?.window?.startIso || '');
  if (!Number.isFinite(endMs)) return null;
  const start = new Date(endMs);
  start.setUTCMonth(start.getUTCMonth() - 1);
  return { startMs: start.getTime(), endMs };
}

/**
 * 新快照进入新周期时，把旧快照的收尾使用率记进 cycleHistory 并带到新快照。
 * @param {any} prevSnapshot
 * @param {any} nextSnapshot
 */
export function carryCycleHistory(prevSnapshot, nextSnapshot) {
  if (!nextSnapshot) return nextSnapshot;
  const history = Array.isArray(prevSnapshot?.cycleHistory) ? [...prevSnapshot.cycleHistory] : [];
  const prevStart = prevSnapshot?.window?.startIso;
  const nextStart = nextSnapshot?.window?.startIso;
  // 起点挪动超过一天才算换周期，避免接口偶发的秒级抖动被当成重置
  if (prevStart && nextStart && Date.parse(nextStart) - Date.parse(prevStart) > 86400000) {
    const p = percentsFromSnapshot(prevSnapshot);
    if (!history.some((row) => row.startIso === prevStart)) {
      history.push({
        startIso: prevStart,
        endIso: prevSnapshot.window.endIso || nextStart,
        ...p,
        closedAt: prevSnapshot.syncedAt || null,
      });
    }
  }
  nextSnapshot.cycleHistory = history.slice(-KEEP_CYCLES);
  return nextSnapshot;
}

/**
 * 上个周期收尾使用率：优先周期切换时的留存；没有则用重置前一日的日终快照近似。
 * @param {any} member
 * @param {{ startMs: number, endMs: number }} window
 * @returns {{ total: number|null, auto: number|null, api: number|null, approximate: boolean, closedAt?: string|null } | null}
 */
export function previousCycleFinalPercents(member, window) {
  const startIso = new Date(window.startMs).toISOString();
  const exact = (member?.lastSnapshot?.cycleHistory || []).find(
    (row) => Math.abs(Date.parse(row.startIso) - window.startMs) < 60_000 || row.startIso === startIso,
  );
  if (exact) {
    return {
      total: exact.total ?? null,
      auto: exact.auto ?? null,
      api: exact.api ?? null,
      approximate: false,
      closedAt: exact.closedAt ?? null,
    };
  }
  const lastDay = localDayKey(window.endMs - 86400000);
  const row = (member?.usagePercentHistory || [])
    .filter((r) => r?.date && r.date <= lastDay && r.date >= localDayKey(window.startMs))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  if (!row) return null;
  return {
    total: row.total ?? null,
    auto: row.auto ?? null,
    api: row.api ?? null,
    approximate: true,
    closedAt: row.date,
  };
}

/** @param {any} e */
function eventTokens(e) {
  return (
    (e.inputTokens || 0) + (e.outputTokens || 0) + (e.cacheReadTokens || 0) + (e.cacheWriteTokens || 0)
  );
}

/** 与 Today / Yesterday 卡片同口径：有计费用计费，否则用按量价值。 */
function eventDollars(e) {
  if (e.chargedCents != null && e.chargedCents > 0) return e.chargedCents / 100;
  if (e.tokenCents != null && e.tokenCents > 0) return e.tokenCents / 100;
  return 0;
}

const round2 = (n) => Math.round(n * 100) / 100;
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

function emptyBucket() {
  return {
    requests: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    dollars: 0,
    billedDollars: 0,
  };
}

function addTo(bucket, e) {
  bucket.requests += 1;
  bucket.totalTokens += eventTokens(e);
  bucket.inputTokens += e.inputTokens || 0;
  bucket.outputTokens += e.outputTokens || 0;
  bucket.cacheReadTokens += e.cacheReadTokens || 0;
  bucket.cacheWriteTokens += e.cacheWriteTokens || 0;
  bucket.dollars += eventDollars(e);
  if (e.chargedCents != null && e.chargedCents > 0) bucket.billedDollars += e.chargedCents / 100;
}

/** 金额取两位，并附上占总量的百分比。 */
function finish(bucket, totals) {
  return {
    ...bucket,
    dollars: round2(bucket.dollars),
    billedDollars: round2(bucket.billedDollars),
    requestShare: pct(bucket.requests, totals.requests),
    tokenShare: pct(bucket.totalTokens, totals.totalTokens),
    dollarShare: pct(bucket.dollars, totals.dollars),
  };
}

/**
 * 周期内事件汇总：总量、按模型、Cursor/Other 分组、按类型、按日。
 * @param {any[]} events
 */
export function summarizeCycleEvents(events) {
  const totals = emptyBucket();
  /** @type {Map<string, ReturnType<typeof emptyBucket>>} */
  const byModel = new Map();
  /** @type {Map<string, ReturnType<typeof emptyBucket>>} */
  const byKind = new Map();
  const groups = { cursor: emptyBucket(), other: emptyBucket() };
  /** @type {Map<string, { requests: number, tokens: number, dollars: number }>} */
  const byDay = new Map();

  for (const e of events || []) {
    addTo(totals, e);
    const model = String(e.model || 'unknown');
    if (!byModel.has(model)) byModel.set(model, emptyBucket());
    addTo(byModel.get(model), e);
    const kind = String(e.kindLabel || e.kind || '未知');
    if (!byKind.has(kind)) byKind.set(kind, emptyBucket());
    addTo(byKind.get(kind), e);
    addTo(isCursorModel(model) ? groups.cursor : groups.other, e);
    const day = localDayKey(Number(e.timestamp) < 1e12 ? Number(e.timestamp) * 1000 : Number(e.timestamp));
    const d = byDay.get(day) || { requests: 0, tokens: 0, dollars: 0 };
    d.requests += 1;
    d.tokens += eventTokens(e);
    d.dollars += eventDollars(e);
    byDay.set(day, d);
  }

  return {
    totals: { ...totals, dollars: round2(totals.dollars), billedDollars: round2(totals.billedDollars) },
    models: [...byModel.entries()]
      .map(([model, b]) => ({ model, isCursor: isCursorModel(model), ...finish(b, totals) }))
      .sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests),
    groups: { cursor: finish(groups.cursor, totals), other: finish(groups.other, totals) },
    kinds: [...byKind.entries()]
      .map(([kind, b]) => ({ kind, ...finish(b, totals) }))
      .sort((a, b) => b.requests - a.requests),
    daily: [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, d]) => ({ date, requests: d.requests, tokens: d.tokens, dollars: round2(d.dollars) })),
  };
}
