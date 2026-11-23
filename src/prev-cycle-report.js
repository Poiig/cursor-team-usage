/**
 * 上个账单周期团队报表：只读已落库 prevCycleSummary，区分周订 / 月订，并做套餐分群对比。
 */

import {
  cycleKindFromSnapshot,
  previousCycleFinalPercents,
  previousCycleWindow,
} from './billing-cycle.js';
import { hasCachedPrevCycle, isPrevCycleSettled, prevCycleNeedsPreload } from './usage-events-sync.js';
import { isFreePlan, planTierRank } from '../public/shared.js';

/**
 * @param {any} totals
 */
function emptyTotals() {
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

/**
 * @param {ReturnType<typeof emptyTotals>} acc
 * @param {any} totals
 */
function addTotals(acc, totals) {
  if (!totals) return acc;
  acc.requests += Number(totals.requests) || 0;
  acc.totalTokens += Number(totals.totalTokens) || 0;
  acc.inputTokens += Number(totals.inputTokens) || 0;
  acc.outputTokens += Number(totals.outputTokens) || 0;
  acc.cacheReadTokens += Number(totals.cacheReadTokens) || 0;
  acc.cacheWriteTokens += Number(totals.cacheWriteTokens) || 0;
  acc.dollars += Number(totals.dollars) || 0;
  acc.billedDollars += Number(totals.billedDollars) || 0;
  return acc;
}

/** @param {ReturnType<typeof emptyTotals>} t */
function roundTotals(t) {
  return {
    ...t,
    dollars: Math.round(t.dollars * 100) / 100,
    billedDollars: Math.round(t.billedDollars * 100) / 100,
  };
}

/**
 * 分析分群：Pro / Pro+ / XAI周订 / 其他。
 * 周订（The X / XAI）优先归 xai，不再拆进 Pro。
 * @param {{ cycleKind?: string | null, planName?: string | null, membershipType?: string | null }} account
 * @returns {'pro' | 'pro_plus' | 'xai' | 'other'}
 */
export function prevCycleCohortOf(account) {
  if (account?.cycleKind === 'weekly') return 'xai';
  const raw = `${account?.planName || ''} ${account?.membershipType || ''}`.trim().toLowerCase();
  if (
    raw.includes('super') ||
    raw.includes('pro_plus') ||
    raw.includes('proplus') ||
    raw.includes('pro plus') ||
    /(^|[^a-z])pro\+(?![a-z])/.test(raw)
  ) {
    return 'pro_plus';
  }
  if (raw.includes('premium') || raw === 'pro' || (/(^|[^a-z_])pro($|[^a-z_+])/.test(raw) && !raw.includes('plus'))) {
    return 'pro';
  }
  return 'other';
}

const COHORT_META = {
  pro: { id: 'pro', label: 'Pro / Premium', blurb: '遗留 Pro 与 The X Premium 等同档' },
  pro_plus: { id: 'pro_plus', label: 'Pro+ / Super', blurb: '遗留 Pro+ 与 The X Super；按量更常见' },
  xai: { id: 'xai', label: 'XAI / 周订', blurb: '周额度窗（含 Ultra 等），与月订不可直接加总' },
  other: { id: 'other', label: '其他', blurb: 'Plus / Team / Enterprise 等（不含 Free）' },
};

/**
 * @param {any[]} members 内部成员
 * @param {{ nowMs?: number }} [opts]
 */
export function buildPreviousCycleReport(members, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  /** @type {Map<string, { model: string, tokens: number, requests: number, dollars: number }>} */
  const modelMap = new Map();
  /** @type {any[]} */
  const accounts = [];

  let cached = 0;
  let missing = 0;
  let settling = 0;
  let noWindow = 0;

  for (const m of members || []) {
    // Free 不进任何上个周期报表统计
    if (isFreePlan(m)) continue;
    const snapshot = m?.lastSnapshot;
    const window = previousCycleWindow(snapshot);
    if (!window) {
      noWindow += 1;
      accounts.push({
        id: m.id,
        displayName: m.displayName || null,
        email: m.email || snapshot?.email || null,
        planName: m.planName || snapshot?.plan?.planName || null,
        membershipType: m.membershipType || snapshot?.plan?.membershipType || null,
        cycleKind: null,
        cohort: 'other',
        detailHref: `/detail.html?id=${encodeURIComponent(m.id)}`,
        status: 'no-window',
        cached: false,
        startIso: null,
        endIso: null,
        totals: null,
        finalPercents: null,
        topModels: [],
        storedAt: null,
      });
      continue;
    }

    const cycleKind = cycleKindFromSnapshot(snapshot);
    const startIso = new Date(window.startMs).toISOString();
    const endIso = new Date(window.endMs).toISOString();
    const match = hasCachedPrevCycle(m, window);
    const settled = isPrevCycleSettled(window, nowMs);
    let status = 'missing';
    if (match) {
      status = 'cached';
      cached += 1;
    } else if (!settled) {
      status = 'settling';
      settling += 1;
    } else {
      missing += 1;
    }

    const stored = match ? m.prevCycleSummary : null;
    const totals = stored?.totals || null;
    const topModels = Array.isArray(stored?.models)
      ? stored.models.slice(0, 8).map((row) => ({
          model: row.model,
          tokens: Number(row.totalTokens) || 0,
          requests: Number(row.requests) || 0,
          dollars: Number(row.dollars) || 0,
        }))
      : [];

    if (match && Array.isArray(stored?.models)) {
      for (const row of stored.models) {
        const model = String(row.model || 'unknown');
        const cur = modelMap.get(model) || { model, tokens: 0, requests: 0, dollars: 0 };
        cur.tokens += Number(row.totalTokens) || 0;
        cur.requests += Number(row.requests) || 0;
        cur.dollars += Number(row.dollars) || 0;
        modelMap.set(model, cur);
      }
    }

    const row = {
      id: m.id,
      displayName: m.displayName || null,
      email: m.email || snapshot?.email || null,
      planName: m.planName || snapshot?.plan?.planName || null,
      membershipType: m.membershipType || snapshot?.plan?.membershipType || null,
      cycleKind,
      status,
      cached: match,
      startIso: match ? stored.startIso : startIso,
      endIso: match ? stored.endIso : endIso,
      totals,
      finalPercents: previousCycleFinalPercents(m, window),
      topModels,
      storedAt: stored?.storedAt || null,
      needsPreload: prevCycleNeedsPreload(m, nowMs),
      detailHref:
        match && stored?.startIso && stored?.endIso
          ? `/detail.html?id=${encodeURIComponent(m.id)}&from=${encodeURIComponent(stored.startIso)}&to=${encodeURIComponent(stored.endIso)}`
          : `/detail.html?id=${encodeURIComponent(m.id)}&from=${encodeURIComponent(startIso)}&to=${encodeURIComponent(endIso)}`,
    };
    row.cohort = prevCycleCohortOf(row);
    accounts.push(row);
  }

  /**
   * 同套餐相邻，便于对比；档内再按 Tokens 降序。
   * @param {any} a
   * @param {any} b
   */
  function byPlanThenTokens(a, b) {
    const ra = planTierRank(a.planName, a.membershipType);
    const rb = planTierRank(b.planName, b.membershipType);
    if (ra !== rb) return ra - rb;
    const la = String(a.planName || a.membershipType || '').trim().toLowerCase();
    const lb = String(b.planName || b.membershipType || '').trim().toLowerCase();
    if (la !== lb) return la.localeCompare(lb, 'zh');
    const ta = Number(a.totals?.totalTokens) || 0;
    const tb = Number(b.totals?.totalTokens) || 0;
    if (tb !== ta) return tb - ta;
    return String(a.displayName || a.email || a.id || '').localeCompare(
      String(b.displayName || b.email || b.id || ''),
      'zh',
    );
  }

  /** @param {'weekly' | 'monthly'} kind */
  function bucket(kind) {
    const rows = accounts.filter((a) => a.cycleKind === kind);
    const withData = rows.filter((a) => a.cached && a.totals);
    const totals = roundTotals(
      withData.reduce((acc, a) => addTotals(acc, a.totals), emptyTotals()),
    );
    return {
      cycleKind: kind,
      label: kind === 'weekly' ? '上周额度（X / 周订）' : '上月账单（普通订阅）',
      accountCount: rows.length,
      cachedCount: withData.length,
      totals,
      accounts: rows.slice().sort(byPlanThenTokens),
    };
  }

  /** @param {'pro' | 'pro_plus' | 'xai' | 'other'} id */
  function cohortBucket(id) {
    const meta = COHORT_META[id];
    const rows = accounts.filter((a) => a.cohort === id);
    const withData = rows.filter((a) => a.cached && a.totals);
    const totals = roundTotals(
      withData.reduce((acc, a) => addTotals(acc, a.totals), emptyTotals()),
    );
    const usagePercents = withData
      .map((a) => a.finalPercents?.total)
      .filter((v) => v != null && Number.isFinite(Number(v)))
      .map(Number);
    const avgUsagePercent = usagePercents.length
      ? Math.round((usagePercents.reduce((s, v) => s + v, 0) / usagePercents.length) * 10) / 10
      : null;
    return {
      ...meta,
      accountCount: rows.length,
      cachedCount: withData.length,
      totals,
      avgUsagePercent,
      accounts: rows.slice().sort(byPlanThenTokens),
    };
  }

  const teamModels = [...modelMap.values()]
    .map((r) => ({
      ...r,
      dollars: Math.round(r.dollars * 100) / 100,
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 20);

  return {
    generatedAt: new Date(nowMs).toISOString(),
    note:
      '周订（XAI）与月订窗口不同，勿直接加总。金额分两列：用量价值含套餐内估值（Pro 常有）；按量花费仅 USAGE_BASED 实付（Pro 未超套餐常为 $0，Pro+ 更容易有）。',
    preload: {
      cached,
      missing,
      settling,
      noWindow,
      total: accounts.length,
    },
    weekly: bucket('weekly'),
    monthly: bucket('monthly'),
    cohorts: {
      pro: cohortBucket('pro'),
      pro_plus: cohortBucket('pro_plus'),
      xai: cohortBucket('xai'),
      other: cohortBucket('other'),
    },
    teamModels,
    accounts: accounts.slice().sort((a, b) => {
      const kindRank = { weekly: 0, monthly: 1 };
      const ka = kindRank[a.cycleKind] ?? 9;
      const kb = kindRank[b.cycleKind] ?? 9;
      if (ka !== kb) return ka - kb;
      return byPlanThenTokens(a, b);
    }),
  };
}
