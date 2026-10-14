/** 注册申请回执。拒绝会删掉用户，所以状态单独落存储驱动。 */

import {
  getApplicationByToken,
  listStoredApplications,
  pruneApplications,
  upsertApplication,
} from './store.js';
import { APPLICATIONS_MAX, newApplicationToken } from './store-side-data.js';
import { getPublicUser } from './users.js';

/**
 * 用当前用户纠正回执状态。用户被拒绝后已删除，只能靠回执本身。
 * @param {string} stored
 * @param {{ pending?: boolean, disabled?: boolean } | null} user
 */
export function reconcileStatus(stored, user) {
  if (user?.pending) return 'pending';
  if (user?.disabled) return 'disabled';
  if (user) return 'approved';
  if (stored === 'approved') return 'removed';
  if (stored === 'pending' || stored === 'rejected') return 'rejected';
  return stored || 'unknown';
}

/** @param {string} status @param {string} username */
export function applicationMessage(status, username) {
  const name = `「${username}」`;
  if (status === 'pending') return `${name}正在等待审批`;
  if (status === 'approved') return `${name}已通过审批，可以直接登录`;
  if (status === 'rejected') return `${name}未通过审批`;
  if (status === 'disabled') return `${name}已被禁用`;
  if (status === 'removed') return `${name}账号已删除`;
  return '未找到这条申请';
}

/** @param {string} username */
export async function createApplication(username) {
  const now = new Date().toISOString();
  const row = {
    token: newApplicationToken(),
    username,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  await upsertApplication(row);
  await pruneApplications(APPLICATIONS_MAX);
  return { token: row.token, username, status: 'pending' };
}

/**
 * 审批、拒绝或删除时改最新一条匹配回执。
 * @param {string} username
 * @param {'approved'|'rejected'|'removed'} status
 */
export async function markApplication(username, status) {
  const rows = await listStoredApplications();
  const now = new Date().toISOString();
  for (const row of rows) {
    if (row.username !== username) continue;
    if ((status === 'approved' || status === 'rejected') && row.status !== 'pending') continue;
    if (status === 'removed' && row.status !== 'approved' && row.status !== 'pending') continue;
    const next = { ...row, status, updatedAt: now };
    await upsertApplication(next);
    return next;
  }
  return null;
}

/** @param {string} token */
export async function lookupApplication(token) {
  const key = String(token || '').trim();
  if (!key) return null;
  const row = await getApplicationByToken(key);
  if (!row) return null;
  const user = await getPublicUser(row.username);
  const status = reconcileStatus(row.status, user);
  if (status !== row.status) {
    const next = { ...row, status, updatedAt: new Date().toISOString() };
    await upsertApplication(next);
  }
  return {
    username: row.username,
    status,
    message: applicationMessage(status, row.username),
  };
}
