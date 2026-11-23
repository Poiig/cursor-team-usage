/**
 * 上个账单周期：时间窗、收尾使用率留存、按事件汇总（纯函数，便于单测）。
 */

import { eventBilledCents, localDayKey } from './cursor-api.js';
import { exhaustionFromPercentDays, isSyntheticBillingWindow } from '../public/shared.js';
import { percentsFromSnapshot } from './usage-percent-history.js';

export { isSyntheticBillingWindow };

/**
 * Cursor Models 额度只含 Auto 与 Composer；cursor-grok 等托管第三方模型算 Other。
 * @param {string} model
 */
export function isCursorModel(model) {
  const m = String(model || '').toLowerCase();
  return m === 'auto' || m === 'default' || m.includes('composer');
}

const WEEK_MS = 7 * 86400000;

/**
 * 当前窗是否像周额度（The X / XAI 订阅）而非自然月账单。
 * @param {any} snapshot
 */
export function isWeeklyUsageWindow(snapshot) {
  if (
    snapshot?.plan?.includedUsagePeriod === 'INCLUDED_USAGE_PERIOD_WEEKLY' ||
    snapshot?.planMeters?.includedUsagePeriod === 'INCLUDED_USAGE_PERIOD_WEEKLY'
  ) {
    return true;
  }
  const start = Date.parse(snapshot?.window?.startIso || '');
  const end = Date.parse(snapshot?.window?.endIso || '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
  const dur = end - start;
  return dur >= 6 * 86400000 && dur <= 8 * 86400000;
}

/** @param {any} snapshot @returns {'weekly' | 'monthly'} */
export function cycleKindFromSnapshot(snapshot) {
  return isWeeklyUsageWindow(snapshot) ? 'weekly' : 'monthly';
}

/**
 * 当前周期起点往前推一窗，得到上个周期窗口。
 * 周额度 −7 天；否则按自然月 −1。
 * @param {any} snapshot
 * @returns {{ startMs: number, endMs: number } | null}
 */
export function previousCycleWindow(snapshot) {
  const endMs = Date.parse(snapshot?.window?.startIso || '');
  if (!Number.isFinite(endMs)) return null;
  if (isWeeklyUsageWindow(snapshot)) {
    return { startMs: endMs - WEEK_MS, endMs };
  }
  const start = new Date(endMs);
  start.setUTCMonth(start.getUTCMonth() - 1);
  return { startMs: start.getTime(), endMs };
}

/**
 * 正式周期改走 member_billing_cycles；快照里不再堆 cycleHistory（顺手清空旧假窗）。
 * @param {any} _prevSnapshot
 * @param {any} nextSnapshot
 */
export function carryCycleHistory(_prevSnapshot, nextSnapshot) {
  if (!nextSnapshot) return nextSnapshot;
  nextSnapshot.cycleHistory = [];
  return nextSnapshot;
}

/**
 * 账号各订阅周期用量摘要（当前 + cycleHistory），含「何时用完」。
 * 按 startIso 新→旧；详情页分页展示。
 * @param {any} member
 * @param {{ nowMs?: number }} [opts]
 * @returns {Array<{
 *   startIso: string,
 *   endIso: string | null,
 *   current: boolean,
 *   cycleKind: 'weekly' | 'monthly' | null,
 *   total: number | null,
 *   auto: number | null,
 *   api: number | null,
 *   exhaustedDate: string | null,
 *   daysToExhaust: number | null,
 *   peakTotal: number | null,
 *   daySamples: number,
 *   closedAt: string | null,
 * }>}
 */
export function buildMemberCycleUsageRows(member, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const snap = member?.lastSnapshot;
  const history = Array.isArray(member?.usagePercentHistory) ? member.usagePercentHistory : [];
  /** @type {Map<string, any>} */
  const byStart = new Map();

  const push = (row) => {
    if (!row?.startIso) return;
    const key = row.startIso;
    const prev = byStart.get(key);
    // 同起点优先保留「当前周期」或更新的收尾
    if (prev && !row.current && prev.current) return;
    byStart.set(key, row);
  };

  for (const c of snap?.cycleHistory || []) {
    if (isSyntheticBillingWindow(c)) continue;
    push(enrichCycleUsageRow(c, history, false, snap, nowMs));
  }

  if (snap?.window?.startIso && !isSyntheticBillingWindow(snap.window)) {
    const p = percentsFromSnapshot(snap);
    push(
      enrichCycleUsageRow(
        {
          startIso: snap.window.startIso,
          endIso: snap.window.endIso || null,
          planName: snap?.plan?.planName || null,
          membershipType: snap?.plan?.membershipType || null,
          ...p,
          closedAt: snap.syncedAt || null,
        },
        history,
        true,
        snap,
        nowMs,
      ),
    );
  } else if (snap?.window?.startIso && isSyntheticBillingWindow(snap.window)) {
    // 当前仍是估窗：照样展示进度，但标成不可靠，避免当成真·月订 20 天
    const p = percentsFromSnapshot(snap);
    push(
      enrichCycleUsageRow(
        {
          startIso: snap.window.startIso,
          endIso: snap.window.endIso || null,
          planName: snap?.plan?.planName || null,
          membershipType: snap?.plan?.membershipType || null,
          synthetic: true,
          ...p,
          closedAt: snap.syncedAt || null,
        },
        history,
        true,
        snap,
        nowMs,
      ),
    );
  }

  return [...byStart.values()].sort(
    (a, b) =>
      (Date.parse(b.startIso) || 0) - (Date.parse(a.startIso) || 0) ||
      (a.current === b.current ? 0 : a.current ? -1 : 1),
  );
}

/** @param {any} raw @param {any} snap */
function cycleKindOfRow(raw, snap, current) {
  if (raw?.cycleKind === 'weekly' || raw?.cycleKind === 'monthly') return raw.cycleKind;
  if (current) return cycleKindFromSnapshot(snap);
  const s = Date.parse(raw?.startIso || '');
  const e = Date.parse(raw?.endIso || '');
  if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
    const dur = e - s;
    if (dur >= 6 * 86400000 && dur <= 8 * 86400000) return 'weekly';
    return 'monthly';
  }
  return cycleKindFromSnapshot(snap);
}

