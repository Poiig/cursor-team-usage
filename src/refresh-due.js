/**
 * 账号自动刷新到期判定与失败退避。
 * 周期：距上次同步满 intervalSec，或额度重置已过需补偿刷。
 * 退避：429 / 鉴权失败 / 连续失败时 hold，避免齐刷撞限流。
 */

const MIN_BACKOFF_MS = 5 * 60 * 1000;
/** 与 Cursor Retry-After 账号级上限一致（约 1 小时）。 */
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const AUTH_BACKOFF_MS = 60 * 60 * 1000;

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

/**
 * 连续失败后的等待时长（毫秒）。
 * @param {number} failCount 已连续失败次数（含本次）
 * @param {{ auth?: boolean, retryAfterMs?: number | null }} [opts]
 */
export function nextRefreshBackoffMs(failCount, opts = {}) {
  if (opts.auth) return AUTH_BACKOFF_MS;
  const retryAfter = Number(opts.retryAfterMs);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(MAX_BACKOFF_MS, Math.max(retryAfter, 60 * 1000));
  }
  const n = Math.max(1, Number(failCount) || 1);
  return Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** (n - 1));
}

/**
 * @param {{ untilMs?: number } | null | undefined} hold
 * @param {number} [nowMs]
 */
export function isRefreshHeld(hold, nowMs = Date.now()) {
  const until = Number(hold?.untilMs);
  return Number.isFinite(until) && until > nowMs;
}
