/**
 * 本地 SQLite 存储（sql.js / WASM）：名册 + Token/用量列 + 控制台 admin。
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { maskToken, sessionFromCookie, tokenExpiresAtIso } from './auth.js';
import { getSqlitePath } from './config.js';
import {
  pulledColumnsFromSnapshot,
  tokenExpiresAtFromCookie,
} from './store-member-fields.js';

const require = createRequire(import.meta.url);
const sqlJsDir = path.dirname(require.resolve('sql.js'));

/**
 * @typedef {{
 *   id: string,
 *   displayName: string,
 *   cookieValue: string,
 *   userId: string,
 *   email?: string,
 *   hostname?: string | null,
 *   tokenExpiresAt?: string | null,
 *   planName?: string | null,
 *   membershipType?: string | null,
 *   totalPercentUsed?: number | null,
 *   spendToday?: number | null,
 *   spendYesterday?: number | null,
 *   spendLast30?: number | null,
 *   hardLimit?: number | null,
 *   createdAt: string,
 *   updatedAt: string,
 *   lastSnapshot?: object | null,
 *   lastError?: string | null,
 *   lastSyncedAt?: string | null,
 * }} Member
 */

/**
 * @typedef {{
 *   username: string,
 *   passwordHash: string,
 *   salt: string,
 *   createdAt: string,
 *   mustChangePassword: boolean,
 * }} ConsoleAdmin
 */

/** @type {import('sql.js').Database | null} */
let db = null;
/** @type {string} */
let dbPath = '';

/**
 * @param {any} row
 * @returns {Member}
 */
function rowToMember(row) {
  let lastSnapshot = null;
  if (row.last_snapshot) {
    try {
      lastSnapshot = JSON.parse(row.last_snapshot);
    } catch {
      lastSnapshot = null;
    }
  }
  return {
    id: row.id,
    displayName: row.display_name,
    cookieValue: row.cookie_value,
    userId: row.user_id,
    email: row.email ?? undefined,
    hostname: row.hostname ?? null,
    tokenExpiresAt: row.token_expires_at ?? tokenExpiresAtIso(row.cookie_value),
    planName: row.plan_name ?? null,
    membershipType: row.membership_type ?? null,
    totalPercentUsed: row.total_percent_used ?? null,
    spendToday: row.spend_today ?? null,
    spendYesterday: row.spend_yesterday ?? null,
    spendLast30: row.spend_last30 ?? null,
    hardLimit: row.hard_limit ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSnapshot,
    lastError: row.last_error ?? null,
    lastSyncedAt: row.last_synced_at ?? null,
  };
}

/**
 * @param {Member} m
 */
export function toPublicMember(m) {
  return {
    id: m.id,
    displayName: m.displayName,
    userId: m.userId,
    email: m.email ?? m.lastSnapshot?.email,
    hostname: m.hostname ?? null,
    tokenHint: maskToken(m.cookieValue),
    tokenExpiresAt: m.tokenExpiresAt ?? tokenExpiresAtIso(m.cookieValue),
    planName: m.planName ?? m.lastSnapshot?.plan?.planName ?? null,
    membershipType: m.membershipType ?? m.lastSnapshot?.plan?.membershipType ?? null,
    totalPercentUsed: m.totalPercentUsed ?? null,
    spendToday: m.spendToday ?? null,
    spendYesterday: m.spendYesterday ?? null,
    spendLast30: m.spendLast30 ?? null,
    hardLimit: m.hardLimit ?? null,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    lastSnapshot: m.lastSnapshot ?? null,
    lastError: m.lastError ?? null,
    lastSyncedAt: m.lastSyncedAt ?? null,
  };
}

function database() {
  if (!db) throw new Error('SQLite 未初始化');
  return db;
}

/** 把内存库写回磁盘，保证进程退出前改动不丢。 */
async function persist() {
  const data = database().export();
  await mkdir(path.dirname(dbPath), { recursive: true });
  await writeFile(dbPath, Buffer.from(data));
}

