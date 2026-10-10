/**
 * 控制台口令哈希：scrypt + 盐，供多用户与遗留 admin 共用。
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * @param {string} password
 * @param {string} salt
 */
export function hashPassword(password, salt) {
  return scryptSync(password, salt, 32).toString('hex');
}

/** 生成 16 字节盐的 hex。 */
export function newSalt() {
  return randomBytes(16).toString('hex');
}

/**
 * @param {string} password
 * @param {{ passwordHash: string, salt: string }} user
 */
export function verifyPassword(password, user) {
  const hashed = hashPassword(password, user.salt);
  const a = Buffer.from(hashed, 'hex');
  const b = Buffer.from(user.passwordHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
