/**
 * 本地 JSON 名册（遗留）：STORE_DRIVER=file 时使用；默认已改为 sqlite。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskToken, sessionFromCookie, tokenExpiresAtIso } from './auth.js';
import {
  isManualMemberSource,
  MEMBER_SOURCE_MANUAL,
  MEMBER_SOURCE_REPORT,
  normalizeMemberSource,
  pulledColumnsFromSnapshot,
  tokenExpiresAtFromCookie,
} from './store-member-fields.js';
import { recordSyncPercents } from './usage-percent-history.js';
import { carryCycleHistory } from './billing-cycle.js';
import { createSideDataApi } from './store-side-data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'members.json');
const USERS_PATH = path.join(DATA_DIR, 'users.json');

/** @type {ReturnType<typeof createSideDataApi> | null} */
let side = null;

/**
 * @typedef {{
 *   id: string,
 *   displayName: string,
 *   cookieValue: string,
 *   userId: string,
 *   email?: string,
 *   hostname?: string | null,
 *   source?: 'manual' | 'report',
 *   tokenExpiresAt?: string | null,
 *   planName?: string | null,
 *   membershipType?: string | null,
 *   totalPercentUsed?: number | null,
 *   spendToday?: number | null,
 *   spendYesterday?: number | null,
 *   spendLast30?: number | null,
 *   hardLimit?: number | null,
 *   createdAt: string,
 *   updatedAt: string,
 *   lastSnapshot?: object | null,
 *   lastError?: string | null,
 *   lastSyncedAt?: string | null,
 *   usagePercentHistory?: Array<{ date: string, total?: number | null, auto?: number | null, api?: number | null }>,
 * }} Member
 */

/** 文件存储：侧数据仍走 JSON，API 与 sqlite/pg 对齐。 */
export async function init() {
  side = createSideDataApi({ kind: 'file', dataDir: DATA_DIR });
  await side.initSide();
}

function sideApi() {
  if (!side) throw new Error('侧数据未初始化');
  return side;
}

export async function loadPluginClientsMap() {
  return sideApi().loadPluginClientsMap();
}
/** @param {string} username @param {any} row */
export async function savePluginClient(username, row) {
  return sideApi().savePluginClient(username, row);
}
/** @param {string} username */
export async function deletePluginClient(username) {
  return sideApi().deletePluginClient(username);
}
/** @param {any} row */
export async function insertLoginEvent(row) {
  return sideApi().insertLoginEvent(row);
}
/** @param {number} limit */
export async function listLoginEvents(limit) {
  return sideApi().listLoginEvents(limit);
}
/** @param {any} row */
export async function insertReportEvent(row) {
  return sideApi().insertReportEvent(row);
}
/** @param {number} limit */
export async function listReportEvents(limit) {
  return sideApi().listReportEvents(limit);
}
export async function listApplications() {
  return sideApi().listApplications();
}
/** @param {any} row */
export async function upsertApplication(row) {
  return sideApi().upsertApplication(row);
}
/** @param {string} token */
export async function getApplicationByToken(token) {
  return sideApi().getApplicationByToken(token);
}
/** @param {any} row */
export async function insertAppLog(row) {
  return sideApi().insertAppLog(row);
}
/** @param {string} sinceIso @param {number} [limit] */
export async function listAppLogsForHydrate(sinceIso, limit) {
  return sideApi().listAppLogsForHydrate(sinceIso, limit);
}
/** @param {number} [max] */
export async function pruneLoginEvents(max) {
  return sideApi().pruneLoginEvents(max);
}
/** @param {number} [max] */
export async function pruneReportEvents(max) {
  return sideApi().pruneReportEvents(max);
}
/** @param {number} [max] */
export async function pruneApplications(max) {
  return sideApi().pruneApplications(max);
}
/** @param {string} isoCutoff */
export async function pruneAppLogsBefore(isoCutoff) {
  return sideApi().pruneAppLogsBefore(isoCutoff);
}
/** @param {number} [max] */
export async function pruneSwitchLogs(max) {
  return sideApi().pruneSwitchLogs(max);
}
/** @param {string} isoCutoff */
export async function prunePresenceBefore(isoCutoff) {
  return sideApi().prunePresenceBefore(isoCutoff);
}