/**
 * @param {string} sql
 * @param {any[]} [params]
 */
function run(sql, params = []) {
  database().run(sql, params);
}

/**
 * @param {string} sql
 * @param {any[]} [params]
 */
function getOne(sql, params = []) {
  const stmt = database().prepare(sql);
  try {
    stmt.bind(params);
    if (!stmt.step()) return null;
    return stmt.getAsObject();
  } finally {
    stmt.free();
  }
}

/**
 * @param {string} sql
 * @param {any[]} [params]
 */
function getAll(sql, params = []) {
  const stmt = database().prepare(sql);
  /** @type {any[]} */
  const rows = [];
  try {
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return rows;
}

/** 旧库缺少 Token/用量列时补齐，避免重建丢数据。 */
function ensureMemberColumns() {
  const cols = new Set(getAll('PRAGMA table_info(members)').map((c) => String(c.name)));
  /** @type {Array<[string, string]>} */
  const extras = [
    ['hostname', 'TEXT'],
    ['token_expires_at', 'TEXT'],
    ['plan_name', 'TEXT'],
    ['membership_type', 'TEXT'],
    ['total_percent_used', 'REAL'],
    ['spend_today', 'REAL'],
    ['spend_yesterday', 'REAL'],
    ['spend_last30', 'REAL'],
    ['hard_limit', 'REAL'],
  ];
  for (const [name, type] of extras) {
    if (!cols.has(name)) run(`ALTER TABLE members ADD COLUMN ${name} ${type}`);
  }
}

/** 建表；缺省表结构与 PG 侧字段对齐。 */
function ensureSchema() {
  run(`
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      cookie_value TEXT NOT NULL,
      user_id TEXT NOT NULL UNIQUE,
      email TEXT,
      hostname TEXT,
      token_expires_at TEXT,
      plan_name TEXT,
      membership_type TEXT,
      total_percent_used REAL,
      spend_today REAL,
      spend_yesterday REAL,
      spend_last30 REAL,
      hard_limit REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_snapshot TEXT,
      last_error TEXT,
      last_synced_at TEXT
    )
  `);
  ensureMemberColumns();
  run(`
    CREATE TABLE IF NOT EXISTS console_admin (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 1
    )
  `);
  run(`
    CREATE TABLE IF NOT EXISTS console_users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      disabled INTEGER NOT NULL DEFAULT 0,
      pending INTEGER NOT NULL DEFAULT 0
    )
  `);
  ensureConsoleUserColumns();
  run(`
    CREATE TABLE IF NOT EXISTS account_switch_logs (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      operator_username TEXT NOT NULL,
      member_id TEXT,
      member_display_name TEXT,
      member_email TEXT,
      member_user_id TEXT,
      hostname TEXT,
      client_ip TEXT,
      usage_total_percent REAL,
      status TEXT NOT NULL,
      error TEXT,
      ticket_id TEXT,
      claimed_at TEXT,
      finished_at TEXT
    )
  `);
  ensureSwitchLogColumns();
  migrateConsoleAdminToUsers();
}

/** 旧库补齐切换日志的 IP / Total usage 列。 */
function ensureSwitchLogColumns() {
  const cols = new Set(
    getAll('PRAGMA table_info(account_switch_logs)').map((c) => String(c.name)),
  );
  /** @type {Array<[string, string]>} */
  const extras = [
    ['client_ip', 'TEXT'],
    ['usage_total_percent', 'REAL'],
  ];
  for (const [name, type] of extras) {
    if (!cols.has(name)) run(`ALTER TABLE account_switch_logs ADD COLUMN ${name} ${type}`);
  }
}

/**
 * 把遗留单行 console_admin 迁入 console_users（role=admin），保留原口令哈希。
 */
function migrateConsoleAdminToUsers() {
  const existing = getOne('SELECT 1 AS x FROM console_users LIMIT 1');
  if (existing) return;
  const row = getOne('SELECT * FROM console_admin WHERE username = ?', ['admin']);
  if (!row) return;
  run(
    `INSERT INTO console_users
      (username, password_hash, salt, role, created_at, must_change_password, disabled, pending)
     VALUES (?,?,?,?,?,?,0,0)`,
    [
      String(row.username || 'admin'),
      String(row.password_hash),
      String(row.salt),
      'admin',
      String(row.created_at || new Date().toISOString()),
      row.must_change_password ? 1 : 0,
    ],
  );
}

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
 * }} ConsoleUserRow
 */

