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
    if (input.email) member.email = String(input.email).trim();
    if (hostname != null) member.hostname = hostname;
    if (String(input.displayName || '').trim()) {
      member.displayName = String(input.displayName).trim();
    }
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
    member.tokenExpiresAt = tokenExpiresAtFromCookie(member.cookieValue);
    member.lastError = null;
    member.lastSyncedAt = result.snapshot.syncedAt || now;
  } else {
    member.lastError = result.error ?? '同步失败';
    member.lastSyncedAt = now;
  }
  member.updatedAt = now;
  store.members[idx] = member;
  await writeStore(store);
  return toPublicMember(member);
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
 * @param {any} parsed
 * @returns {ConsoleAdmin | null}
 */
function pickAdminFromFile(parsed) {
  if (parsed?.admin && typeof parsed.admin === 'object') {
    return {
      username: 'admin',
      salt: String(parsed.admin.salt || ''),
      passwordHash: String(parsed.admin.passwordHash || ''),
      createdAt: String(parsed.admin.createdAt || new Date().toISOString()),
      mustChangePassword: Boolean(parsed.admin.mustChangePassword),
    };
  }
  const list = Array.isArray(parsed?.users) ? parsed.users : [];
  const found = list.find((u) => u?.username === 'admin') || list[0];
  if (!found) return null;
  return {
    username: 'admin',
    salt: String(found.salt || ''),
    passwordHash: String(found.passwordHash || ''),
    createdAt: String(found.createdAt || new Date().toISOString()),
    mustChangePassword: found.mustChangePassword != null ? Boolean(found.mustChangePassword) : true,
  };
}

/** @returns {Promise<ConsoleAdmin | null>} */
export async function getConsoleAdmin() {
  try {
    const raw = await readFile(USERS_PATH, 'utf8');
    return pickAdminFromFile(JSON.parse(raw));
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * @param {ConsoleAdmin} admin
 */
export async function saveConsoleAdmin(admin) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(USERS_PATH, JSON.stringify({ admin }, null, 2), 'utf8');
}
