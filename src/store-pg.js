/**
 * PostgreSQL 存储：名册 + Token/用量列 + 控制台 admin，与 SQLite 字段对齐。
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { maskToken, sessionFromCookie, tokenExpiresAtIso } from './auth.js';
import { getDatabaseUrl } from './config.js';
import {
  pulledColumnsFromSnapshot,
  tokenExpiresAtFromCookie,
} from './store-member-fields.js';

const { Pool } = pg;

/** @type {import('pg').Pool | null} */
let pool = null;

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
 * @param {any} row
 * @returns {Member}
 */
function rowToMember(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    cookieValue: row.cookie_value,
    userId: row.user_id,
    email: row.email ?? undefined,
    hostname: row.hostname ?? null,
    tokenExpiresAt: row.token_expires_at
      ? new Date(row.token_expires_at).toISOString()
      : tokenExpiresAtIso(row.cookie_value),
    planName: row.plan_name ?? null,
    membershipType: row.membership_type ?? null,
    totalPercentUsed: row.total_percent_used != null ? Number(row.total_percent_used) : null,
    spendToday: row.spend_today != null ? Number(row.spend_today) : null,
    spendYesterday: row.spend_yesterday != null ? Number(row.spend_yesterday) : null,
    spendLast30: row.spend_last30 != null ? Number(row.spend_last30) : null,
    hardLimit: row.hard_limit != null ? Number(row.hard_limit) : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    lastSnapshot: row.last_snapshot ?? null,
    lastError: row.last_error ?? null,
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
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

function db() {
  if (!pool) throw new Error('PostgreSQL 未初始化');
  return pool;
}

/** 建连并确保表与 Token/用量列存在。 */
export async function init() {
  const url = getDatabaseUrl();
  if (!url) throw new Error('已选择 postgres 存储，但未配置 DATABASE_URL / databaseUrl');
  pool = new Pool({ connectionString: url });
  await db().query(`
    CREATE TABLE IF NOT EXISTS members (
      id UUID PRIMARY KEY,
      display_name TEXT NOT NULL,
      cookie_value TEXT NOT NULL,
      user_id TEXT NOT NULL UNIQUE,
      email TEXT,
      hostname TEXT,
      token_expires_at TIMESTAMPTZ,
      plan_name TEXT,
      membership_type TEXT,
      total_percent_used DOUBLE PRECISION,
      spend_today DOUBLE PRECISION,
      spend_yesterday DOUBLE PRECISION,
      spend_last30 DOUBLE PRECISION,
      hard_limit DOUBLE PRECISION,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      last_snapshot JSONB,
      last_error TEXT,
      last_synced_at TIMESTAMPTZ
    )
  `);
  // 旧库补列，与新建表字段对齐。
  await db().query(`
    ALTER TABLE members
      ADD COLUMN IF NOT EXISTS hostname TEXT,
      ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS plan_name TEXT,
      ADD COLUMN IF NOT EXISTS membership_type TEXT,
      ADD COLUMN IF NOT EXISTS total_percent_used DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS spend_today DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS spend_yesterday DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS spend_last30 DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS hard_limit DOUBLE PRECISION
  `);
  await db().query(`
    CREATE TABLE IF NOT EXISTS console_admin (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      must_change_password BOOLEAN NOT NULL DEFAULT TRUE
    )
  `);
}

/** 热切换存储前释放连接池。 */
export async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function listMembers() {
  const { rows } = await db().query('SELECT * FROM members ORDER BY created_at ASC');
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

  const exists = await db().query('SELECT 1 FROM members WHERE user_id = $1', [session.userId]);
  if (exists.rowCount) throw new Error(`该账号已在名册中（${session.userId}）`);

  const now = new Date().toISOString();
  const id = randomUUID();
  const hostname = input.hostname ? String(input.hostname).trim() : null;
  await db().query(
    `INSERT INTO members
      (id, display_name, cookie_value, user_id, hostname, token_expires_at,
       created_at, updated_at, last_snapshot, last_error, last_synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7,NULL,NULL,NULL)`,
    [
      id,
      displayName,
      session.cookieValue,
      session.userId,
      hostname,
      tokenExpiresAtFromCookie(session.cookieValue),
      now,
    ],
  );
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
    const clash = await db().query(
      'SELECT 1 FROM members WHERE user_id = $1 AND id <> $2',
      [session.userId, id],
    );
    if (clash.rowCount) throw new Error('该账号已绑定其他成员');
    cookieValue = session.cookieValue;
    userId = session.userId;
    tokenExpiresAt = tokenExpiresAtFromCookie(cookieValue);
  }
  if (patch.hostname != null) {
    hostname = String(patch.hostname).trim() || null;
  }

  const now = new Date().toISOString();
  await db().query(
    `UPDATE members SET display_name=$1, cookie_value=$2, user_id=$3, hostname=$4, token_expires_at=$5, updated_at=$6 WHERE id=$7`,
    [displayName, cookieValue, userId, hostname, tokenExpiresAt, now, id],
  );
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
  const existing = await db().query('SELECT id FROM members WHERE user_id = $1', [session.userId]);
  const fallbackName =
    String(input.displayName || '').trim() ||
    String(input.email || '').trim() ||
    session.userId;
  const hostname = input.hostname != null ? String(input.hostname).trim() || null : null;
  const tokenExpiresAt = tokenExpiresAtFromCookie(session.cookieValue);

  if (existing.rowCount) {
    const id = existing.rows[0].id;
    await db().query(
      `UPDATE members SET
        cookie_value=$1,
        token_expires_at=$2,
        display_name=CASE WHEN $3 <> '' THEN $3 ELSE display_name END,
        email=COALESCE($4, email),
        hostname=COALESCE($5, hostname),
        updated_at=$6
       WHERE id=$7`,
      [
        session.cookieValue,
        tokenExpiresAt,
        String(input.displayName || '').trim(),
        input.email ? String(input.email).trim() : null,
        hostname,
        now,
        id,
      ],
    );
    const member = await getMemberInternal(id);
    return { member: toPublicMember(/** @type {Member} */ (member)), created: false };
  }

  const id = randomUUID();
  await db().query(
    `INSERT INTO members
      (id, display_name, cookie_value, user_id, email, hostname, token_expires_at,
       created_at, updated_at, last_snapshot, last_error, last_synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,NULL,NULL,NULL)`,
    [
      id,
      fallbackName,
      session.cookieValue,
      session.userId,
      input.email ? String(input.email).trim() : null,
      hostname,
      tokenExpiresAt,
      now,
    ],
  );
  const member = await getMemberInternal(id);
  return { member: toPublicMember(/** @type {Member} */ (member)), created: true };
}

