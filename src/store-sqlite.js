/**
 * 本地 SQLite 存储（sql.js / WASM）：名册 + Token/用量列 + 控制台 admin。
 * 启动时若表空且存在旧 JSON，则一次性迁入 members.json / users.json。
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import { maskToken, sessionFromCookie, tokenExpiresAtIso } from './auth.js';
import { getSqlitePath } from './config.js';
import {
  pulledColumnsFromSnapshot,
  tokenExpiresAtFromCookie,
} from './store-member-fields.js';

const require = createRequire(import.meta.url);
const sqlJsDir = path.dirname(require.resolve('sql.js'));
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const MEMBERS_JSON = path.join(DATA_DIR, 'members.json');
const USERS_JSON = path.join(DATA_DIR, 'users.json');

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
}

/**
 * @param {any} parsed
 * @returns {ConsoleAdmin | null}
 */
function pickAdminFromJson(parsed) {
  if (parsed?.admin && typeof parsed.admin === 'object') {
    return {
      username: 'admin',
      salt: String(parsed.admin.salt || ''),
      passwordHash: String(parsed.admin.passwordHash || ''),
      createdAt: String(parsed.admin.createdAt || new Date().toISOString()),
      mustChangePassword: Boolean(parsed.admin.mustChangePassword),
    };
  }
  const list = Array.isArray(parsed?.users) ? parsed.users : [];
  const found = list.find((u) => u?.username === 'admin') || list[0];
  if (!found) return null;
  return {
    username: 'admin',
    salt: String(found.salt || ''),
    passwordHash: String(found.passwordHash || ''),
    createdAt: String(found.createdAt || new Date().toISOString()),
    mustChangePassword: found.mustChangePassword != null ? Boolean(found.mustChangePassword) : true,
  };
}

/** 表空时从旧 JSON 名册迁入，避免切换驱动丢数据。 */
async function migrateMembersFromJson() {
  const countRow = getOne('SELECT COUNT(*) AS c FROM members');
  if (Number(countRow?.c || 0) > 0) return;
  try {
    await access(MEMBERS_JSON);
  } catch {
    return;
  }
  const raw = await readFile(MEMBERS_JSON, 'utf8');
  const parsed = JSON.parse(raw);
  const members = Array.isArray(parsed?.members) ? parsed.members : [];
  if (!members.length) return;

  for (const m of members) {
    const cookie = String(m.cookieValue || '');
    const pulled = pulledColumnsFromSnapshot(m.lastSnapshot);
    run(
      `INSERT OR IGNORE INTO members
        (id, display_name, cookie_value, user_id, email, hostname, token_expires_at,
         plan_name, membership_type, total_percent_used, spend_today, spend_yesterday, spend_last30, hard_limit,
         created_at, updated_at, last_snapshot, last_error, last_synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        String(m.id || randomUUID()),
        String(m.displayName || m.userId || 'member'),
        cookie,
        String(m.userId || ''),
        m.email ? String(m.email) : pulled.email,
        m.hostname ? String(m.hostname) : null,
        tokenExpiresAtFromCookie(cookie),
        pulled.planName,
        pulled.membershipType,
        pulled.totalPercentUsed,
        pulled.spendToday,
        pulled.spendYesterday,
        pulled.spendLast30,
        pulled.hardLimit,
        String(m.createdAt || new Date().toISOString()),
        String(m.updatedAt || m.createdAt || new Date().toISOString()),
        m.lastSnapshot ? JSON.stringify(m.lastSnapshot) : null,
        m.lastError ?? null,
        m.lastSyncedAt ?? null,
      ],
    );
  }
  await persist();
  console.log(`已从 members.json 迁入 ${members.length} 条成员到 SQLite`);
}

/** 表空时从旧 users.json 迁入控制台账号。 */
async function migrateAdminFromJson() {
  const existing = getOne('SELECT username FROM console_admin WHERE username = ?', ['admin']);
  if (existing) return;
  try {
    await access(USERS_JSON);
  } catch {
    return;
  }
  const raw = await readFile(USERS_JSON, 'utf8');
  const admin = pickAdminFromJson(JSON.parse(raw));
  if (!admin?.salt || !admin?.passwordHash) return;
  await saveConsoleAdmin(admin);
  console.log('已从 users.json 迁入控制台账号到 SQLite');
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
  await migrateMembersFromJson();
  await migrateAdminFromJson();
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
  const namePatch = String(input.displayName || '').trim();
  const hostname = input.hostname != null ? String(input.hostname).trim() || null : null;
  const tokenExpiresAt = tokenExpiresAtFromCookie(session.cookieValue);

  if (existing) {
    const id = String(existing.id);
    run(
      `UPDATE members SET
        cookie_value=?,
        token_expires_at=?,
        display_name=CASE WHEN ? <> '' THEN ? ELSE display_name END,
        email=COALESCE(?, email),
        hostname=COALESCE(?, hostname),
        updated_at=?
       WHERE id=?`,
      [
        session.cookieValue,
        tokenExpiresAt,
        namePatch,
        namePatch,
        email,
        hostname,
        now,
        id,
      ],
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
    run(`UPDATE members SET last_error=?, last_synced_at=?, updated_at=? WHERE id=?`, [
      result.error ?? '同步失败',
      now,
      now,
      id,
    ]);
  }
  await persist();
  const next = await getMemberInternal(id);
  return next ? toPublicMember(next) : undefined;
}

/** @returns {Promise<ConsoleAdmin | null>} */
export async function getConsoleAdmin() {
  const row = getOne('SELECT * FROM console_admin WHERE username = ?', ['admin']);
  if (!row) return null;
  return {
    username: String(row.username),
    passwordHash: String(row.password_hash),
    salt: String(row.salt),
    createdAt: String(row.created_at),
    mustChangePassword: Boolean(row.must_change_password),
  };
}

/**
 * @param {ConsoleAdmin} admin
 */
export async function saveConsoleAdmin(admin) {
  run(
    `INSERT INTO console_admin (username, password_hash, salt, created_at, must_change_password)
     VALUES (?,?,?,?,?)
     ON CONFLICT(username) DO UPDATE SET
       password_hash=excluded.password_hash,
       salt=excluded.salt,
       created_at=excluded.created_at,
       must_change_password=excluded.must_change_password`,
    [
      admin.username || 'admin',
      admin.passwordHash,
      admin.salt,
      admin.createdAt,
      admin.mustChangePassword ? 1 : 0,
    ],
  );
  await persist();
}
