/**
 * Access Key 校验：恒定时间比较，避免时序旁路。
 */

import { timingSafeEqual } from 'node:crypto';
import { getAccessKey } from './config.js';

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function isAccessKeyConfigured() {
  return Boolean(getAccessKey());
}

/**
 * 从 Header 读取密钥：优先 X-Access-Key，其次 Authorization: Bearer。
 * @param {import('node:http').IncomingMessage} req
 */
export function readAccessKeyFromRequest(req) {
  const headerKey = req.headers['x-access-key'];
  if (typeof headerKey === 'string' && headerKey.trim()) return headerKey.trim();
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  return '';
}

/**
 * @param {import('node:http').IncomingMessage} req
 */
export function assertAccessKey(req) {
  const expected = getAccessKey();
  if (!expected) {
    const err = new Error('服务端未配置 ACCESS_KEY，拒绝插件上报');
    err.status = 503;
    throw err;
  }
  const provided = readAccessKeyFromRequest(req);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    const err = new Error('Access Key 无效');
    err.status = 401;
    throw err;
  }
}
