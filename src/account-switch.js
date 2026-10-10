/**
 * 一键切换 Cursor 账号：网页发起 → 一次性票据 → 扩展领取并写入本机登录态。
 * 票据只活在内存里（含会话 Token），审计轨迹落库 account_switch_logs。
 */

import { randomUUID } from 'node:crypto';
import { decodeJwtPayload, jwtFromCookie, sessionFromCookie } from './auth.js';
import { getMemberCapacity } from './account-presence.js';
import { getPublicUser } from './users.js';
import {
  getMemberInternal,
  getSwitchLog,
  insertSwitchLog,
  listSwitchLogs,
  updateSwitchLog,
} from './store.js';

/** 票据有效期：2 分钟，够打开 Cursor 并领取。 */
const TICKET_TTL_MS = 2 * 60 * 1000;

/**
 * @typedef {{
 *   id: string,
 *   logId: string,
 *   memberId: string,
 *   operatorUsername: string,
 *   cookieValue: string,
 *   email?: string | null,
 *   displayName?: string | null,
 *   createdAt: number,
 *   expiresAt: number,
 *   claimed: boolean,
 * }} SwitchTicket
 */

/** @type {Map<string, SwitchTicket>} */
const tickets = new Map();

/** 清掉过期未领票据，并把对应日志标为 expired。 */
async function sweepExpiredTickets() {
  const now = Date.now();
  for (const [id, t] of tickets) {
    if (t.claimed) continue;
    if (t.expiresAt > now) continue;
    tickets.delete(id);
    try {
      const log = await getSwitchLog(t.logId);
      if (log && log.status === 'pending') {
        await updateSwitchLog(t.logId, {
          status: 'expired',
          error: '切换票据已过期（未在本机 Cursor 领取）',
          finishedAt: new Date().toISOString(),
        });
      }
    } catch {
      /* 忽略过期清理失败 */
    }
  }
}

/**
 * 从成员 cookie 抽出扩展写入本机 state.vscdb 所需字段。
 * @param {string} cookieValue
 * @param {{ email?: string | null }} [extra]
 */
export function buildLocalAuthPayload(cookieValue, extra = {}) {
  const session = sessionFromCookie(cookieValue);
  if (!session) throw new Error('会话 Token 无效，无法切换');
  const jwt = jwtFromCookie(session.cookieValue);
  if (!jwt) throw new Error('会话 Token 中缺少 JWT');
  const payload = decodeJwtPayload(jwt);
  if (!payload?.sub) throw new Error('会话 Token JWT 缺少 sub');
  const email = String(extra.email || '').trim() || null;
  const sub = String(payload.sub);
  const provider = sub.includes('|') ? sub.split('|')[0] : '';
  return {
    accessToken: jwt,
    refreshToken: jwt,
    cachedEmail: email,
    stripeMembershipAuthId: sub,
    cachedSignUpType: provider || null,
    userId: session.userId,
  };
}

/**
 * 从成员快照取 Total usage 百分比，写入切换日志做审计快照。
 * @param {{ lastSnapshot?: any, totalPercentUsed?: number | null } | null | undefined} member
 * @returns {number | null}
 */
export function usageTotalPercentOf(member) {
  if (!member) return null;
  const snap = member.lastSnapshot;
  const raw =
    snap?.meters?.totalPercentUsed ??
    snap?.meters?.primaryPercent ??
    member.totalPercentUsed ??
    null;
  if (raw == null || Number.isNaN(Number(raw))) return null;
  return Math.round(Number(raw) * 10) / 10;
}

/**
 * 切换前的统一可用性检查。额度已用完、尚无额度数据或同步异常都不能切换。
 * @param {any} member
 * @returns {string | null}
 */
export function switchBlockReason(member) {
  if (!member) return '成员不存在';
  if (member.lastError) return '该账号同步异常，请先更新 Token 后再切换';
  const used = usageTotalPercentOf(member);
  if (used == null) return '该账号尚无额度数据，请先刷新后再切换';
  if (used >= 100) return '该账号额度已用完，不能切换';
  if (
    member.maxUsers != null &&
    Number(member.activeUserCount || 0) >= Number(member.maxUsers)
  ) {
    return `当前使用人数已满（${member.activeUserCount}/${member.maxUsers}）`;
  }
  return null;
}