/**
 * @param {any} raw
 * @param {Array<{ date: string, total?: number | null, auto?: number | null, api?: number | null }>} history
 * @param {boolean} current
 * @param {any} snap
 * @param {number} nowMs
 */
function enrichCycleUsageRow(raw, history, current, snap, nowMs) {
  const startMs = Date.parse(raw.startIso);
  const endMs = Date.parse(raw.endIso || '') || nowMs;
  const startDay = Number.isFinite(startMs) ? localDayKey(startMs) : '';
  // 终点按半开区间：结束日不计入本周期
  const lastDay = Number.isFinite(endMs) ? localDayKey(Math.max(startMs || endMs, endMs - 1)) : localDayKey(nowMs);
  const days = history.filter(
    (r) => r?.date && (!startDay || r.date >= startDay) && (!lastDay || r.date <= lastDay),
  );
  const total = raw.total ?? null;
  const ex = exhaustionFromPercentDays(days, startDay, total);
  const planName =
    raw.planName ||
    (current ? snap?.plan?.planName : null) ||
    raw.membershipType ||
    (current ? snap?.plan?.membershipType : null) ||
    null;
  const membershipType =
    raw.membershipType || (current ? snap?.plan?.membershipType : null) || null;
  return {
    startIso: raw.startIso,
    endIso: raw.endIso || null,
    current: Boolean(current),
    cycleKind: cycleKindOfRow(raw, snap, current),
    planName,
    membershipType,
    total: total == null ? null : Number(total),
    auto: raw.auto ?? null,
    api: raw.api ?? null,
    exhaustedDate: ex.exhaustedDate,
    daysToExhaust: ex.daysToExhaust,
    peakTotal: ex.peakTotal,
    daySamples: ex.daySamples,
    closedAt: raw.closedAt || null,
  };
}

/**
 * 任意账单窗收尾使用率：当前窗用快照；历史优先 cycleHistory，否则用按日%近似。
 * @param {any} member
 * @param {{ startMs: number, endMs: number }} window
 * @returns {{ total: number|null, auto: number|null, api: number|null, approximate: boolean, closedAt?: string|null, current?: boolean } | null}
 */
export function cycleWindowFinalPercents(member, window) {
  const curStart = Date.parse(member?.lastSnapshot?.window?.startIso || '');
  if (Number.isFinite(curStart) && Math.abs(curStart - window.startMs) < 60_000) {
    const p = percentsFromSnapshot(member.lastSnapshot);
    if (p.total == null && p.auto == null && p.api == null) return null;
    return {
      ...p,
      approximate: false,
      closedAt: member.lastSnapshot?.syncedAt || null,
      current: true,
    };
  }
  return previousCycleFinalPercents(member, window);
}

/**
 * 上个周期收尾使用率：优先周期切换时的留存；没有则用重置前一日的日终快照近似。
 * @param {any} member
 * @param {{ startMs: number, endMs: number }} window
 * @returns {{ total: number|null, auto: number|null, api: number|null, approximate: boolean, closedAt?: string|null } | null}
 */
