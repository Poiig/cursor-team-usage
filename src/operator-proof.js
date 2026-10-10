/** 安装包里的使用人签名。密钥只留在服务端，改用户名就对不上。 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { getSessionSecret } from './config.js';

/** @param {string} username */
export function signOperatorUsername(username) {
  const name = String(username || '').trim();
  if (!name) return '';
  return createHmac('sha256', getSessionSecret()).update(`ctu-operator:${name}`).digest('base64url');
}

/**
 * @param {string} username
 * @param {string} proof
 */
export function verifyOperatorUsername(username, proof) {
  const name = String(username || '').trim();
  const given = String(proof || '').trim();
  const expect = signOperatorUsername(name);
  if (!name || !given || !expect) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expect);
  return a.length === b.length && timingSafeEqual(a, b);
}
