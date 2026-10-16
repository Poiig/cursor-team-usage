/**
 * 一键切换 Cursor 账号：网页发起 → 一次性票据 → 扩展领取并写入本机登录态。
 * 票据只活在内存里（含会话 Token），审计轨迹落库 account_switch_logs。
 */

import { randomUUID } from 'node:crypto';
import { decodeJwtPayload, jwtFromCookie, sessionFromCookie } from './auth.js';
import { getMemberCapacity } from './account-presence.js';
import { getPublicUser } from './users.js';
import {
  getAllMembersInternal,
  getMemberInternal,
  getSwitchLog,
  insertSwitchLog,
  listSwitchLogs,
  updateSwitchLog,
} from './store.js';

/** 票据有效期：2 分钟，够打开 Cursor 并领取。 */
const TICKET_TTL_MS = 2 * 60 * 1000;
/** 领取后插件确认框最多等 2 分钟，再留余量；超过仍无回报多半是 Cursor 卡住或被关掉。 */
export const CLAIMED_STALE_MS = 5 * 60 * 1000;
/** 票据只在内存，服务重启后未领取的日志会永远停在 pending。 */
export const PENDING_STALE_MS = 10 * 60 * 1000;

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

/**
 * 判断一条切换日志是否已卡住太久，返回要写入的失效原因；仍在正常窗口内返回 null。
 * 标 expired 而非 failed：插件若之后补报结果，finishAccountSwitch 仍可覆盖。
 * @param {{ status?: string, createdAt?: string, claimedAt?: string | null }} log
 * @param {number} [nowMs]
 */
export function staleSwitchReason(log, nowMs = Date.now()) {
  if (log?.status === 'claimed') {
    const at = Date.parse(log.claimedAt || log.createdAt || '');
    if (Number.isFinite(at) && nowMs - at > CLAIMED_STALE_MS) {
      return '本机已领取但 5 分钟内未回报结果（疑似 Cursor 卡住或被关闭）';
    }
  }
  if (log?.status === 'pending') {
    const at = Date.parse(log.createdAt || '');
    if (Number.isFinite(at) && nowMs - at > PENDING_STALE_MS) {
      return '切换票据已失效（未领取，或服务重启后票据丢失）';
    }
  }
  return null;
}

/** 清掉过期票据，并把卡在 pending / claimed 的日志收尾为 expired。 */
async function sweepExpiredTickets() {
  const now = Date.now();
  for (const [id, t] of tickets) {
    if (t.expiresAt > now) continue;
    tickets.delete(id);
    if (t.claimed) continue;
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
  try {
    for (const log of await listSwitchLogs({ limit: 200 })) {
      const reason = staleSwitchReason(log, now);
      if (!reason) continue;
      await updateSwitchLog(log.id, {
        status: 'expired',
        error: reason,
        finishedAt: new Date().toISOString(),
      });
    }
  } catch {
    /* 忽略收尾失败，不影响发起 / 领取 */
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
 * 按成员表首次上报写入的 hostname 认本机原账号；同机多条时取最早创建。
 * hostname 只在入库时写一次、续报不改，适合作为「本机号」锚点。
 * @param {Array<{ hostname?: string | null, createdAt?: string | null }>} members
 * @param {string} hostname
 */
export function pickHomeMemberByHostname(members, hostname) {
  const host = String(hostname || '')
    .trim()
    .toLowerCase();
  if (!host) return null;
  const matches = (members || []).filter(
    (m) =>
      String(m?.hostname || '')
        .trim()
        .toLowerCase() === host,
  );
  if (!matches.length) return null;
  matches.sort((a, b) =>
    String(a.createdAt || '').localeCompare(String(b.createdAt || '')),
  );
  return matches[0];
}

/**
 * 无本地 home 备份时：用主机名在号池里找回本机原注册账号的可写入会话。
 * @param {string} hostname
 * @returns {Promise<null | { memberId: string, displayName: string, email: string | null, auth: ReturnType<typeof buildLocalAuthPayload> }>}
 */
export async function resolveHomeAccountForHostname(hostname) {
  const member = pickHomeMemberByHostname(await getAllMembersInternal(), hostname);
  if (!member?.cookieValue) return null;
  const auth = buildLocalAuthPayload(member.cookieValue, { email: member.email });
  return {
    memberId: member.id,
    displayName: member.displayName || member.email || member.id,
    email: member.email || null,
    auth,
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
