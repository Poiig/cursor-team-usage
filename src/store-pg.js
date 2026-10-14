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
import { recordSyncPercents } from './usage-percent-history.js';
import {
  USAGE_EVENTS_RETENTION_DAYS,
  normalizeUsageEventForStore,
  usageEventFromStoreRow,
} from './usage-events.js';

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
 *   eventsSyncedAt?: string | null,
 *   usagePercentHistory?: Array<{ date: string, total?: number | null, auto?: number | null, api?: number | null }>,
 * }} Member
 */

/**
 * 解析按日额度% JSON；坏数据当空数组。
 * @param {unknown} raw
 */
function parseUsagePercentHistory(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

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
    eventsSyncedAt: row.events_synced_at ? new Date(row.events_synced_at).toISOString() : null,
    usagePercentHistory: parseUsagePercentHistory(row.usage_percent_history),
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
    usagePercentHistory: m.usagePercentHistory ?? [],
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
      usage_percent_history JSONB,
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
      ADD COLUMN IF NOT EXISTS hard_limit DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS usage_percent_history JSONB,
      ADD COLUMN IF NOT EXISTS events_synced_at TIMESTAMPTZ
  `);
  await db().query(`
    CREATE TABLE IF NOT EXISTS usage_events (
      member_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      ts_ms BIGINT NOT NULL,
      model TEXT,
      kind TEXT,
      kind_label TEXT,
      is_token_based BOOLEAN NOT NULL DEFAULT FALSE,
      charged_cents INTEGER,
      token_cents INTEGER,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_label TEXT,
      synced_at TIMESTAMPTZ,
      PRIMARY KEY (member_id, event_id)
    )
  `);
  await db().query(
    `CREATE INDEX IF NOT EXISTS idx_usage_events_member_ts ON usage_events (member_id, ts_ms DESC)`,
  );
  await db().query(
    `CREATE INDEX IF NOT EXISTS idx_usage_events_member_model_ts ON usage_events (member_id, model, ts_ms DESC)`,
  );
  await db().query(`
    CREATE TABLE IF NOT EXISTS console_admin (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      must_change_password BOOLEAN NOT NULL DEFAULT TRUE
    )
  `);
  await db().query(`
    CREATE TABLE IF NOT EXISTS console_users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TIMESTAMPTZ NOT NULL,
      must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
      disabled BOOLEAN NOT NULL DEFAULT FALSE,
      pending BOOLEAN NOT NULL DEFAULT FALSE,
      alias TEXT NOT NULL DEFAULT ''
    )
  `);
  await db().query(`
    ALTER TABLE console_users
      ADD COLUMN IF NOT EXISTS pending BOOLEAN NOT NULL DEFAULT FALSE
  `);
  await db().query(`
    ALTER TABLE console_users
      ADD COLUMN IF NOT EXISTS alias TEXT NOT NULL DEFAULT ''
  `);
  await db().query(`
    CREATE TABLE IF NOT EXISTS account_switch_logs (
      id UUID PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL,
      operator_username TEXT NOT NULL,
      member_id TEXT,
      member_display_name TEXT,
      member_email TEXT,
      member_user_id TEXT,
      hostname TEXT,
      client_ip TEXT,
      usage_total_percent DOUBLE PRECISION,
      status TEXT NOT NULL,
      error TEXT,
      ticket_id TEXT,
      claimed_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    )
  `);
  await db().query(`
    ALTER TABLE account_switch_logs
      ADD COLUMN IF NOT EXISTS client_ip TEXT,
      ADD COLUMN IF NOT EXISTS usage_total_percent DOUBLE PRECISION
  `);
  await migrateConsoleAdminToUsers();
}

/** 把遗留 console_admin 迁入 console_users。 */
async function migrateConsoleAdminToUsers() {
  const { rows: existing } = await db().query('SELECT 1 AS x FROM console_users LIMIT 1');
  if (existing.length) return;
  const { rows } = await db().query('SELECT * FROM console_admin WHERE username = $1', ['admin']);
  const row = rows[0];
  if (!row) return;
  await db().query(
    `INSERT INTO console_users
      (username, password_hash, salt, role, created_at, must_change_password, disabled, pending)
     VALUES ($1,$2,$3,'admin',$4,$5,FALSE,FALSE)`,
    [
      String(row.username || 'admin'),
      String(row.password_hash),
      String(row.salt),
      new Date(row.created_at).toISOString(),
      Boolean(row.must_change_password),
    ],
  );
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
    // 上报只轮换 Token / 邮箱；已有显示名与主机名不覆盖，避免冲掉人工改名
    await db().query(
      `UPDATE members SET
        cookie_value=$1,
        token_expires_at=$2,
        email=COALESCE($3, email),
        updated_at=$4
       WHERE id=$5`,
      [
        session.cookieValue,
        tokenExpiresAt,
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
  await db().query('DELETE FROM usage_events WHERE member_id = $1', [id]);
  const res = await db().query('DELETE FROM members WHERE id = $1', [id]);
  if (!res.rowCount) throw new Error('成员不存在');
}

/**
 * @param {string} memberId
 * @param {any[]} events
 * @returns {Promise<{ upserted: number }>}
 */
export async function upsertUsageEvents(memberId, events) {
  if (!memberId) return { upserted: 0 };
  const syncedAt = new Date().toISOString();
  const list = Array.isArray(events) ? events : [];
  let upserted = 0;
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    for (const raw of list) {
      const e = normalizeUsageEventForStore(raw, syncedAt);
      if (!e.eventId || !e.tsMs) continue;
      await client.query(
        `INSERT INTO usage_events (
          member_id, event_id, ts_ms, model, kind, kind_label, is_token_based,
          charged_cents, token_cents, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, total_tokens, cost_label, synced_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT (member_id, event_id) DO UPDATE SET
          ts_ms=EXCLUDED.ts_ms,
          model=EXCLUDED.model,
          kind=EXCLUDED.kind,
          kind_label=EXCLUDED.kind_label,
          is_token_based=EXCLUDED.is_token_based,
          charged_cents=EXCLUDED.charged_cents,
          token_cents=EXCLUDED.token_cents,
          input_tokens=EXCLUDED.input_tokens,
          output_tokens=EXCLUDED.output_tokens,
          cache_read_tokens=EXCLUDED.cache_read_tokens,
          cache_write_tokens=EXCLUDED.cache_write_tokens,
          total_tokens=EXCLUDED.total_tokens,
          cost_label=EXCLUDED.cost_label,
          synced_at=EXCLUDED.synced_at`,
        [
          memberId,
          e.eventId,
          e.tsMs,
          e.model,
          e.kind,
          e.kindLabel,
          e.isTokenBased,
          e.chargedCents,
          e.tokenCents,
          e.inputTokens,
          e.outputTokens,
          e.cacheReadTokens,
          e.cacheWriteTokens,
          e.totalTokens,
          e.costLabel,
          e.syncedAt,
        ],
      );
      upserted += 1;
    }
    const cutoff = Date.now() - USAGE_EVENTS_RETENTION_DAYS * 86400000;
    await client.query('DELETE FROM usage_events WHERE member_id = $1 AND ts_ms < $2', [
      memberId,
      cutoff,
    ]);
    await client.query(
      'UPDATE members SET events_synced_at=$1, updated_at=$1 WHERE id=$2',
      [syncedAt, memberId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { upserted };
}

/**
 * @param {string} memberId
 * @returns {Promise<number | null>}
 */
export async function getUsageEventsWatermark(memberId) {
  const { rows } = await db().query(
    'SELECT MAX(ts_ms) AS m FROM usage_events WHERE member_id = $1',
    [memberId],
  );
  const m = rows[0]?.m;
  return m != null && Number.isFinite(Number(m)) && Number(m) > 0 ? Number(m) : null;
}

/**
 * @param {string} memberId
 * @returns {Promise<{ count: number, syncedAt: string | null }>}
 */
export async function getUsageEventsMeta(memberId) {
  const { rows: countRows } = await db().query(
    'SELECT COUNT(*)::int AS c FROM usage_events WHERE member_id = $1',
    [memberId],
  );
  const { rows: memberRows } = await db().query(
    'SELECT events_synced_at FROM members WHERE id = $1',
    [memberId],
  );
  const synced = memberRows[0]?.events_synced_at;
  return {
    count: Number(countRows[0]?.c) || 0,
    syncedAt: synced ? new Date(synced).toISOString() : null,
  };
}

/**
 * @param {string} memberId
 * @param {{ days?: number, model?: string, page?: number, pageSize?: number, nowMs?: number }} [opts]
 */
export async function listUsageEvents(memberId, opts = {}) {
  const days = Math.min(90, Math.max(1, Number(opts.days) || 7));
  const page = Math.max(1, Number(opts.page) || 1);
  const pageSize = Math.min(100, Math.max(10, Number(opts.pageSize) || 50));
  const nowMs = Number(opts.nowMs) || Date.now();
  const since = nowMs - days * 86400000;
  const model = String(opts.model || '').trim();

  /** @type {unknown[]} */
  const whereParams = [memberId, since];
  let where = 'member_id = $1 AND ts_ms >= $2';
  if (model) {
    whereParams.push(model);
    where += ` AND model = $${whereParams.length}`;
  }

  const { rows: totalRows } = await db().query(
    `SELECT COUNT(*)::int AS c FROM usage_events WHERE ${where}`,
    whereParams,
  );
  const total = Number(totalRows[0]?.c) || 0;
  const offset = (page - 1) * pageSize;
  const { rows } = await db().query(
    `SELECT * FROM usage_events WHERE ${where} ORDER BY ts_ms DESC LIMIT $${whereParams.length + 1} OFFSET $${whereParams.length + 2}`,
    [...whereParams, pageSize, offset],
  );
  const { rows: modelRows } = await db().query(
    `SELECT DISTINCT model FROM usage_events
     WHERE member_id = $1 AND ts_ms >= $2 AND model IS NOT NULL AND model <> ''
     ORDER BY model ASC`,
    [memberId, since],
  );
  const meta = await getUsageEventsMeta(memberId);
  return {
    days,
    page,
    pageSize,
    total,
    hasNext: offset + rows.length < total,
    events: rows.map(usageEventFromStoreRow),
    models: modelRows.map((r) => String(r.model)),
    syncedAt: meta.syncedAt,
  };
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
    if (result.snapshot._usageEvents) delete result.snapshot._usageEvents;
    const syncedAt = result.snapshot.syncedAt || now;
    const pulled = pulledColumnsFromSnapshot(result.snapshot);
    // 同步时覆写「今天」累计%，凌晨归档再盖写昨天收盘值。
    const history = recordSyncPercents(member.usagePercentHistory, result.snapshot);
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
        usage_percent_history=$10::jsonb,
        token_expires_at=COALESCE($11::timestamptz, token_expires_at),
        last_error=NULL,
        last_synced_at=$12,
        updated_at=$12
       WHERE id=$13`,
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
        JSON.stringify(history),
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
 * 写入按日额度%历史（凌晨归档用）。
 * @param {string} id
 * @param {Array<{ date: string, total?: number | null, auto?: number | null, api?: number | null }>} history
 */
export async function setUsagePercentHistory(id, history) {
  const now = new Date().toISOString();
  await db().query(
    `UPDATE members SET usage_percent_history=$1::jsonb, updated_at=$2 WHERE id=$3`,
    [JSON.stringify(history || []), now, id],
  );
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
 * }} ConsoleUserRow
 */

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
    createdAt: new Date(row.created_at).toISOString(),
    mustChangePassword: Boolean(row.must_change_password),
    disabled: Boolean(row.disabled),
    pending: Boolean(row.pending),
    alias: String(row.alias || ''),
  };
}