export function previousCycleFinalPercents(member, window) {
  const startIso = new Date(window.startMs).toISOString();
  const matchStart = (iso) =>
    Boolean(iso) &&
    (iso === startIso || Math.abs(Date.parse(iso) - window.startMs) < 60_000);

  const exact = (member?.lastSnapshot?.cycleHistory || []).find((row) => matchStart(row.startIso));
  if (exact) {
    return {
      total: exact.total ?? null,
      auto: exact.auto ?? null,
      api: exact.api ?? null,
      approximate: false,
      closedAt: exact.closedAt ?? null,
    };
  }

  // 落库摘要有收尾%才用；只有事件汇总（无%）时继续走按日近似
  const stored = member?.prevCycleSummary;
  if (
    stored &&
    matchStart(stored.startIso) &&
    (stored.total != null || stored.auto != null || stored.api != null)
  ) {
    return {
      total: stored.total ?? null,
      auto: stored.auto ?? null,
      api: stored.api ?? null,
      approximate: false,
      closedAt: stored.closedAt ?? stored.storedAt ?? null,
    };
  }
  const closed = member?.billingCycles?.previous;
  if (
    closed &&
    matchStart(closed.startIso) &&
    (closed.totalPct != null ||
      closed.total != null ||
      closed.autoPct != null ||
      closed.auto != null ||
      closed.apiPct != null ||
      closed.api != null)
  ) {
    return {
      total: closed.totalPct ?? closed.total ?? null,
      auto: closed.autoPct ?? closed.auto ?? null,
      api: closed.apiPct ?? closed.api ?? null,
      approximate: false,
      closedAt: closed.closedAt ?? null,
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

/**
 * 给上个周期摘要补上收尾%、用完日、套餐（事件汇总本身没有这些字段）。
 * @param {any} member
 * @param {{ startMs: number, endMs: number }} window
 * @param {object} summary
 */
export function withPrevCycleUsageMeta(member, window, summary) {
  const base = summary && typeof summary === 'object' ? { ...summary } : {};
  const fp = previousCycleFinalPercents(member, window) || {};
  const startDay = localDayKey(window.startMs);
  const lastDay = localDayKey(Math.max(window.startMs, window.endMs - 1));
  const days = (member?.usagePercentHistory || []).filter(
    (r) => r?.date && r.date >= startDay && r.date <= lastDay,
  );
  const total = base.total ?? fp.total ?? null;
  const ex = exhaustionFromPercentDays(days, startDay, total);
  return {
    ...base,
    planName:
      base.planName || member?.planName || member?.lastSnapshot?.plan?.planName || null,
    membershipType:
      base.membershipType ||
      member?.membershipType ||
      member?.lastSnapshot?.plan?.membershipType ||
      null,
    total,
    auto: base.auto ?? fp.auto ?? null,
    api: base.api ?? fp.api ?? null,
    peakTotal: base.peakTotal ?? ex.peakTotal,
    exhaustedDate: base.exhaustedDate ?? ex.exhaustedDate,
    daysToExhaust: base.daysToExhaust ?? ex.daysToExhaust,
  };
}

/** @param {any} e */
function eventTokens(e) {
  return (
    (e.inputTokens || 0) + (e.outputTokens || 0) + (e.cacheReadTokens || 0) + (e.cacheWriteTokens || 0)
  );
}

/**
 * 用量价值（美分）：套餐内 Included 也计（官方事件上的 chargedCents / tokenCents），
 * 便于 Pro 等同档对比；不是用户实付按量。
 */
function eventUsageValueCents(e) {
  const charged = Number(e?.chargedCents);
  if (Number.isFinite(charged) && charged > 0) return charged;
  const token = Number(e?.tokenCents);
  if (Number.isFinite(token) && token > 0) return token;
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
  // dollars = 用量价值（含套餐内）；billedDollars = 仅 USAGE_BASED 按量实付
  bucket.dollars += eventUsageValueCents(e) / 100;
  bucket.billedDollars += eventBilledCents(e) / 100;
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
    const d = byDay.get(day) || { requests: 0, tokens: 0, dollars: 0, billedDollars: 0 };
    d.requests += 1;
    d.tokens += eventTokens(e);
    d.dollars += eventUsageValueCents(e) / 100;
    d.billedDollars += eventBilledCents(e) / 100;
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
      .map(([date, d]) => ({
        date,
        requests: d.requests,
        tokens: d.tokens,
        dollars: round2(d.dollars),
        billedDollars: round2(d.billedDollars || 0),
      })),
  };
}
