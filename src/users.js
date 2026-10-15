/**
 * 控制台多用户：admin 可管账号；普通用户可看用量并一键切换 Cursor 登录态。
 * 支持自行注册，管理员审批通过后才可登录。
 */

import { hashPassword, newSalt, verifyPassword } from './password.js';
import {
  createConsoleUser,
  deleteConsoleUser,
  getConsoleUser,
  listConsoleUsers,
  saveConsoleUser,
} from './store.js';

/**
 * @typedef {{
 *   username: string,
 *   passwordHash: string,
 *   salt: string,
 *   role: 'admin' | 'user',
 *   createdAt: string,
 *   mustChangePassword: boolean,
 *   disabled: boolean,
 *   pending: boolean,
 *   alias: string,
 * }} ConsoleUser
 */

const ADMIN_NAME = 'admin';
const USERNAME_RE = /^[a-zA-Z0-9_\u4e00-\u9fff.-]{1,32}$/;

/**
 * 对外可返回的用户字段，不含口令哈希。
 * @param {ConsoleUser} user
 */
export function toPublicUser(user) {
  return {
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    mustChangePassword: Boolean(user.mustChangePassword),
    disabled: Boolean(user.disabled),
    pending: Boolean(user.pending),
    alias: String(user.alias || '').trim(),
  };
}

/** @param {string} username */
export function normalizeUsername(username) {
  return String(username || '').trim();
}

/** @param {string} username */
export function assertValidUsername(username) {
  const name = normalizeUsername(username);
  if (!name) throw new Error('请填写用户名');
  if (name.length > 32) throw new Error('用户名最多 32 字');
  if (!USERNAME_RE.test(name)) {
    throw new Error('用户名仅支持中英文、数字、下划线、点与短横线');
  }
  return name;
}

/** @param {string} password */
export function assertValidPassword(password, { allowDefault = false } = {}) {
  const next = String(password || '');
  if (next.length < 4) throw new Error('密码至少 4 位');
  if (!allowDefault && next === 'admin') throw new Error('请勿继续使用默认密码 admin');
  return next;
}

/** 是否仍为出厂默认口令。 */
function isDefaultPassword(user) {
  return verifyPassword('admin', user);
}

/** @returns {ConsoleUser} */
function createDefaultAdmin() {
  const salt = newSalt();
  return {
    username: ADMIN_NAME,
    salt,
    passwordHash: hashPassword('admin', salt),
    role: 'admin',
    createdAt: new Date().toISOString(),
    mustChangePassword: true,
    disabled: false,
    pending: false,
  };
}

/** 启动时确保至少有一个 admin；遗留单 admin 由存储层迁入。 */
export async function initUsers() {
  const users = await listConsoleUsers();
  if (!users.length) {
    const admin = createDefaultAdmin();
    await createConsoleUser(admin);
    console.log('已创建默认控制台账号 admin / admin（首次登录须改密）');
    return;
  }

  const admin = users.find((u) => u.username === ADMIN_NAME);
  if (admin && (admin.mustChangePassword || isDefaultPassword(admin))) {
    admin.mustChangePassword = true;
    admin.role = 'admin';
    admin.pending = false;
    await saveConsoleUser(admin);
  }
}

/**
 * @param {string} username
 * @param {string} password
 * @returns {(ConsoleUser & { mustChangePassword: boolean }) | null}
 */
export async function authenticateUser(username, password) {
  const name = normalizeUsername(username);
  if (!name) return null;
  const user = await getConsoleUser(name);
  if (!user || !verifyPassword(String(password || ''), user)) return null;
  // 待审批 / 已禁用给出明确提示，避免与「账号密码错误」混淆
  if (user.pending) {
    const err = new Error('账号待管理员审批，通过后即可登录');
    err.status = 403;
    err.code = 'PENDING_APPROVAL';
    throw err;
  }
  if (user.disabled) {
    const err = new Error('账号已禁用');
    err.status = 403;
    err.code = 'DISABLED';
    throw err;
  }
  return {
    ...user,
    mustChangePassword: Boolean(user.mustChangePassword) || isDefaultPassword(user),
  };
}

/**
 * 当前登录用户是否仍须强制改密。
 * @param {string} username
 */
export async function mustChangePasswordFor(username) {
  const user = await getConsoleUser(normalizeUsername(username));
  if (!user) return true;
  return Boolean(user.mustChangePassword) || isDefaultPassword(user);
}

/**
 * @param {string} username
 */
export async function getPublicUser(username) {
  const user = await getConsoleUser(normalizeUsername(username));
  return user ? toPublicUser(user) : null;
}

/** @returns {Promise<ReturnType<typeof toPublicUser>[]>} */
export async function listPublicUsers() {
  const users = await listConsoleUsers();
  // 待审批排前面，方便管理员处理
  return users
    .map(toPublicUser)
    .sort((a, b) => Number(b.pending) - Number(a.pending) || a.username.localeCompare(b.username, 'zh'));
}

/**
 * 公开自助注册：写入待审批用户，审批通过前不可登录。
 * @param {{ username: string, password: string }} input
 */