/** 旧库补齐注册审批列。 */
function ensureConsoleUserColumns() {
  const cols = new Set(getAll('PRAGMA table_info(console_users)').map((c) => String(c.name)));
  if (!cols.has('pending')) {
    run('ALTER TABLE console_users ADD COLUMN pending INTEGER NOT NULL DEFAULT 0');
  }
}

/**
 * @param {any} row
 * @returns {ConsoleUserRow | null}
 */
function rowToConsoleUser(row) {
  if (!row) return null;
  return {
    username: String(row.username),
    passwordHash: String(row.password_hash),
    salt: String(row.salt),
    role: row.role === 'admin' ? 'admin' : 'user',
    createdAt: String(row.created_at),
    mustChangePassword: Boolean(row.must_change_password),
    disabled: Boolean(row.disabled),
    pending: Boolean(row.pending),
  };
}

/** 已有行若缺 token_expires_at / 用量列，从 cookie 与 last_snapshot 回填。 */
async function backfillPulledColumns() {
  const rows = getAll(
    `SELECT id, cookie_value, last_snapshot, token_expires_at FROM members
     WHERE token_expires_at IS NULL OR plan_name IS NULL`,
  );
  if (!rows.length) return;
  for (const row of rows) {
    let snapshot = null;
    if (row.last_snapshot) {
      try {
        snapshot = JSON.parse(String(row.last_snapshot));
      } catch {
        snapshot = null;
      }
    }
    const pulled = pulledColumnsFromSnapshot(snapshot);
    run(
      `UPDATE members SET
        token_expires_at=COALESCE(token_expires_at, ?),
        email=COALESCE(email, ?),
        plan_name=COALESCE(plan_name, ?),
        membership_type=COALESCE(membership_type, ?),
        total_percent_used=COALESCE(total_percent_used, ?),
        spend_today=COALESCE(spend_today, ?),
        spend_yesterday=COALESCE(spend_yesterday, ?),
        spend_last30=COALESCE(spend_last30, ?),
        hard_limit=COALESCE(hard_limit, ?)
       WHERE id=?`,
      [
        tokenExpiresAtFromCookie(String(row.cookie_value || '')),
        pulled.email,
        pulled.planName,
        pulled.membershipType,
        pulled.totalPercentUsed,
        pulled.spendToday,
        pulled.spendYesterday,
        pulled.spendLast30,
        pulled.hardLimit,
        row.id,
      ],
    );
  }
  await persist();
}

/** 打开/创建库文件并完成 schema 与一次性迁移。 */
export async function init() {
  dbPath = getSqlitePath();
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(sqlJsDir, file),
  });

  try {
    const buf = await readFile(dbPath);
    db = new SQL.Database(buf);
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
    db = new SQL.Database();
  }

  ensureSchema();
  await backfillPulledColumns();
  await persist();
}

/** 热切换前释放内存库引用。 */
export async function close() {
  if (db) {
    db.close();
    db = null;
  }
}

export async function listMembers() {
  const rows = getAll('SELECT * FROM members ORDER BY created_at ASC');
  return rows.map((r) => toPublicMember(rowToMember(r)));
}

/**
 * @param {{ displayName: string, sessionToken: string, hostname?: string }} input
 */
