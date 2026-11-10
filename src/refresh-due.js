/**
 * 账号自动刷新到期判定：常规间隔 + 额度重置前后优先补刷。
 */

/** 重置前多久开始优先补刷。 */
export const RESET_REFRESH_AHEAD_MS = 10 * 60 * 1000;
/** 临近重置时的最短复刷间隔，避免狂刷。 */
export const RESET_REFRESH_MIN_GAP_MS = 60 * 1000;

/**
 * 是否已到该账号的自动刷新时机。
 * 重置已过且上次同步仍早于重置 → 立刻补刷；快到重置也提前刷，便于状态按新额度排序。
 * @param {{ lastSyncedAt?: string | null, lastSnapshot?: { window?: { resetIso?: string } } }} member
 * @param {number} intervalSec 距上次同步的常规刷新间隔（秒）
 * @param {number} [nowMs]
 */
export function isMemberDue(member, intervalSec, nowMs = Date.now()) {
  if (!member?.lastSyncedAt) return true;
  const syncedMs = Date.parse(member.lastSyncedAt);
  if (!Number.isFinite(syncedMs)) return true;

  const resetMs = Date.parse(member?.lastSnapshot?.window?.resetIso || '');
  if (Number.isFinite(resetMs)) {
    // 重置已过、快照仍是旧周期：立刻补刷，避免 100% 挂在临期
    if (nowMs >= resetMs && syncedMs < resetMs) return true;
    // 快到重置：提前刷一次
    if (
      resetMs > nowMs &&
      resetMs - nowMs <= RESET_REFRESH_AHEAD_MS &&
      nowMs - syncedMs >= RESET_REFRESH_MIN_GAP_MS
    ) {
      return true;
    }
  }

  return nowMs - syncedMs >= intervalSec * 1000;
}