/**
 * 推荐最早到期且仍有额度的账号；没有重置日时排到最后。
 * @param {any[]} members
 */
export function recommendSwitchMember(members) {
  return (
    [...(members || [])]
      .filter((member) => !switchBlockReason(member))
      .sort((a, b) => {
        const aReset = Date.parse(a?.lastSnapshot?.window?.resetIso || '') || Infinity;
        const bReset = Date.parse(b?.lastSnapshot?.window?.resetIso || '') || Infinity;
        if (aReset !== bReset) return aReset - bReset;
        return (usageTotalPercentOf(b) || 0) - (usageTotalPercentOf(a) || 0);
      })[0] || null
  );
}

/**
 * 按操作者汇总切换报表（次数、用过几个号、IP、主机名）。
 * @param {import('./store-sqlite.js').SwitchLogRow[] | object[]} logs
 */
export function buildSwitchReport(logs) {
  /** @type {Map<string, { username: string, switchCount: number, successCount: number, memberIds: Set<string>, ips: Set<string>, hostnames: Set<string> }>} */
  const byUser = new Map();
  for (const log of logs || []) {
    const username = String(log.operatorUsername || '—');
    let row = byUser.get(username);
    if (!row) {
      row = {
        username,
        switchCount: 0,
        successCount: 0,
        memberIds: new Set(),
        ips: new Set(),
        hostnames: new Set(),
      };
      byUser.set(username, row);
    }
    row.switchCount += 1;
    if (log.status === 'success') row.successCount += 1;
    if (log.memberId) row.memberIds.add(String(log.memberId));
    if (log.clientIp) row.ips.add(String(log.clientIp));
    if (log.hostname) row.hostnames.add(String(log.hostname));
  }
  return [...byUser.values()]
    .map((r) => ({
      username: r.username,
      switchCount: r.switchCount,
      successCount: r.successCount,
      memberCount: r.memberIds.size,
      ips: [...r.ips].sort(),
      hostnames: [...r.hostnames].sort(),
    }))
    .sort((a, b) => b.switchCount - a.switchCount || a.username.localeCompare(b.username, 'zh'));
}

/**
 * 网页侧发起切换：写 pending 日志 + 发票据，返回 cursor:// URI。
 * @param {{ memberId: string, operatorUsername: string, clientIp?: string | null }} input
 */
export async function createAccountSwitch(input) {
  await sweepExpiredTickets();
  const operator = await getPublicUser(input.operatorUsername);
  if (!operator || operator.disabled || operator.pending) {
    const err = new Error('当前账号不能切换');
    err.status = 403;
    throw err;
  }
  const member = await getMemberInternal(input.memberId);
  const capacity = member ? await getMemberCapacity(member) : {};
  const checkedMember = member ? { ...member, ...capacity } : null;
  const blocked = switchBlockReason(checkedMember);
  if (blocked) {
    const err = new Error(blocked);
    err.status = 400;
    throw err;
  }
  // 先校验 Token 能解析，避免发了票据却写不进本机
  buildLocalAuthPayload(member.cookieValue, { email: member.email });

  const ticketId = randomUUID();
  const logId = randomUUID();
  const now = Date.now();
  const ticket = {
    id: ticketId,
    logId,
    memberId: member.id,
    operatorUsername: input.operatorUsername,
    cookieValue: member.cookieValue,
    email: member.email ?? null,
    displayName: member.displayName,
    createdAt: now,
    expiresAt: now + TICKET_TTL_MS,
    claimed: false,
  };
  tickets.set(ticketId, ticket);

  await insertSwitchLog({
    id: logId,
    operatorUsername: input.operatorUsername,
    memberId: member.id,
    memberDisplayName: member.displayName,
    memberEmail: member.email ?? null,
    memberUserId: member.userId,
    status: 'pending',
    ticketId,
    clientIp: input.clientIp ? String(input.clientIp).trim() || null : null,
    usageTotalPercent: usageTotalPercentOf(member),
  });

  const uri = `cursor://poiig.cursor-team-usage-reporter/switch?ticket=${encodeURIComponent(ticketId)}`;
  return {
    ticketId,
    logId,
    expiresAt: new Date(ticket.expiresAt).toISOString(),
    uri,
    member: {
      id: member.id,
      displayName: member.displayName,
      email: member.email ?? null,
    },
  };
}