export async function registerUser(input) {
  const username = assertValidUsername(input.username);
  if (username === ADMIN_NAME) throw new Error('admin 为系统保留账号，不可注册');
  const password = assertValidPassword(input.password, { allowDefault: false });
  if (await getConsoleUser(username)) throw new Error('用户名已存在');

  const salt = newSalt();
  /** @type {ConsoleUser} */
  const user = {
    username,
    salt,
    passwordHash: hashPassword(password, salt),
    role: 'user',
    createdAt: new Date().toISOString(),
    mustChangePassword: false,
    disabled: false,
    pending: true,
    alias: '',
  };
  await createConsoleUser(user);
  return toPublicUser(user);
}

/**
 * 管理员同意注册申请，之后可登录。
 * @param {string} username
 */
export async function approveUser(username) {
  const name = assertValidUsername(username);
  if (name === ADMIN_NAME) throw new Error('admin 无需审批');
  const user = await getConsoleUser(name);
  if (!user) throw new Error('用户不存在');
  if (!user.pending) throw new Error('该用户不在待审批状态');
  user.pending = false;
  user.disabled = false;
  await saveConsoleUser(user);
  return toPublicUser(user);
}

/**
 * 管理员拒绝注册：直接删除待审批账号。
 * @param {string} username
 */
export async function rejectUser(username) {
  const name = assertValidUsername(username);
  if (name === ADMIN_NAME) throw new Error('不能拒绝 admin');
  const user = await getConsoleUser(name);
  if (!user) throw new Error('用户不存在');
  if (!user.pending) throw new Error('只能拒绝待审批用户');
  await deleteConsoleUser(name);
  return { ok: true, username: name };
}

/**
 * 管理员新建普通用户或额外管理员（直接可登录，无需审批）。
 * @param {{ username: string, password: string, role?: 'admin' | 'user' }} input
 */
export async function createUser(input) {
  const username = assertValidUsername(input.username);
  if (username === ADMIN_NAME) throw new Error('admin 为系统保留账号，不可再建');
  const password = assertValidPassword(input.password, { allowDefault: false });
  const role = input.role === 'admin' ? 'admin' : 'user';
  if (await getConsoleUser(username)) throw new Error('用户名已存在');

  const salt = newSalt();
  /** @type {ConsoleUser} */
  const user = {
    username,
    salt,
    passwordHash: hashPassword(password, salt),
    role,
    createdAt: new Date().toISOString(),
    mustChangePassword: true,
    disabled: false,
    pending: false,
    alias: '',
  };
  await createConsoleUser(user);
  return toPublicUser(user);
}

/**
 * 本人改密；禁止继续使用默认密码 admin。
 * @param {string} username
 * @param {string} password
 */
export async function changeOwnPassword(username, password) {
  const name = normalizeUsername(username);
  const user = await getConsoleUser(name);
  if (!user) throw new Error('用户不存在');
  const next = assertValidPassword(password);
  user.salt = newSalt();
  user.passwordHash = hashPassword(next, user.salt);
  user.mustChangePassword = false;
  await saveConsoleUser(user);
  return toPublicUser(user);
}

/**
 * 管理员重置他人口令，并强制对方下次登录改密。
 * @param {string} username
 * @param {string} password
 */
export async function resetUserPassword(username, password) {
  const name = assertValidUsername(username);
  const user = await getConsoleUser(name);
  if (!user) throw new Error('用户不存在');
  const next = assertValidPassword(password);
  user.salt = newSalt();
  user.passwordHash = hashPassword(next, user.salt);
  user.mustChangePassword = true;
  await saveConsoleUser(user);
  return toPublicUser(user);
}

/**
 * @param {string} username
 * @param {{ role?: 'admin' | 'user', disabled?: boolean, alias?: string }} patch
 */
export async function updateUser(username, patch) {
  const name = assertValidUsername(username);
  const user = await getConsoleUser(name);
  if (!user) throw new Error('用户不存在');
  if (user.pending && (patch.role != null || patch.disabled != null)) {
    throw new Error('待审批用户请先同意或拒绝，不能直接改状态');
  }

  if (patch.role != null) {
    const role = patch.role === 'admin' ? 'admin' : 'user';
    if (name === ADMIN_NAME && role !== 'admin') {
      throw new Error('不能取消 admin 的管理员角色');
    }
    user.role = role;
  }
  if (patch.disabled != null) {
    if (name === ADMIN_NAME && patch.disabled) {
      throw new Error('不能禁用 admin');
    }
    user.disabled = Boolean(patch.disabled);
  }
  if (patch.alias != null) {
    const alias = String(patch.alias).trim();
    if (alias.length > 32) throw new Error('别名最多 32 个字');
    user.alias = alias;
  }
  await saveConsoleUser(user);
  return toPublicUser(user);
}

/**
 * 删除普通用户；admin 不可删。
 * @param {string} username
 */
export async function removeUser(username) {
  const name = assertValidUsername(username);
  if (name === ADMIN_NAME) throw new Error('不能删除 admin');
  const user = await getConsoleUser(name);
  if (!user) throw new Error('用户不存在');
  await deleteConsoleUser(name);
}

/** @param {string | undefined} username */
export async function isAdminUsername(username) {
  const user = await getConsoleUser(normalizeUsername(username || ''));
  return Boolean(user && user.role === 'admin' && !user.disabled && !user.pending);
}