export async function addMember(input) {
  const displayName = String(input.displayName || '').trim();
  if (!displayName) throw new Error('请填写成员显示名');
  const session = sessionFromCookie(input.sessionToken);
  if (!session) throw new Error('会话 Token 无效，请粘贴 WorkosCursorSessionToken');

  const exists = getOne('SELECT 1 AS x FROM members WHERE user_id = ?', [session.userId]);
  if (exists) throw new Error(`该账号已在名册中（${session.userId}）`);

  const now = new Date().toISOString();
  const id = randomUUID();
  const hostname = input.hostname ? String(input.hostname).trim() : null;
  run(
    `INSERT INTO members
      (id, display_name, cookie_value, user_id, hostname, token_expires_at,
       created_at, updated_at, last_snapshot, last_error, last_synced_at)
     VALUES (?,?,?,?,?,?,?,?,NULL,NULL,NULL)`,
    [
      id,
      displayName,
      session.cookieValue,
      session.userId,
      hostname,
      tokenExpiresAtFromCookie(session.cookieValue),
      now,
      now,
    ],
  );
  await persist();
  const member = await getMemberInternal(id);
  return toPublicMember(/** @type {Member} */ (member));
}

/**
 * @param {string} id
 * @param {{ displayName?: string, sessionToken?: string, hostname?: string }} patch
 */
export async function updateMember(id, patch) {
  const member = await getMemberInternal(id);
  if (!member) throw new Error('成员不存在');

  let displayName = member.displayName;
  let cookieValue = member.cookieValue;
  let userId = member.userId;
  let hostname = member.hostname ?? null;
  let tokenExpiresAt = member.tokenExpiresAt ?? tokenExpiresAtFromCookie(cookieValue);

  if (patch.displayName != null) {
    displayName = String(patch.displayName).trim();
    if (!displayName) throw new Error('显示名不能为空');
  }
  if (patch.sessionToken != null && String(patch.sessionToken).trim()) {
    const session = sessionFromCookie(patch.sessionToken);
    if (!session) throw new Error('会话 Token 无效');
    const clash = getOne('SELECT 1 AS x FROM members WHERE user_id = ? AND id <> ?', [
      session.userId,
      id,
    ]);
    if (clash) throw new Error('该账号已绑定其他成员');
    cookieValue = session.cookieValue;
    userId = session.userId;
    tokenExpiresAt = tokenExpiresAtFromCookie(cookieValue);
  }
  if (patch.hostname != null) {
    hostname = String(patch.hostname).trim() || null;
  }

  const now = new Date().toISOString();
  run(
    `UPDATE members SET display_name=?, cookie_value=?, user_id=?, hostname=?, token_expires_at=?, updated_at=? WHERE id=?`,
    [displayName, cookieValue, userId, hostname, tokenExpiresAt, now, id],
  );
  await persist();
  const next = await getMemberInternal(id);
  return toPublicMember(/** @type {Member} */ (next));
}

/**
 * @param {{ displayName?: string, sessionToken: string, email?: string, hostname?: string }} input
 */
export async function upsertMemberBySession(input) {
  const session = sessionFromCookie(input.sessionToken);
  if (!session) throw new Error('会话 Token 无效');

  const now = new Date().toISOString();
  const existing = getOne('SELECT id FROM members WHERE user_id = ?', [session.userId]);
  const fallbackName =
    String(input.displayName || '').trim() ||
    String(input.email || '').trim() ||
    session.userId;
  const email = input.email ? String(input.email).trim() : null;
  const hostname = input.hostname != null ? String(input.hostname).trim() || null : null;
  const tokenExpiresAt = tokenExpiresAtFromCookie(session.cookieValue);

  if (existing) {
    const id = String(existing.id);
    // 上报只轮换 Token / 邮箱；已有显示名与主机名不覆盖，避免冲掉人工改名
    run(
      `UPDATE members SET
        cookie_value=?,
        token_expires_at=?,
        email=COALESCE(?, email),
        updated_at=?
       WHERE id=?`,
      [session.cookieValue, tokenExpiresAt, email, now, id],
    );
    await persist();
    const member = await getMemberInternal(id);
    return { member: toPublicMember(/** @type {Member} */ (member)), created: false };
  }

  const id = randomUUID();
  run(
    `INSERT INTO members
      (id, display_name, cookie_value, user_id, email, hostname, token_expires_at,
       created_at, updated_at, last_snapshot, last_error, last_synced_at)
     VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,NULL)`,
    [
      id,
      fallbackName,
      session.cookieValue,
      session.userId,
      email,
      hostname,
      tokenExpiresAt,
      now,
      now,
    ],
  );
  await persist();
  const member = await getMemberInternal(id);
  return { member: toPublicMember(/** @type {Member} */ (member)), created: true };
}

