/** 控制台登录审计日志，落存储驱动。 */

import { randomUUID } from 'node:crypto';
import { insertLoginEvent, listStoredLoginEvents, pruneLoginEvents } from './store.js';
import { LOGIN_EVENTS_MAX } from './store-side-data.js';

/**
 * @param {{ username?: string, ok: boolean, role?: string|null, ip?: string|null, userAgent?: string|null }} input
 */
export async function recordLoginEvent(input) {
  await insertLoginEvent({
    id: randomUUID(),
    username: String(input.username || '').trim() || '—',
    ok: Boolean(input.ok),
    role: input.role ? String(input.role) : null,
    ip: input.ip ? String(input.ip) : null,
    userAgent: input.userAgent ? String(input.userAgent).slice(0, 300) : null,
    createdAt: new Date().toISOString(),
  });
  // 写入后裁剪，避免表无界增长
  await pruneLoginEvents(LOGIN_EVENTS_MAX);
}

/** @param {number} [limit] */
export async function listLoginEvents(limit = 200) {
  const n = Math.max(1, Math.min(1000, Number(limit) || 200));
  return listStoredLoginEvents(n);
}
