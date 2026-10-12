/**
 * 本地 JSON 名册（遗留）：STORE_DRIVER=file 时使用；默认已改为 sqlite。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskToken, sessionFromCookie, tokenExpiresAtIso } from './auth.js';
import {
  pulledColumnsFromSnapshot,
  tokenExpiresAtFromCookie,
} from './store-member-fields.js';
import { recordSyncPercents } from './usage-percent-history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'members.json');
const USERS_PATH = path.join(DATA_DIR, 'users.json');

/**
 * @typedef {{
 *   id: string,
 *   displayName: string,
 *   cookieValue: string,
 *   userId: string,
 *   email?: string,
 *   hostname?: string | null,
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

/** 文件存储无需额外初始化。 */
export async function init() {}

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
    member.cookieValue = session.cookieValue;
    member.userId = session.userId;
    member.tokenExpiresAt = tokenExpiresAt;
    // 上报不覆盖已有显示名 / 主机名，避免冲掉人工改名
    if (input.email) member.email = String(input.email).trim();
    member.updatedAt = now;
    store.members[idx] = member;
    await writeStore(store);
    return { member: toPublicMember(member), created: false };
  }

  /** @type {Member} */
  const member = {
    id: randomUUID(),
    displayName: fallbackName,
    cookieValue: session.cookieValue,
    userId: session.userId,
    email: input.email ? String(input.email).trim() : undefined,
    hostname,
    tokenExpiresAt,
    createdAt: now,
    updatedAt: now,
    lastSnapshot: null,
    lastError: null,
    lastSyncedAt: null,
  };
  store.members.push(member);
  await writeStore(store);
  return { member: toPublicMember(member), created: true };
}

/** @param {string} id */
export async function deleteMember(id) {
  const store = await readStore();
  const next = store.members.filter((m) => m.id !== id);
  if (next.length === store.members.length) throw new Error('成员不存在');
  store.members = next;
  await writeStore(store);
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
