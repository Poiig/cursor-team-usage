/**
 * 用量事件增量同步：按 watermark 拉 Cursor，upsert 到本地库。
 */

import { sessionFromCookie } from './auth.js';
import {
  aggregateSpendPeriods,
  currentCycleSpendLabel,
  fetchUsageEventsMerged,
  localDayKey,
  spendCellFromEvents,
  summarizeEvents,
  topModelsByTokens,
} from './cursor-api.js';
import {
  getUsageEventsMeta,
  getUsageEventsWatermark,
  listUsageEventsInRange,
  setPrevCycleSummary,
  toPublicMember,
  upsertUsageEvents,
} from './store.js';
import {
  previousCycleFinalPercents,
  previousCycleWindow,
  summarizeCycleEvents,
} from './billing-cycle.js';
import {
  computeUsageEventsSyncWindow,
  localDayStartMs,
  usageEventsNeedSync,
} from './usage-events.js';

/**
 * 按 watermark 增量拉取并落库（legacy + v2 billing 合并，避免漏事件）。
 * @param {string} memberId
 * @param {string} cookieValue
 * @param {{ nowMs?: number }} [opts]
 */
export async function syncMemberUsageEvents(memberId, cookieValue, opts = {}) {
  const session = sessionFromCookie(cookieValue);
  if (!session) throw new Error('会话 Token 格式无效');
  const watermark = await getUsageEventsWatermark(memberId);
  const { startMs, endMs } = computeUsageEventsSyncWindow(watermark, opts.nowMs);
  const events = await fetchUsageEventsMerged(session, startMs, endMs);
  const result = await upsertUsageEvents(memberId, events);
  return {
    upserted: result.upserted,
    fetched: events.length,
    startMs,
    endMs,
    watermark,
  };
}

/**
 * 库空或超过 stale 阈值时才 sync；force=true 跳过判断。
 * @param {string} memberId
 * @param {string} cookieValue
 * @param {{ force?: boolean, nowMs?: number }} [opts]
 */
export async function ensureMemberUsageEventsSynced(memberId, cookieValue, opts = {}) {
  const meta = await getUsageEventsMeta(memberId);
  if (!opts.force && !usageEventsNeedSync(meta, opts.nowMs)) {
    return { skipped: true, meta };
  }
  const sync = await syncMemberUsageEvents(memberId, cookieValue, opts);
  return { skipped: false, meta, ...sync };
}

/** 周期刚结束时 Cursor 可能还在补写最后几笔事件，过了这段时间才把汇总当终值落库。 */
const PREV_CYCLE_SETTLE_MS = 60 * 60 * 1000;

/**
 * 上个账单周期统计：已落库且周期一致直接读库；否则向 Cursor 拉该时间窗全部事件，
 * 成功则把汇总写回名册，失败则用本地 usage_events 兜底（不落汇总，下次再试）。
 * @param {any} member 内部成员（含 cookieValue / lastSnapshot / prevCycleSummary）
 * @param {{ nowMs?: number }} [opts]
 */
export async function loadPreviousCycle(member, opts = {}) {
  const window = previousCycleWindow(member?.lastSnapshot);
  if (!window) {
    const err = new Error('尚无当前账单周期信息，请先刷新一次用量');
    err.status = 409;
    throw err;
  }
  const startIso = new Date(window.startMs).toISOString();
  const endIso = new Date(window.endMs).toISOString();
  // 收尾使用率可能在换周期后才补进 cycleHistory，每次现算，不进缓存
  const finalPercents = previousCycleFinalPercents(member, window);

  const stored = member?.prevCycleSummary;
  if (stored?.startIso === startIso && stored?.endIso === endIso) {
    return { ...stored, source: 'stored', fetchError: null, finalPercents };
  }

  let events;
  let source = 'cursor';
  let fetchError = null;
  try {
    const session = sessionFromCookie(member.cookieValue);
    if (!session) throw new Error('会话 Token 格式无效');
    events = await fetchUsageEventsMerged(session, window.startMs, window.endMs - 1);
    // 远端统计只有与本地事件同时成功时才可缓存为周期终值，避免下次无从兜底。
    await upsertUsageEvents(member.id, events);
  } catch (e) {
    source = 'local';
    fetchError = e instanceof Error ? e.message : String(e);
    events = await listUsageEventsInRange(member.id, window.startMs, window.endMs);
  }
  const summary = { startIso, endIso, ...summarizeCycleEvents(events) };
  const nowMs = opts.nowMs ?? Date.now();
  if (source === 'cursor' && nowMs - window.endMs >= PREV_CYCLE_SETTLE_MS) {
    await setPrevCycleSummary(member.id, { ...summary, storedAt: new Date(nowMs).toISOString() });
  }
  return { ...summary, source, fetchError, finalPercents };
}

/**
 * 刷新成功后：把快照里临时挂的 _usageEvents 落库（不重复打官方）。
 * @param {string} memberId
 * @param {any} snapshot
 */
export async function persistSnapshotUsageEvents(memberId, snapshot) {
  const events = Array.isArray(snapshot?._usageEvents) ? snapshot._usageEvents : [];
  if (snapshot && '_usageEvents' in snapshot) delete snapshot._usageEvents;
  if (!events.length) return { upserted: 0 };
  return upsertUsageEvents(memberId, events);
}

/**
 * Cursor 事件接口失败时快照会把 spend.today/daily 写成 0；用本地 usage_events 回填。
 * 已有今日 tokens 时默认不改，避免覆盖刚拉到的官方数。
 * @param {string} memberId
 * @param {any} snapshot
 * @param {{ nowMs?: number, force?: boolean }} [opts]
 */
