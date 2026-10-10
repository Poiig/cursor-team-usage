/** 注册申请回执。拒绝会删掉用户，所以状态单独落在 data/applications.json。 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPublicUser } from './users.js';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'applications.json');
const MAX_ROWS = 500;

/** @type {any[]|null} */
let cache = null;
let writeChain = Promise.resolve();

async function load() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(await readFile(FILE, 'utf8'));
    cache = Array.isArray(parsed) ? parsed : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function persist() {
  writeChain = writeChain.catch(() => {}).then(async () => {
    await mkdir(path.dirname(FILE), { recursive: true });
    await writeFile(FILE, JSON.stringify(cache || [], null, 2) + '\n', 'utf8');
  });
  return writeChain;
}

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
  const rows = await load();
  const now = new Date().toISOString();
  const row = {
    token: randomBytes(24).toString('base64url'),
    username,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  rows.unshift(row);
  if (rows.length > MAX_ROWS) rows.length = MAX_ROWS;
  await persist();
  return { token: row.token, username, status: 'pending' };
}

/**
 * 审批、拒绝或删除时改最新一条匹配回执。
 * @param {string} username
 * @param {'approved'|'rejected'|'removed'} status
 */
export async function markApplication(username, status) {
  const rows = await load();
  const now = new Date().toISOString();
  for (const row of rows) {
    if (row.username !== username) continue;
    if ((status === 'approved' || status === 'rejected') && row.status !== 'pending') continue;
    if (status === 'removed' && row.status !== 'approved' && row.status !== 'pending') continue;
    row.status = status;
    row.updatedAt = now;
    await persist();
    return row;
  }
  return null;
}

/** @param {string} token */
export async function lookupApplication(token) {
  const key = String(token || '').trim();
  if (!key) return null;
  const rows = await load();
  const row = rows.find((item) => item.token === key);
  if (!row) return null;
  const user = await getPublicUser(row.username);
  const status = reconcileStatus(row.status, user);
  if (status !== row.status) {
    row.status = status;
    row.updatedAt = new Date().toISOString();
    await persist();
  }
  return {
    username: row.username,
    status,
    message: applicationMessage(status, row.username),
  };
}
