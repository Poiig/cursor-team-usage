/**
 * 账号自动刷新到期判定。
 * 对外只有一个周期：距上次同步满 intervalSec，或额度重置已过需补偿刷。
 */

/**
 * 是否已到该账号的自动刷新时机。
 * @param {{ lastSyncedAt?: string | null, lastSnapshot?: { window?: { resetIso?: string } } }} member
 * @param {number} intervalSec 每账号同步周期（秒）
 * @param {number} [nowMs]
 */
export function isMemberDue(member, intervalSec, nowMs = Date.now()) {
  if (!member?.lastSyncedAt) return true;
  const syncedMs = Date.parse(member.lastSyncedAt);
  if (!Number.isFinite(syncedMs)) return true;

  // 订阅/额度重置已过，但上次同步仍早于重置 → 补偿刷，避免旧周期挂着
  const resetMs = Date.parse(member?.lastSnapshot?.window?.resetIso || '');
  if (Number.isFinite(resetMs) && nowMs >= resetMs && syncedMs < resetMs) return true;

  return nowMs - syncedMs >= intervalSec * 1000;
}
