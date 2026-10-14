/**
 * 名册行上与 Token / 拉取用量相关的列值抽取，供 sqlite / pg / file 共用。
 */

import { tokenExpiresAtIso } from './auth.js';

/** 人工录入（网页添加 / 粘贴 / 邮箱 / 本机导入）优先于插件上报。 */
export const MEMBER_SOURCE_MANUAL = 'manual';
/** 插件首次上报建号；同账号后续上报可轮换 Token。 */
export const MEMBER_SOURCE_REPORT = 'report';

/**
 * 归一化来源；缺省按「上报」——兼容旧数据，避免误锁导致无法续 Token。
 * @param {unknown} raw
 * @returns {'manual' | 'report'}
 */
export function normalizeMemberSource(raw) {
  return String(raw || '').trim() === MEMBER_SOURCE_MANUAL
    ? MEMBER_SOURCE_MANUAL
    : MEMBER_SOURCE_REPORT;
}

/**
 * 人工录入账号：插件上报不得覆盖其会话 Token。
 * @param {unknown} source
 */
export function isManualMemberSource(source) {
  return normalizeMemberSource(source) === MEMBER_SOURCE_MANUAL;
}

/** @param {unknown} n @returns {number | null} */
function numOrNull(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

/**
 * 从 cookie 解析 Token 过期时间，写入 token_expires_at 列。
 * @param {string} cookieValue
 * @returns {string | null}
 */
export function tokenExpiresAtFromCookie(cookieValue) {
  return tokenExpiresAtIso(cookieValue);
}

/**
 * 从用量快照抽出可独立落列的摘要，避免只靠 JSON 才能查配额/花费。
 * @param {any} snapshot
 */
export function pulledColumnsFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return {
      email: null,
      planName: null,
      membershipType: null,
      totalPercentUsed: null,
      spendToday: null,
      spendYesterday: null,
      spendLast30: null,
      hardLimit: null,
    };
  }
  const spend = snapshot.spend || {};
  return {
    email: snapshot.email ? String(snapshot.email) : null,
    planName: snapshot.plan?.planName != null ? String(snapshot.plan.planName) : null,
    membershipType:
      snapshot.plan?.membershipType != null ? String(snapshot.plan.membershipType) : null,
    totalPercentUsed: numOrNull(
      snapshot.meters?.totalPercentUsed ?? snapshot.meters?.primaryPercent,
    ),
    spendToday: numOrNull(spend.today?.dollars),
    spendYesterday: numOrNull(spend.yesterday?.dollars),
    spendLast30: numOrNull(spend.last30?.dollars),
    hardLimit: numOrNull(snapshot.hardLimit),
  };
}
