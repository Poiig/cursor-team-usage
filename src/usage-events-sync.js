/**
 * 用量事件增量同步：按 watermark 拉 Cursor，upsert 到本地库。
 */

import { sessionFromCookie } from './auth.js';
import {
  fetchUsageEventsMerged,
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
 * 详情页：用落库 usage_events 校正今日模型 / Top models（避免旧快照 count 或整窗冒充今日）。
 * @param {any} member
 */
export async function enrichPublicMemberFromEvents(member) {
  if (!member) return null;
  const pub = toPublicMember(member);
  const snap = pub.lastSnapshot;
  if (!snap) return pub;
  const now = Date.now();
  try {
    const todayEvents = await listUsageEventsInRange(member.id, localDayStartMs(now), now + 1);
    const todayModels = topModelsByTokens(todayEvents, '', 8);
    const todayTokens = todayEvents.reduce(
      (s, e) => s + (Number(e.totalTokens) || 0),
      0,
    );
    const todayDollars =
      Math.round(
        (todayEvents.reduce((s, e) => s + (Number(e.chargedCents) || 0), 0) / 100) * 100,
      ) / 100;
    snap.spend = {
      ...(snap.spend || {}),
      todayModels,
      todayModelsFallback: false,
      today: {
        ...(snap.spend?.today || {}),
        tokens: todayTokens,
        requests: todayEvents.length,
        dollars: todayDollars,
        estimated: true,
      },
    };

    const hasTokenTop =
      Array.isArray(snap.usage?.topModels) &&
      snap.usage.topModels.some((m) => Number(m?.tokens) > 0);
    if (!hasTokenTop) {
      const start = Date.parse(snap.window?.startIso || '');
      const endRaw = Date.parse(snap.window?.endIso || '');
      const end = Number.isFinite(endRaw) ? Math.min(endRaw, now) : now;
      if (Number.isFinite(start) && end > start) {
        const cycleEvents = await listUsageEventsInRange(member.id, start, end + 1);
        const usage = summarizeEvents(cycleEvents);
        if (usage.topModels?.length) {
          snap.usage = {
            ...(snap.usage || {}),
            topModels: usage.topModels,
            totalTokens: Number(snap.usage?.totalTokens) || usage.totalTokens,
            requestCount: Number(snap.usage?.requestCount) || usage.requestCount,
          };
        }
      }
    }
  } catch {
    // 读库失败时仍返回原快照，不挡详情页
  }
  return pub;
}
