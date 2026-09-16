/**
 * 控制台仅单一 admin：默认 admin/admin，首次登录须改密。
 * 凭据落在当前存储驱动（SQLite / PG / 遗留 file）的 console_admin，与名册同库。
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { getConsoleAdmin, saveConsoleAdmin } from './store.js';

const ADMIN_NAME = 'admin';

/**
 * @typedef {{
 *   username: string,
 *   passwordHash: string,
 *   salt: string,
 *   createdAt: string,
 *   mustChangePassword: boolean,
 * }} AdminUser
 */

/** @type {AdminUser | null} */
let admin = null;

/**
 * @param {string} password
 * @param {string} salt
 */
function hashPassword(password, salt) {
  return scryptSync(password, salt, 32).toString('hex');
}

/**
 * @param {string} password
 * @param {AdminUser} user
 */
function verifyPassword(password, user) {
  const hashed = hashPassword(password, user.salt);
  const a = Buffer.from(hashed, 'hex');
  const b = Buffer.from(user.passwordHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 是否仍为出厂默认密码。 */
function isDefaultPassword(user) {
  return verifyPassword('admin', user);
}

/** @returns {AdminUser} */
function createDefaultAdmin() {
  const salt = randomBytes(16).toString('hex');
  return {
    username: ADMIN_NAME,
    salt,
    passwordHash: hashPassword('admin', salt),
    createdAt: new Date().toISOString(),
    mustChangePassword: true,
  };
}

/** 启动时从存储加载；无记录则创建默认 admin/admin。须在 initStore 之后调用。 */
export async function initUsers() {
  const fromStore = await getConsoleAdmin();

  if (!fromStore?.salt || !fromStore?.passwordHash) {
    admin = createDefaultAdmin();
    await saveConsoleAdmin(admin);
    console.log('已创建默认控制台账号 admin / admin（首次登录须改密）');
    return;
  }

  admin = {
    username: ADMIN_NAME,
    salt: fromStore.salt,
    passwordHash: fromStore.passwordHash,
    createdAt: fromStore.createdAt || new Date().toISOString(),
    mustChangePassword: Boolean(fromStore.mustChangePassword),
  };

  if (admin.mustChangePassword == null || isDefaultPassword(admin)) {
    admin.mustChangePassword = true;
    await saveConsoleAdmin(admin);
  }
}

/**
 * 仅接受用户名 admin。
 * @param {string} username
 * @param {string} password
 * @returns {(AdminUser & { mustChangePassword: boolean }) | null}
 */
export function authenticateUser(username, password) {
  if (!admin) return null;
  if (String(username || '').trim() !== ADMIN_NAME) return null;
  if (!verifyPassword(String(password || ''), admin)) return null;
  return {
    ...admin,
    mustChangePassword: Boolean(admin.mustChangePassword) || isDefaultPassword(admin),
  };
}

/**
 * admin 改密；禁止继续使用默认密码 admin。
 * @param {string} password
 */
export async function changeAdminPassword(password) {
  if (!admin) throw new Error('用户不存在');
  const next = String(password || '');
  if (next.length < 4) throw new Error('密码至少 4 位');
  if (next === 'admin') throw new Error('请勿继续使用默认密码 admin');
  admin.salt = randomBytes(16).toString('hex');
  admin.passwordHash = hashPassword(next, admin.salt);
  admin.mustChangePassword = false;
  await saveConsoleAdmin(admin);
  return {
    username: ADMIN_NAME,
    createdAt: admin.createdAt,
    mustChangePassword: false,
  };
}

/** 当前是否仍须强制改密。 */
export function mustChangePasswordFor() {
  if (!admin) return true;
  return Boolean(admin.mustChangePassword) || isDefaultPassword(admin);
}