/** @param {string} id */
export async function deleteMember(id) {
  const before = getOne('SELECT 1 AS x FROM members WHERE id = ?', [id]);
  if (!before) throw new Error('成员不存在');
  run('DELETE FROM members WHERE id = ?', [id]);
  await persist();
}

/** @param {string} id */
export async function getMemberInternal(id) {
  const row = getOne('SELECT * FROM members WHERE id = ?', [id]);
  return row ? rowToMember(row) : null;
}

export async function getAllMembersInternal() {
  return getAll('SELECT * FROM members ORDER BY created_at ASC').map(rowToMember);
}

/**
 * @param {string} id
 * @param {{ snapshot?: object | null, error?: string | null }} result
 */
export async function saveSyncResult(id, result) {
  const member = await getMemberInternal(id);
  if (!member) return;
  const now = new Date().toISOString();
  if (result.snapshot) {
    const syncedAt = result.snapshot.syncedAt || now;
    const pulled = pulledColumnsFromSnapshot(result.snapshot);
    run(
      `UPDATE members SET
        last_snapshot=?,
        email=COALESCE(?, email),
        plan_name=?,
        membership_type=?,
        total_percent_used=?,
        spend_today=?,
        spend_yesterday=?,
        spend_last30=?,
        hard_limit=?,
        token_expires_at=COALESCE(?, token_expires_at),
        last_error=NULL,
        last_synced_at=?,
        updated_at=?
       WHERE id=?`,
      [
        JSON.stringify(result.snapshot),
        pulled.email,
        pulled.planName,
        pulled.membershipType,
        pulled.totalPercentUsed,
        pulled.spendToday,
        pulled.spendYesterday,
        pulled.spendLast30,
        pulled.hardLimit,
        tokenExpiresAtFromCookie(member.cookieValue),
        syncedAt,
        syncedAt,
        id,
      ],
    );
  } else {
    // 尚无成功快照时不推进 last_synced_at，便于按到期逻辑尽快重试。
    run(
      `UPDATE members SET
        last_error=?,
        last_synced_at=CASE WHEN last_snapshot IS NULL THEN last_synced_at ELSE ? END,
        updated_at=?
       WHERE id=?`,
      [result.error ?? '同步失败', now, now, id],
    );
  }
  await persist();
  const next = await getMemberInternal(id);
  return next ? toPublicMember(next) : undefined;
}

/** @returns {Promise<ConsoleUserRow[]>} */
export async function listConsoleUsers() {
  return getAll('SELECT * FROM console_users ORDER BY created_at ASC').map((r) =>
    /** @type {ConsoleUserRow} */ (rowToConsoleUser(r)),
  );
}

/** @param {string} username */
export async function getConsoleUser(username) {
  return rowToConsoleUser(
    getOne('SELECT * FROM console_users WHERE username = ?', [String(username || '')]),
  );
}

/**
 * 新建控制台用户；用户名冲突时抛错。
 * @param {ConsoleUserRow} user
 */
