/**
 * 控制台仅单一 admin：默认 admin/admin，首次登录须改密。
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_PATH = path.join(DATA_DIR, 'users.json');
const ADMIN_NAME = 'admin';

/**
 * @typedef {{
 *   username: 'admin',
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

async function persist() {
  if (!admin) return;
  await mkdir(DATA_DIR, { recursive: true });
  // 只存单一 admin，不再支持多用户列表。
  await writeFile(USERS_PATH, JSON.stringify({ admin }, null, 2), 'utf8');
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

/**
 * 从旧版 { users: [...] } 或新版 { admin } 解析出唯一 admin。
 * @param {any} parsed
 */
function pickAdminFromFile(parsed) {
  if (parsed?.admin && typeof parsed.admin === 'object') {
    return {
      username: ADMIN_NAME,
      salt: String(parsed.admin.salt || ''),
      passwordHash: String(parsed.admin.passwordHash || ''),
      createdAt: String(parsed.admin.createdAt || new Date().toISOString()),
      mustChangePassword: Boolean(parsed.admin.mustChangePassword),
    };
  }
  const list = Array.isArray(parsed?.users) ? parsed.users : [];
  const found = list.find((u) => u?.username === ADMIN_NAME) || list[0];
  if (!found) return null;
  return {
    username: ADMIN_NAME,
    salt: String(found.salt || ''),
    passwordHash: String(found.passwordHash || ''),
    createdAt: String(found.createdAt || new Date().toISOString()),
    mustChangePassword: found.mustChangePassword != null ? Boolean(found.mustChangePassword) : true,
  };
}

/** 启动时加载；无记录则创建默认 admin/admin。 */
export async function initUsers() {
  let fromDisk = null;
  let migrated = false;
  try {
    const raw = await readFile(USERS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    fromDisk = pickAdminFromFile(parsed);
    // 旧多用户文件统一收敛为单一 admin。
    if (Array.isArray(parsed?.users)) migrated = true;
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
  }

  if (!fromDisk?.salt || !fromDisk?.passwordHash) {
    admin = createDefaultAdmin();
    await persist();
    console.log('已创建默认控制台账号 admin / admin（首次登录须改密）');
    return;
  }

  admin = fromDisk;
  if (admin.mustChangePassword == null || isDefaultPassword(admin)) {
    admin.mustChangePassword = true;
    migrated = true;
  }
  if (migrated) await persist();
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
  await persist();
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