/** @returns {Promise<{ members: Member[] }>} */
async function readStore() {
  try {
    const raw = await readFile(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return { members: Array.isArray(parsed.members) ? parsed.members : [] };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { members: [] };
    throw e;
  }
}

/**
 * @param {{ members: Member[] }} store
 */
async function writeStore(store) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

/**
 * @param {Member} m
 */
export function toPublicMember(m) {
  return {
    id: m.id,
    displayName: m.displayName,
    userId: m.userId,
    email: m.email ?? m.lastSnapshot?.email,
    hostname: m.hostname ?? null,
    source: normalizeMemberSource(m.source),
    tokenHint: maskToken(m.cookieValue),
    tokenExpiresAt: m.tokenExpiresAt ?? tokenExpiresAtIso(m.cookieValue),
    planName: m.planName ?? m.lastSnapshot?.plan?.planName ?? null,
    membershipType: m.membershipType ?? m.lastSnapshot?.plan?.membershipType ?? null,
    totalPercentUsed: m.totalPercentUsed ?? null,
    spendToday: m.spendToday ?? null,
    spendYesterday: m.spendYesterday ?? null,
    spendLast30: m.spendLast30 ?? null,
    hardLimit: m.hardLimit ?? null,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    lastSnapshot: m.lastSnapshot ?? null,
    lastError: m.lastError ?? null,
    lastSyncedAt: m.lastSyncedAt ?? null,
    usagePercentHistory: m.usagePercentHistory ?? [],
  };
}

export async function listMembers() {
  const store = await readStore();
  return store.members.map(toPublicMember);
}

/**
 * @param {{ displayName: string, sessionToken: string, hostname?: string }} input
 */
export async function addMember(input) {
  const displayName = String(input.displayName || '').trim();
  if (!displayName) throw new Error('请填写成员显示名');

  const session = sessionFromCookie(input.sessionToken);
  if (!session) throw new Error('会话 Token 无效，请粘贴 WorkosCursorSessionToken');

  const store = await readStore();
  if (store.members.some((m) => m.userId === session.userId)) {
    throw new Error(`该账号已在名册中（${session.userId}）`);
  }

  const now = new Date().toISOString();
  /** @type {Member} */
  const member = {
    id: randomUUID(),
    displayName,
    cookieValue: session.cookieValue,
    userId: session.userId,
    hostname: input.hostname ? String(input.hostname).trim() : null,
    source: MEMBER_SOURCE_MANUAL,
    tokenExpiresAt: tokenExpiresAtFromCookie(session.cookieValue),
    createdAt: now,
    updatedAt: now,
    lastSnapshot: null,
    lastError: null,
    lastSyncedAt: null,
  };
  store.members.push(member);
  await writeStore(store);
  return toPublicMember(member);
}

/**
 * @param {string} id
 * @param {{ displayName?: string, sessionToken?: string }} patch
 */
export async function updateMember(id, patch) {
  const store = await readStore();
  const idx = store.members.findIndex((m) => m.id === id);
  if (idx < 0) throw new Error('成员不存在');

  const member = store.members[idx];
  if (patch.displayName != null) {
    const name = String(patch.displayName).trim();
    if (!name) throw new Error('显示名不能为空');
    member.displayName = name;
  }
  if (patch.sessionToken != null && String(patch.sessionToken).trim()) {
    const session = sessionFromCookie(patch.sessionToken);
    if (!session) throw new Error('会话 Token 无效');
    if (store.members.some((m) => m.id !== id && m.userId === session.userId)) {
      throw new Error('该账号已绑定其他成员');
    }
    member.cookieValue = session.cookieValue;
    member.userId = session.userId;
    member.tokenExpiresAt = tokenExpiresAtFromCookie(session.cookieValue);
  }
  if (patch.hostname != null) {
    member.hostname = String(patch.hostname).trim() || null;
  }
  // 只有网页改 Token 才升为人工号；改显示名不应把插件上报号标成「人工」
  if (patch.sessionToken != null && String(patch.sessionToken).trim()) {
    member.source = MEMBER_SOURCE_MANUAL;
  }
  member.updatedAt = new Date().toISOString();
  store.members[idx] = member;
  await writeStore(store);
  return toPublicMember(member);
}

/**
 * 按 userId 上报会话：已存在则轮换 Token，否则新建。
 * @param {{ displayName?: string, sessionToken: string, email?: string, hostname?: string }} input
 */
export async function upsertMemberBySession(input) {
  const session = sessionFromCookie(input.sessionToken);
  if (!session) throw new Error('会话 Token 无效');

  const store = await readStore();
  const idx = store.members.findIndex((m) => m.userId === session.userId);
  const now = new Date().toISOString();
  const fallbackName =
    String(input.displayName || '').trim() ||
    String(input.email || '').trim() ||
    session.userId;
  const hostname = input.hostname != null ? String(input.hostname).trim() || null : null;
  const tokenExpiresAt = tokenExpiresAtFromCookie(session.cookieValue);

  if (idx >= 0) {
    const member = store.members[idx];
    const manualProtected = isManualMemberSource(member.source);
    member.cookieValue = session.cookieValue;
    member.userId = session.userId;
    member.tokenExpiresAt = tokenExpiresAt;
    // 上报不覆盖已有显示名 / 主机名 / source
    if (input.email) member.email = String(input.email).trim();
    member.updatedAt = now;
    store.members[idx] = member;
    await writeStore(store);
    return {
      member: toPublicMember(member),
      created: false,
      tokenUpdated: true,
      manualProtected,
    };
  }

  /** @type {Member} */
  const member = {
    id: randomUUID(),
    displayName: fallbackName,
    cookieValue: session.cookieValue,
    userId: session.userId,
    email: input.email ? String(input.email).trim() : undefined,
    hostname,
    source: MEMBER_SOURCE_REPORT,
    tokenExpiresAt,
    createdAt: now,
    updatedAt: now,
    lastSnapshot: null,
    lastError: null,
    lastSyncedAt: null,
  };
  store.members.push(member);
  await writeStore(store);
  return {
    member: toPublicMember(member),
    created: true,
    tokenUpdated: true,
    manualProtected: false,
  };
}

/** @param {string} id */
export async function deleteMember(id) {
  const store = await readStore();
  const next = store.members.filter((m) => m.id !== id);
  if (next.length === store.members.length) throw new Error('成员不存在');
  store.members = next;
  await writeStore(store);
}

/** file 驱动不持久化用量事件；接口保留以免门面报错。 */
export async function upsertUsageEvents() {
  return { upserted: 0 };
}

/** @returns {Promise<number | null>} */
export async function getUsageEventsWatermark() {
  return null;
}

/** @returns {Promise<{ count: number, syncedAt: string | null }>} */
export async function getUsageEventsMeta() {
  return { count: 0, syncedAt: null };
}

/**
 * @param {string} _memberId
 * @param {{ days?: number, page?: number, pageSize?: number }} [opts]
 */
export async function listUsageEvents(_memberId, opts = {}) {
  const days = Math.min(90, Math.max(1, Number(opts.days) || 7));
  const page = Math.max(1, Number(opts.page) || 1);
  const pageSize = Math.min(100, Math.max(10, Number(opts.pageSize) || 50));
  return {
    days,
    page,
    pageSize,
    total: 0,
    totalTokens: 0,
    hasNext: false,
    events: [],
    models: [],
    syncedAt: null,
  };
}

/** 文件存储不落用量事件。 */
export async function listUsageEventsInRange() {
  return [];
}

/** @param {string} id */
export async function getMemberInternal(id) {
  const store = await readStore();
  return store.members.find((m) => m.id === id) ?? null;
}

export async function getAllMembersInternal() {
  const store = await readStore();
  return store.members;
}

/**
 * @param {string} id
 * @param {{ snapshot?: object | null, error?: string | null }} result
 */
export async function saveSyncResult(id, result) {
  const store = await readStore();
  const idx = store.members.findIndex((m) => m.id === id);
  if (idx < 0) return;
  const member = store.members[idx];
  const now = new Date().toISOString();
  if (result.snapshot) {
    carryCycleHistory(member.lastSnapshot, result.snapshot);
    const pulled = pulledColumnsFromSnapshot(result.snapshot);
    member.lastSnapshot = result.snapshot;
    member.email = pulled.email ?? member.email;
    member.planName = pulled.planName;
    member.membershipType = pulled.membershipType;
    member.totalPercentUsed = pulled.totalPercentUsed;
    member.spendToday = pulled.spendToday;
    member.spendYesterday = pulled.spendYesterday;
    member.spendLast30 = pulled.spendLast30;
    member.hardLimit = pulled.hardLimit;
    // 同步时覆写「今天」累计%，凌晨归档再盖写昨天收盘值。
    member.usagePercentHistory = recordSyncPercents(
      member.usagePercentHistory,
      result.snapshot,
    );
    member.tokenExpiresAt = tokenExpiresAtFromCookie(member.cookieValue);
    member.lastError = null;
    member.lastSyncedAt = result.snapshot.syncedAt || now;
  } else {
    member.lastError = result.error ?? '同步失败';
    // 尚无成功快照时不推进 lastSyncedAt，便于按到期逻辑尽快重试。
    if (member.lastSnapshot) member.lastSyncedAt = now;
  }
  member.updatedAt = now;
  store.members[idx] = member;
  await writeStore(store);
  return toPublicMember(member);
}

/**
 * 写入按日额度%历史（凌晨归档用）。
 * @param {string} id
 * @param {Array<{ date: string, total?: number | null, auto?: number | null, api?: number | null }>} history
 */
export async function setUsagePercentHistory(id, history) {
  const store = await readStore();
  const idx = store.members.findIndex((m) => m.id === id);
  if (idx < 0) return;
  store.members[idx].usagePercentHistory = history || [];
  store.members[idx].updatedAt = new Date().toISOString();
  await writeStore(store);
}

/**
 * 写入上个账单周期汇总；周期已结束数据不再变，存一次后详情页直接读库。
 * 不推进 updatedAt：这是缓存，不算账号资料变更。
 * @param {string} id
 * @param {object} summary
 */
export async function setPrevCycleSummary(id, summary) {
  const store = await readStore();
  const member = store.members.find((m) => m.id === id);
  if (!member) return;
  member.prevCycleSummary = summary;
  await writeStore(store);
}

/**
 * @typedef {{
 *   username: string,
 *   passwordHash: string,
 *   salt: string,
 *   createdAt: string,
 *   mustChangePassword: boolean,
 * }} ConsoleAdmin
 */

/**
 * @typedef {{
 *   username: string,
 *   passwordHash: string,
 *   salt: string,
 *   role: 'admin' | 'user',
 *   createdAt: string,
 *   mustChangePassword: boolean,
 *   disabled: boolean,
 *   pending: boolean,
 *   alias: string,
 * }} ConsoleUserRow
 */

/**
 * @typedef {{
 *   id: string,
 *   createdAt: string,
 *   operatorUsername: string,
 *   memberId?: string | null,
 *   memberDisplayName?: string | null,
 *   memberEmail?: string | null,
 *   memberUserId?: string | null,
 *   hostname?: string | null,
 *   clientIp?: string | null,
 *   usageTotalPercent?: number | null,
 *   status: string,
 *   error?: string | null,
 *   ticketId?: string | null,
 *   claimedAt?: string | null,
 *   finishedAt?: string | null,
 * }} SwitchLogRow
 */

const SWITCH_LOGS_PATH = path.join(DATA_DIR, 'switch-logs.json');

/**
 * @returns {Promise<{ users: ConsoleUserRow[], admin?: ConsoleAdmin }>}
 */
async function readUsersFile() {
  try {
    const raw = await readFile(USERS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    /** @type {ConsoleUserRow[]} */
    let users = Array.isArray(parsed.users) ? parsed.users : [];
    // 遗留 { admin } → 迁入 users
    if (!users.length && parsed.admin && typeof parsed.admin === 'object') {
      users = [
        {
          username: 'admin',
          salt: String(parsed.admin.salt || ''),
          passwordHash: String(parsed.admin.passwordHash || ''),
          role: 'admin',
          createdAt: String(parsed.admin.createdAt || new Date().toISOString()),
          mustChangePassword: Boolean(parsed.admin.mustChangePassword),
          disabled: false,
          pending: false,
        },
      ];
    }
    // 旧 JSON 无 pending 时按已通过处理
    users = users.map((u) => ({
      ...u,
      pending: Boolean(u.pending),
      alias: String(u.alias || ''),
    }));
    return { users, admin: parsed.admin };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { users: [] };
    throw e;
  }
}

/**
 * @param {ConsoleUserRow[]} users
 */
async function writeUsersFile(users) {
  await mkdir(DATA_DIR, { recursive: true });
  const admin = users.find((u) => u.username === 'admin');
  const payload = {
    users,
    admin: admin
      ? {
          salt: admin.salt,
          passwordHash: admin.passwordHash,
          createdAt: admin.createdAt,
          mustChangePassword: admin.mustChangePassword,
        }
      : undefined,
  };
  await writeFile(USERS_PATH, JSON.stringify(payload, null, 2), 'utf8');
}

/** @returns {Promise<ConsoleUserRow[]>} */
export async function listConsoleUsers() {
  const { users } = await readUsersFile();
  return users;
}

/** @param {string} username */
export async function getConsoleUser(username) {
  const { users } = await readUsersFile();
  return users.find((u) => u.username === String(username || '')) ?? null;
}

/** @param {ConsoleUserRow} user */
export async function createConsoleUser(user) {
  const { users } = await readUsersFile();
  if (users.some((u) => u.username === user.username)) throw new Error('用户名已存在');
  users.push(user);
  await writeUsersFile(users);
}

/** @param {ConsoleUserRow} user */
export async function saveConsoleUser(user) {
  const { users } = await readUsersFile();
  const idx = users.findIndex((u) => u.username === user.username);
  if (idx >= 0) users[idx] = user;
  else users.push(user);
  await writeUsersFile(users);
}

/** @param {string} username */
export async function deleteConsoleUser(username) {
  const name = String(username || '');
  if (name === 'admin') throw new Error('不能删除 admin');
  const { users } = await readUsersFile();
  const next = users.filter((u) => u.username !== name);
  if (next.length === users.length) throw new Error('用户不存在');
  await writeUsersFile(next);
}

/** @returns {Promise<SwitchLogRow[]>} */
async function readSwitchLogs() {
  try {
    const raw = await readFile(SWITCH_LOGS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.logs) ? parsed.logs : [];
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
}

/** @param {SwitchLogRow[]} logs */
async function writeSwitchLogs(logs) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SWITCH_LOGS_PATH, JSON.stringify({ logs }, null, 2), 'utf8');
}

/** @param {Omit<SwitchLogRow, 'createdAt'> & { createdAt?: string }} log */
export async function insertSwitchLog(log) {
  const logs = await readSwitchLogs();
  /** @type {SwitchLogRow} */
  const row = {
    id: log.id,
    createdAt: log.createdAt || new Date().toISOString(),
    operatorUsername: log.operatorUsername,
    memberId: log.memberId ?? null,
    memberDisplayName: log.memberDisplayName ?? null,
    memberEmail: log.memberEmail ?? null,
    memberUserId: log.memberUserId ?? null,
    hostname: log.hostname ?? null,
    clientIp: log.clientIp ?? null,
    usageTotalPercent: log.usageTotalPercent ?? null,
    status: log.status,
    error: log.error ?? null,
    ticketId: log.ticketId ?? null,
    claimedAt: log.claimedAt ?? null,
    finishedAt: log.finishedAt ?? null,
  };
  logs.unshift(row);
  await writeSwitchLogs(logs.slice(0, 1000));
  return row;
}

/**
 * @param {string} id
 * @param {Partial<Pick<SwitchLogRow, 'status' | 'error' | 'hostname' | 'claimedAt' | 'finishedAt'>>} patch
 */
export async function updateSwitchLog(id, patch) {
  const logs = await readSwitchLogs();
  const idx = logs.findIndex((l) => l.id === id);
  if (idx < 0) throw new Error('切换记录不存在');
  const before = logs[idx];
  logs[idx] = {
    ...before,
    status: patch.status ?? before.status,
    error: patch.error !== undefined ? patch.error : before.error,
    hostname: patch.hostname !== undefined ? patch.hostname : before.hostname,
    claimedAt: patch.claimedAt !== undefined ? patch.claimedAt : before.claimedAt,
    finishedAt: patch.finishedAt !== undefined ? patch.finishedAt : before.finishedAt,
  };
  await writeSwitchLogs(logs);
  return logs[idx];
}

/** @param {{ limit?: number }} [opts] */
export async function listSwitchLogs(opts = {}) {
  const limit = Math.min(500, Math.max(1, Number(opts.limit) || 100));
  const logs = await readSwitchLogs();
  return logs.slice(0, limit);
}

/** @param {string} id */
export async function getSwitchLog(id) {
  const logs = await readSwitchLogs();
  return logs.find((l) => l.id === id) ?? null;
}

/** @returns {Promise<ConsoleAdmin | null>} */
export async function getConsoleAdmin() {
  const user = await getConsoleUser('admin');
  if (!user) return null;
  return {
    username: user.username,
    passwordHash: user.passwordHash,
    salt: user.salt,
    createdAt: user.createdAt,
    mustChangePassword: user.mustChangePassword,
  };
}

/**
 * @param {ConsoleAdmin} admin
 */
export async function saveConsoleAdmin(admin) {
  await saveConsoleUser({
    username: admin.username || 'admin',
    passwordHash: admin.passwordHash,
    salt: admin.salt,
    role: 'admin',
    createdAt: admin.createdAt,
    mustChangePassword: Boolean(admin.mustChangePassword),
    disabled: false,
    pending: false,
  });
}

const PRESENCE_PATH = path.join(DATA_DIR, 'account-presence.json');

/** 遗留 file 驱动仍用 JSON，与 sqlite/pg 的表形态对齐。 */
export async function loadAccountPresenceMap() {
  try {
    const parsed = JSON.parse(await readFile(PRESENCE_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    if (e && e.code === 'ENOENT') return {};
    throw e;
  }
}

/** @param {Record<string, any>} map */
export async function saveAccountPresenceMap(map) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(PRESENCE_PATH, JSON.stringify(map || {}, null, 2) + '\n', 'utf8');
}