export async function fillSnapshotSpendFromLocalEvents(memberId, snapshot, opts = {}) {
  if (!memberId || !snapshot) return { filled: false, reason: 'no-snapshot' };
  const now = opts.nowMs ?? Date.now();
  const weekly =
    snapshot?.plan?.includedUsagePeriod === 'INCLUDED_USAGE_PERIOD_WEEKLY' ||
    snapshot?.planMeters?.includedUsagePeriod === 'INCLUDED_USAGE_PERIOD_WEEKLY';
  const start = Date.parse(snapshot.window?.startIso || '');
  const endRaw = Date.parse(snapshot.window?.endIso || '');
  // 有效窗右界夹到现在，避免把重置日后的事件算进当前周期。
  const end = Number.isFinite(endRaw) ? Math.min(endRaw, now) : now;

  /** 旧快照缺 cycle 时，只补当前周期，不动 Today / Last 30。 */
  async function fillCycleOnly() {
    if (!Number.isFinite(start) || end <= start) return { filled: false, reason: 'no-window' };
    const cycleEvents = await listUsageEventsInRange(memberId, start, end + 1);
    const cycleCell = spendCellFromEvents(cycleEvents);
    if (!cycleCell) return { filled: false, reason: 'no-cycle' };
    snapshot.spend = {
      ...(snapshot.spend || {}),
      cycle: cycleCell,
      cycleLabel: currentCycleSpendLabel(weekly),
      last30Label: snapshot.spend?.last30Label || 'Last 30 Days',
    };
    const hasTokenTop =
      Array.isArray(snapshot.usage?.topModels) &&
      snapshot.usage.topModels.some((m) => Number(m?.tokens) > 0);
    if (!hasTokenTop) {
      const usage = summarizeEvents(cycleEvents);
      if (usage.topModels?.length) {
        snapshot.usage = {
          ...(snapshot.usage || {}),
          topModels: usage.topModels,
          totalTokens: Number(snapshot.usage?.totalTokens) || usage.totalTokens,
          requestCount: Number(snapshot.usage?.requestCount) || usage.requestCount,
        };
      }
    }
    return { filled: true, reason: 'cycle-only', eventCount: cycleEvents.length };
  }

  const apiTodayTokens = Number(snapshot.spend?.today?.tokens) || 0;
  const needCycle = !snapshot.spend?.cycle || !(Number(snapshot.spend.cycle.tokens) > 0);
  if (!opts.force && apiTodayTokens > 0) {
    if (!needCycle) return { filled: false, reason: 'api-ok' };
    return fillCycleOnly();
  }

  const rangeStart = localDayStartMs(now) - 29 * 86400000;
  const events = await listUsageEventsInRange(memberId, rangeStart, now + 1);
  if (!events.length) {
    if (needCycle) return fillCycleOnly();
    return { filled: false, reason: 'no-local' };
  }

  const localSpend = aggregateSpendPeriods(events, now);
  const todayKey = localDayKey(localDayStartMs(now));
  const todayModels = topModelsByTokens(events, todayKey, 8);
  let cycleCell = snapshot.spend?.cycle || null;
  let cycleUsage = null;
  if (Number.isFinite(start) && end > start) {
    const cycleEvents = await listUsageEventsInRange(memberId, start, end + 1);
    cycleUsage = summarizeEvents(cycleEvents);
    cycleCell = spendCellFromEvents(cycleEvents) || cycleCell;
  }
  snapshot.spend = {
    ...(snapshot.spend || {}),
    today: localSpend.today,
    yesterday: localSpend.yesterday,
    last30: localSpend.last30,
    last30Label: 'Last 30 Days',
    cycle: cycleCell,
    cycleLabel: currentCycleSpendLabel(weekly),
    daily: localSpend.daily,
    todayModels,
    todayModelsFallback: false,
  };

  const hasTokenTop =
    Array.isArray(snapshot.usage?.topModels) &&
    snapshot.usage.topModels.some((m) => Number(m?.tokens) > 0);
  if (!hasTokenTop && cycleUsage?.topModels?.length) {
    snapshot.usage = {
      ...(snapshot.usage || {}),
      topModels: cycleUsage.topModels,
      totalTokens: Number(snapshot.usage?.totalTokens) || cycleUsage.totalTokens,
      requestCount: Number(snapshot.usage?.requestCount) || cycleUsage.requestCount,
    };
  }

  return {
    filled: true,
    todayTokens: Number(localSpend.today?.tokens) || 0,
    eventCount: events.length,
  };
}

/**
 * 详情/列表：用落库 usage_events 校正今日模型与 spend。
 * 入参若已挂席位（activeUsers 等），必须保留——toPublicMember 不含这些字段。
 * @param {any} member
 */
export async function enrichPublicMemberFromEvents(member) {
  if (!member) return null;
  const pub = {
    ...toPublicMember(member),
    ...(Array.isArray(member.activeUsers)
      ? {
          activeUsers: member.activeUsers,
          activeUserCount: member.activeUserCount,
          maxUsers: member.maxUsers,
          capacityFull: member.capacityFull,
        }
      : {}),
  };
  const snap = pub.lastSnapshot;
  if (!snap) return pub;
  try {
    await fillSnapshotSpendFromLocalEvents(member.id, snap);
  } catch {
    // 读库失败时仍返回原快照，不挡详情页
  }
  return pub;
}