/** @param {string} id */
export async function deleteMember(id) {
  const res = await db().query('DELETE FROM members WHERE id = $1', [id]);
  if (!res.rowCount) throw new Error('成员不存在');
}

/** @param {string} id */
export async function getMemberInternal(id) {
  const { rows } = await db().query('SELECT * FROM members WHERE id = $1', [id]);
  return rows[0] ? rowToMember(rows[0]) : null;
}

export async function getAllMembersInternal() {
  const { rows } = await db().query('SELECT * FROM members ORDER BY created_at ASC');
  return rows.map(rowToMember);
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
    await db().query(
      `UPDATE members SET
        last_snapshot=$1::jsonb,
        email=COALESCE($2, email),
        plan_name=$3,
        membership_type=$4,
        total_percent_used=$5,
        spend_today=$6,
        spend_yesterday=$7,
        spend_last30=$8,
        hard_limit=$9,
        token_expires_at=COALESCE($10::timestamptz, token_expires_at),
        last_error=NULL,
        last_synced_at=$11,
        updated_at=$11
       WHERE id=$12`,
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
        id,
      ],
    );
  } else {
    // 尚无成功快照时不推进 last_synced_at，便于按到期逻辑尽快重试。
    await db().query(
      `UPDATE members SET
        last_error=$1,
        last_synced_at=CASE WHEN last_snapshot IS NULL THEN last_synced_at ELSE $2 END,
        updated_at=$2
       WHERE id=$3`,
      [result.error ?? '同步失败', now, id],
    );
  }
  const next = await getMemberInternal(id);
  return next ? toPublicMember(next) : undefined;
}

/**
 * @typedef {{
 *   username: string,
 *   passwordHash: string,
 *   salt: string,
 *   createdAt: string,
 *   mustChangePassword: boolean,
 * }} ConsoleAdmin
 */

/** @returns {Promise<ConsoleAdmin | null>} */
export async function getConsoleAdmin() {
  const { rows } = await db().query('SELECT * FROM console_admin WHERE username = $1', ['admin']);
  const row = rows[0];
  if (!row) return null;
  return {
    username: String(row.username),
    passwordHash: String(row.password_hash),
    salt: String(row.salt),
    createdAt: new Date(row.created_at).toISOString(),
    mustChangePassword: Boolean(row.must_change_password),
  };
}

/**
 * @param {ConsoleAdmin} admin
 */
export async function saveConsoleAdmin(admin) {
  await db().query(
    `INSERT INTO console_admin (username, password_hash, salt, created_at, must_change_password)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (username) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       salt = EXCLUDED.salt,
       created_at = EXCLUDED.created_at,
       must_change_password = EXCLUDED.must_change_password`,
    [
      admin.username || 'admin',
      admin.passwordHash,
      admin.salt,
      admin.createdAt,
      Boolean(admin.mustChangePassword),
    ],
  );
}