export async function createConsoleUser(user) {
  const exists = getOne('SELECT 1 AS x FROM console_users WHERE username = ?', [user.username]);
  if (exists) throw new Error('用户名已存在');
  run(
    `INSERT INTO console_users
      (username, password_hash, salt, role, created_at, must_change_password, disabled, pending)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      user.username,
      user.passwordHash,
      user.salt,
      user.role === 'admin' ? 'admin' : 'user',
      user.createdAt,
      user.mustChangePassword ? 1 : 0,
      user.disabled ? 1 : 0,
      user.pending ? 1 : 0,
    ],
  );
  // 同步写回遗留 console_admin，避免旧工具只读那张表时丢 admin
  if (user.username === 'admin') {
    run(
      `INSERT INTO console_admin (username, password_hash, salt, created_at, must_change_password)
       VALUES (?,?,?,?,?)
       ON CONFLICT(username) DO UPDATE SET
         password_hash=excluded.password_hash,
         salt=excluded.salt,
         created_at=excluded.created_at,
         must_change_password=excluded.must_change_password`,
      [
        user.username,
        user.passwordHash,
        user.salt,
        user.createdAt,
        user.mustChangePassword ? 1 : 0,
      ],
    );
  }
  await persist();
}

/**
 * @param {ConsoleUserRow} user
 */
export async function saveConsoleUser(user) {
  run(
    `INSERT INTO console_users
      (username, password_hash, salt, role, created_at, must_change_password, disabled, pending)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(username) DO UPDATE SET
       password_hash=excluded.password_hash,
       salt=excluded.salt,
       role=excluded.role,
       created_at=excluded.created_at,
       must_change_password=excluded.must_change_password,
       disabled=excluded.disabled,
       pending=excluded.pending`,
    [
      user.username,
      user.passwordHash,
      user.salt,
      user.role === 'admin' ? 'admin' : 'user',
      user.createdAt,
      user.mustChangePassword ? 1 : 0,
      user.disabled ? 1 : 0,
      user.pending ? 1 : 0,
    ],
  );
  if (user.username === 'admin') {
    run(
      `INSERT INTO console_admin (username, password_hash, salt, created_at, must_change_password)
       VALUES (?,?,?,?,?)
       ON CONFLICT(username) DO UPDATE SET
         password_hash=excluded.password_hash,
         salt=excluded.salt,
         created_at=excluded.created_at,
         must_change_password=excluded.must_change_password`,
      [
        user.username,
        user.passwordHash,
        user.salt,
        user.createdAt,
        user.mustChangePassword ? 1 : 0,
      ],
    );
  }
  await persist();
}

/** @param {string} username */
export async function deleteConsoleUser(username) {
  const name = String(username || '');
  if (name === 'admin') throw new Error('不能删除 admin');
  const before = getOne('SELECT 1 AS x FROM console_users WHERE username = ?', [name]);
  if (!before) throw new Error('用户不存在');
  run('DELETE FROM console_users WHERE username = ?', [name]);
  await persist();
}

/**
 * @typedef {{
 *   id: string,
 *   createdAt: string,
 *   operatorUsername: string,
 *   memberId?: string | null,
 *   memberDisplayName?: string | null,
 *   memberEmail?: string | null,
 *   memberUserId?: string | null,
 *   hostname?: string | null,
 *   clientIp?: string | null,
 *   usageTotalPercent?: number | null,
 *   status: string,
 *   error?: string | null,
 *   ticketId?: string | null,
 *   claimedAt?: string | null,
 *   finishedAt?: string | null,
 * }} SwitchLogRow
 */

/**
 * @param {any} row
 * @returns {SwitchLogRow}
 */
function rowToSwitchLog(row) {
  return {
    id: String(row.id),
    createdAt: String(row.created_at),
    operatorUsername: String(row.operator_username),
    memberId: row.member_id ?? null,
    memberDisplayName: row.member_display_name ?? null,
    memberEmail: row.member_email ?? null,
    memberUserId: row.member_user_id ?? null,
    hostname: row.hostname ?? null,
    clientIp: row.client_ip ?? null,
    usageTotalPercent:
      row.usage_total_percent != null && !Number.isNaN(Number(row.usage_total_percent))
        ? Number(row.usage_total_percent)
        : null,
    status: String(row.status),
    error: row.error ?? null,
    ticketId: row.ticket_id ?? null,
    claimedAt: row.claimed_at ?? null,
    finishedAt: row.finished_at ?? null,
  };
}

/**
 * @param {Omit<SwitchLogRow, 'createdAt'> & { createdAt?: string }} log
 */
export async function insertSwitchLog(log) {
  const createdAt = log.createdAt || new Date().toISOString();
  run(
    `INSERT INTO account_switch_logs
      (id, created_at, operator_username, member_id, member_display_name, member_email,
       member_user_id, hostname, client_ip, usage_total_percent, status, error, ticket_id,
       claimed_at, finished_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      log.id,
      createdAt,
      log.operatorUsername,
      log.memberId ?? null,
      log.memberDisplayName ?? null,
      log.memberEmail ?? null,
      log.memberUserId ?? null,
      log.hostname ?? null,
      log.clientIp ?? null,
      log.usageTotalPercent ?? null,
      log.status,
      log.error ?? null,
      log.ticketId ?? null,
      log.claimedAt ?? null,
      log.finishedAt ?? null,
    ],
  );
  await persist();
  return rowToSwitchLog(
    getOne('SELECT * FROM account_switch_logs WHERE id = ?', [log.id]),
  );
}