/** @returns {Promise<ConsoleUserRow[]>} */
export async function listConsoleUsers() {
  const { rows } = await db().query('SELECT * FROM console_users ORDER BY created_at ASC');
  return rows.map((r) => /** @type {ConsoleUserRow} */ (rowToConsoleUser(r)));
}

/** @param {string} username */
export async function getConsoleUser(username) {
  const { rows } = await db().query('SELECT * FROM console_users WHERE username = $1', [
    String(username || ''),
  ]);
  return rowToConsoleUser(rows[0]);
}

/** @param {ConsoleUserRow} user */
export async function createConsoleUser(user) {
  const existing = await getConsoleUser(user.username);
  if (existing) throw new Error('用户名已存在');
  await db().query(
    `INSERT INTO console_users
      (username, password_hash, salt, role, created_at, must_change_password, disabled, pending, alias)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      user.username,
      user.passwordHash,
      user.salt,
      user.role === 'admin' ? 'admin' : 'user',
      user.createdAt,
      Boolean(user.mustChangePassword),
      Boolean(user.disabled),
      Boolean(user.pending),
      String(user.alias || ''),
    ],
  );
  if (user.username === 'admin') await saveConsoleAdminMirror(user);
}

/** @param {ConsoleUserRow} user */
export async function saveConsoleUser(user) {
  await db().query(
    `INSERT INTO console_users
      (username, password_hash, salt, role, created_at, must_change_password, disabled, pending, alias)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (username) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       salt = EXCLUDED.salt,
       role = EXCLUDED.role,
       created_at = EXCLUDED.created_at,
       must_change_password = EXCLUDED.must_change_password,
       disabled = EXCLUDED.disabled,
       pending = EXCLUDED.pending,
       alias = EXCLUDED.alias`,
    [
      user.username,
      user.passwordHash,
      user.salt,
      user.role === 'admin' ? 'admin' : 'user',
      user.createdAt,
      Boolean(user.mustChangePassword),
      Boolean(user.disabled),
      Boolean(user.pending),
      String(user.alias || ''),
    ],
  );
  if (user.username === 'admin') await saveConsoleAdminMirror(user);
}

/** @param {ConsoleUserRow} user */
async function saveConsoleAdminMirror(user) {
  await db().query(
    `INSERT INTO console_admin (username, password_hash, salt, created_at, must_change_password)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (username) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       salt = EXCLUDED.salt,
       created_at = EXCLUDED.created_at,
       must_change_password = EXCLUDED.must_change_password`,
    [
      user.username,
      user.passwordHash,
      user.salt,
      user.createdAt,
      Boolean(user.mustChangePassword),
    ],
  );
}

/** @param {string} username */
export async function deleteConsoleUser(username) {
  const name = String(username || '');
  if (name === 'admin') throw new Error('不能删除 admin');
  const { rowCount } = await db().query('DELETE FROM console_users WHERE username = $1', [name]);
  if (!rowCount) throw new Error('用户不存在');
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

/** @param {any} row @returns {SwitchLogRow} */
function rowToSwitchLog(row) {
  return {
    id: String(row.id),
    createdAt: new Date(row.created_at).toISOString(),
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
    claimedAt: row.claimed_at ? new Date(row.claimed_at).toISOString() : null,
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
  };
}

/** @param {Omit<SwitchLogRow, 'createdAt'> & { createdAt?: string }} log */
export async function insertSwitchLog(log) {
  const createdAt = log.createdAt || new Date().toISOString();
  await db().query(
    `INSERT INTO account_switch_logs
      (id, created_at, operator_username, member_id, member_display_name, member_email,
       member_user_id, hostname, client_ip, usage_total_percent, status, error, ticket_id,
       claimed_at, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
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
  return getSwitchLog(log.id);
}

/**
 * @param {string} id
 * @param {Partial<Pick<SwitchLogRow, 'status' | 'error' | 'hostname' | 'claimedAt' | 'finishedAt'>>} patch
 */
export async function updateSwitchLog(id, patch) {
  const before = await getSwitchLog(id);
  if (!before) throw new Error('切换记录不存在');
  await db().query(
    `UPDATE account_switch_logs SET
      status=$1, error=$2, hostname=$3, claimed_at=$4, finished_at=$5
     WHERE id=$6`,
    [
      patch.status ?? before.status,
      patch.error !== undefined ? patch.error : before.error,
      patch.hostname !== undefined ? patch.hostname : before.hostname,
      patch.claimedAt !== undefined ? patch.claimedAt : before.claimedAt,
      patch.finishedAt !== undefined ? patch.finishedAt : before.finishedAt,
      id,
    ],
  );
  return getSwitchLog(id);
}

/** @param {{ limit?: number }} [opts] */
export async function listSwitchLogs(opts = {}) {
  const limit = Math.min(500, Math.max(1, Number(opts.limit) || 100));
  const { rows } = await db().query(
    'SELECT * FROM account_switch_logs ORDER BY created_at DESC LIMIT $1',
    [limit],
  );
  return rows.map(rowToSwitchLog);
}

/** @param {string} id */
export async function getSwitchLog(id) {
  const { rows } = await db().query('SELECT * FROM account_switch_logs WHERE id = $1', [id]);
  return rows[0] ? rowToSwitchLog(rows[0]) : null;
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
