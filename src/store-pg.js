/**
 * PostgreSQL 名册：启动时 CREATE TABLE IF NOT EXISTS，与 JSON 存储字段对齐。
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { maskToken, sessionFromCookie, tokenExpiresAtIso } from './auth.js';
import { getDatabaseUrl } from './config.js';

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
    tokenHint: maskToken(m.cookieValue),
    tokenExpiresAt: tokenExpiresAtIso(m.cookieValue),
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

/** 建连并确保表存在。 */
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
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      last_snapshot JSONB,
      last_error TEXT,
      last_synced_at TIMESTAMPTZ
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
 * @param {{ displayName: string, sessionToken: string }} input
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
  await db().query(
    `INSERT INTO members
      (id, display_name, cookie_value, user_id, created_at, updated_at, last_snapshot, last_error, last_synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,NULL,NULL,NULL)`,
    [id, displayName, session.cookieValue, session.userId, now, now],
  );
  const member = await getMemberInternal(id);
  return toPublicMember(/** @type {Member} */ (member));
}

/**
 * @param {string} id
 * @param {{ displayName?: string, sessionToken?: string }} patch
 */
export async function updateMember(id, patch) {
  const member = await getMemberInternal(id);
  if (!member) throw new Error('成员不存在');

  let displayName = member.displayName;
  let cookieValue = member.cookieValue;
  let userId = member.userId;

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
  }

  const now = new Date().toISOString();
  await db().query(
    `UPDATE members SET display_name=$1, cookie_value=$2, user_id=$3, updated_at=$4 WHERE id=$5`,
    [displayName, cookieValue, userId, now, id],
  );
  const next = await getMemberInternal(id);
  return toPublicMember(/** @type {Member} */ (next));
}

/**
 * @param {{ displayName?: string, sessionToken: string, email?: string }} input
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

  if (existing.rowCount) {
    const id = existing.rows[0].id;
    await db().query(
      `UPDATE members SET
        cookie_value=$1,
        display_name=CASE WHEN $2 <> '' THEN $2 ELSE display_name END,
        email=COALESCE($3, email),
        updated_at=$4
       WHERE id=$5`,
      [
        session.cookieValue,
        String(input.displayName || '').trim(),
        input.email ? String(input.email).trim() : null,
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
      (id, display_name, cookie_value, user_id, email, created_at, updated_at, last_snapshot, last_error, last_synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$6,NULL,NULL,NULL)`,
    [
      id,
      fallbackName,
      session.cookieValue,
      session.userId,
      input.email ? String(input.email).trim() : null,
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
    await db().query(
      `UPDATE members SET
        last_snapshot=$1::jsonb,
        email=COALESCE($2, email),
        last_error=NULL,
        last_synced_at=$3,
        updated_at=$3
       WHERE id=$4`,
      [
        JSON.stringify(result.snapshot),
        result.snapshot.email ?? null,
        result.snapshot.syncedAt || now,
        id,
      ],
    );
  } else {
    await db().query(
      `UPDATE members SET last_error=$1, last_synced_at=$2, updated_at=$2 WHERE id=$3`,
      [result.error ?? '同步失败', now, id],
    );
  }
  const next = await getMemberInternal(id);
  return next ? toPublicMember(next) : undefined;
}
