/**
 * 成员名册持久化：本地 JSON，仅本机进程读写。
 * Token 落盘是为了主管刷新时无需反复粘贴；部署时务必只绑 loopback。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskToken, sessionFromCookie } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'members.json');

/**
 * @typedef {{
 *   id: string,
 *   displayName: string,
 *   cookieValue: string,
 *   userId: string,
 *   email?: string,
 *   createdAt: string,
 *   updatedAt: string,
 *   lastSnapshot?: object | null,
 *   lastError?: string | null,
 *   lastSyncedAt?: string | null,
 * }} Member
 */

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
 * 原子感写入：先保证目录存在再覆盖文件。
 * @param {{ members: Member[] }} store
 */
async function writeStore(store) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

/**
 * 对外 DTO：去掉完整 cookie，只留遮蔽后缀。
 * @param {Member} m
 */
export function toPublicMember(m) {
  return {
    id: m.id,
    displayName: m.displayName,
    userId: m.userId,
    email: m.email ?? m.lastSnapshot?.email,
    tokenHint: maskToken(m.cookieValue),
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    lastSnapshot: m.lastSnapshot ?? null,
    lastError: m.lastError ?? null,
    lastSyncedAt: m.lastSyncedAt ?? null,
  };
}

/** 列出全部成员（无完整 Token）。 */
export async function listMembers() {
  const store = await readStore();
  return store.members.map(toPublicMember);
}

/**
 * 新增成员；同 userId 已存在则拒绝，避免重复席位。
 * @param {{ displayName: string, sessionToken: string }} input
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
 * 更新显示名和/或轮换会话 Token。
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
    if (
      store.members.some((m) => m.id !== id && m.userId === session.userId)
    ) {
      throw new Error('该账号已绑定其他成员');
    }
    member.cookieValue = session.cookieValue;
    member.userId = session.userId;
  }
  member.updatedAt = new Date().toISOString();
  store.members[idx] = member;
  await writeStore(store);
  return toPublicMember(member);
}

/**
 * @param {string} id
 */
export async function deleteMember(id) {
  const store = await readStore();
  const next = store.members.filter((m) => m.id !== id);
  if (next.length === store.members.length) throw new Error('成员不存在');
  store.members = next;
  await writeStore(store);
}

/**
 * 供刷新逻辑读取完整 cookie（仅服务端使用）。
 * @param {string} id
 * @returns {Promise<Member | null>}
 */
export async function getMemberInternal(id) {
  const store = await readStore();
  return store.members.find((m) => m.id === id) ?? null;
}

/** @returns {Promise<Member[]>} */
export async function getAllMembersInternal() {
  const store = await readStore();
  return store.members;
}

/**
 * 把一次同步结果写回名册。
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
    member.lastSnapshot = result.snapshot;
    member.email = result.snapshot.email ?? member.email;
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