/**
 * 扩展用 Access Key 领取票据；一次性，领取后内存票据标记 claimed。
 * @param {{ ticketId: string, hostname?: string }} input
 */
export async function claimAccountSwitch(input) {
  await sweepExpiredTickets();
  const ticketId = String(input.ticketId || '').trim();
  const ticket = tickets.get(ticketId);
  if (!ticket) {
    const err = new Error('切换票据无效或已过期');
    err.status = 410;
    throw err;
  }
  if (ticket.claimed) {
    const err = new Error('切换票据已被领取');
    err.status = 409;
    throw err;
  }
  if (Date.now() > ticket.expiresAt) {
    tickets.delete(ticketId);
    await updateSwitchLog(ticket.logId, {
      status: 'expired',
      error: '切换票据已过期',
      finishedAt: new Date().toISOString(),
    });
    const err = new Error('切换票据已过期');
    err.status = 410;
    throw err;
  }
  const operator = await getPublicUser(ticket.operatorUsername);
  if (!operator || operator.disabled || operator.pending) {
    tickets.delete(ticketId);
    await updateSwitchLog(ticket.logId, {
      status: 'failed',
      error: '操作者已禁用或未审批',
      finishedAt: new Date().toISOString(),
    });
    const err = new Error('操作者已禁用或未审批');
    err.status = 403;
    throw err;
  }

  ticket.claimed = true;
  const hostname = input.hostname ? String(input.hostname).trim() : null;
  const claimedAt = new Date().toISOString();
  await updateSwitchLog(ticket.logId, {
    status: 'claimed',
    hostname,
    claimedAt,
  });

  const auth = buildLocalAuthPayload(ticket.cookieValue, { email: ticket.email });
  return {
    logId: ticket.logId,
    ticketId: ticket.id,
    memberId: ticket.memberId,
    displayName: ticket.displayName,
    operatorUsername: ticket.operatorUsername,
    auth,
  };
}

/**
 * 扩展回报切换结果（成功或失败）。
 * @param {{ logId: string, ok: boolean, error?: string, hostname?: string }} input
 */
export async function finishAccountSwitch(input) {
  const logId = String(input.logId || '').trim();
  const log = await getSwitchLog(logId);
  if (!log) throw new Error('切换记录不存在');
  if (log.status === 'success' || log.status === 'failed') {
    return log;
  }
  const finishedAt = new Date().toISOString();
  if (input.ok) {
    return updateSwitchLog(logId, {
      status: 'success',
      error: null,
      hostname: input.hostname ?? log.hostname,
      finishedAt,
    });
  }
  return updateSwitchLog(logId, {
    status: 'failed',
    error: String(input.error || '切换失败'),
    hostname: input.hostname ?? log.hostname,
    finishedAt,
  });
}

/** @param {{ limit?: number }} [opts] */
export async function listAccountSwitchLogs(opts) {
  await sweepExpiredTickets();
  return listSwitchLogs(opts);
}

/**
 * 管理员报表：操作者维度汇总 + 最近明细（含 IP / 主机 / Total usage）。
 * @param {{ limit?: number }} [opts]
 */
export async function getSwitchReport(opts = {}) {
  await sweepExpiredTickets();
  const limit = Math.min(500, Math.max(1, Number(opts.limit) || 500));
  const logs = await listSwitchLogs({ limit });
  return {
    operators: buildSwitchReport(logs),
    recent: logs.slice(0, 100),
    sampled: logs.length,
  };
}