/**
 * @param {string} id
 * @param {Partial<Pick<SwitchLogRow, 'status' | 'error' | 'hostname' | 'claimedAt' | 'finishedAt'>>} patch
 */
export async function updateSwitchLog(id, patch) {
  const before = getOne('SELECT * FROM account_switch_logs WHERE id = ?', [id]);
  if (!before) throw new Error('切换记录不存在');
  run(
    `UPDATE account_switch_logs SET
      status=?,
      error=?,
      hostname=?,
      claimed_at=?,
      finished_at=?
     WHERE id=?`,
    [
      patch.status ?? before.status,
      patch.error !== undefined ? patch.error : before.error,
      patch.hostname !== undefined ? patch.hostname : before.hostname,
      patch.claimedAt !== undefined ? patch.claimedAt : before.claimed_at,
      patch.finishedAt !== undefined ? patch.finishedAt : before.finished_at,
      id,
    ],
  );
  await persist();
  return rowToSwitchLog(getOne('SELECT * FROM account_switch_logs WHERE id = ?', [id]));
}

/**
 * @param {{ limit?: number }} [opts]
 */
export async function listSwitchLogs(opts = {}) {
  const limit = Math.min(500, Math.max(1, Number(opts.limit) || 100));
  return getAll(
    'SELECT * FROM account_switch_logs ORDER BY created_at DESC LIMIT ?',
    [limit],
  ).map(rowToSwitchLog);
}

/** @param {string} id */
export async function getSwitchLog(id) {
  const row = getOne('SELECT * FROM account_switch_logs WHERE id = ?', [id]);
  return row ? rowToSwitchLog(row) : null;
}

/** @returns {Promise<ConsoleAdmin | null>} */
export async function getConsoleAdmin() {
  const user = await getConsoleUser('admin');
  if (!user) return null;
  return {
    username: user.username,
    passwordHash: user.passwordHash,
    salt: user.salt,
    createdAt: user.createdAt,
    mustChangePassword: user.mustChangePassword,
  };
}

/**
 * @param {ConsoleAdmin} admin
 */
export async function saveConsoleAdmin(admin) {
  await saveConsoleUser({
    username: admin.username || 'admin',
    passwordHash: admin.passwordHash,
    salt: admin.salt,
    role: 'admin',
    createdAt: admin.createdAt,
    mustChangePassword: Boolean(admin.mustChangePassword),
    disabled: false,
    pending: false,
  });
}
