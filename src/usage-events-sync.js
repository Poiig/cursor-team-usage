/**
 * 用量事件增量同步：按 watermark 拉 Cursor，upsert 到本地库。
 */

import { sessionFromCookie } from './auth.js';
import { fetchDashboardUsage } from './cursor-api.js';
import {
  getUsageEventsMeta,
  getUsageEventsWatermark,
  upsertUsageEvents,
} from './store.js';
import {
  computeUsageEventsSyncWindow,
  usageEventsNeedSync,
} from './usage-events.js';

/**
 * 按 watermark 增量拉取并落库。
 * @param {string} memberId
 * @param {string} cookieValue
 * @param {{ nowMs?: number }} [opts]
 */
export async function syncMemberUsageEvents(memberId, cookieValue, opts = {}) {
  const session = sessionFromCookie(cookieValue);
  if (!session) throw new Error('会话 Token 格式无效');
  const watermark = await getUsageEventsWatermark(memberId);
  const { startMs, endMs } = computeUsageEventsSyncWindow(watermark, opts.nowMs);
  const events = await fetchDashboardUsage(session, startMs, endMs);
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
