/**
 * 一次性：把本地/备份的 app.sqlite 迁入 PostgreSQL。
 * 用法：
 *   SQLITE_PATH=./data/app.sqlite DATABASE_URL=postgresql://... node scripts/migrate-sqlite-to-pg.mjs
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import initSqlJs from 'sql.js';
import pg from 'pg';

const require = createRequire(import.meta.url);
const sqlJsDir = path.dirname(require.resolve('sql.js'));

const sqlitePath = process.env.SQLITE_PATH || 'data/app.sqlite';
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('缺少 DATABASE_URL');
  process.exit(1);
}

/** @param {import('sql.js').Database} db @param {string} sql */
function all(db, sql) {
  const stmt = db.prepare(sql);
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  try {
    while (stmt.step()) rows.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return rows;
}

/** @param {unknown} v */
function bool(v) {
  return v === 1 || v === true || v === '1';
}

/** @param {unknown} v */
function jsonOrNull(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  try {
    JSON.parse(s);
    return s;
  } catch {
    return null;
  }
}

/** @param {unknown} v */
function tsOrNull(v) {
  if (v == null || v === '') return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function ensureSchema(client) {
  await client.query(`
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
  await client.query(`
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
  await client.query(`
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
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_usage_events_member_ts ON usage_events (member_id, ts_ms DESC)`,
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_usage_events_member_model_ts ON usage_events (member_id, model, ts_ms DESC)`,
  );
  await client.query(`
    CREATE TABLE IF NOT EXISTS console_admin (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      must_change_password BOOLEAN NOT NULL DEFAULT TRUE
    )
  `);
  await client.query(`
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
  await client.query(`
    ALTER TABLE console_users
      ADD COLUMN IF NOT EXISTS pending BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS alias TEXT NOT NULL DEFAULT ''
  `);
  await client.query(`
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
  await client.query(`
    ALTER TABLE account_switch_logs
      ADD COLUMN IF NOT EXISTS client_ip TEXT,
      ADD COLUMN IF NOT EXISTS usage_total_percent DOUBLE PRECISION
  `);
}

async function main() {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(sqlJsDir, file),
  });
  const buf = await readFile(sqlitePath);
  const sqlite = new SQL.Database(buf);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await ensureSchema(client);
    await client.query('BEGIN');

    // 全量覆盖迁移：先清业务表再插入，避免半旧半新。
    await client.query('DELETE FROM usage_events');
    await client.query('DELETE FROM account_switch_logs');
    await client.query('DELETE FROM members');
    await client.query('DELETE FROM console_users');
    await client.query('DELETE FROM console_admin');

    const members = all(sqlite, 'SELECT * FROM members');
    for (const m of members) {
      await client.query(
        `INSERT INTO members (
          id, display_name, cookie_value, user_id, email, hostname, token_expires_at,
          plan_name, membership_type, total_percent_used, spend_today, spend_yesterday,
          spend_last30, hard_limit, usage_percent_history, created_at, updated_at,
          last_snapshot, last_error, last_synced_at, events_synced_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18::jsonb,$19,$20,$21
        )`,
        [
          m.id,
          m.display_name,
          m.cookie_value,
          m.user_id,
          m.email ?? null,
          m.hostname ?? null,
          tsOrNull(m.token_expires_at),
          m.plan_name ?? null,
          m.membership_type ?? null,
          m.total_percent_used ?? null,
          m.spend_today ?? null,
          m.spend_yesterday ?? null,
          m.spend_last30 ?? null,
          m.hard_limit ?? null,
          jsonOrNull(m.usage_percent_history),
          tsOrNull(m.created_at) || new Date().toISOString(),
          tsOrNull(m.updated_at) || new Date().toISOString(),
          jsonOrNull(m.last_snapshot),
          m.last_error ?? null,
          tsOrNull(m.last_synced_at),
          tsOrNull(m.events_synced_at),
        ],
      );
    }

    const users = all(sqlite, 'SELECT * FROM console_users');
    for (const u of users) {
      await client.query(
        `INSERT INTO console_users (
          username, password_hash, salt, role, created_at, must_change_password, disabled, pending, alias
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          u.username,
          u.password_hash,
          u.salt,
          u.role || 'user',
          tsOrNull(u.created_at) || new Date().toISOString(),
          bool(u.must_change_password),
          bool(u.disabled),
          bool(u.pending),
          u.alias == null ? '' : String(u.alias),
        ],
      );
    }

    const admins = all(sqlite, 'SELECT * FROM console_admin');
    for (const a of admins) {
      await client.query(
        `INSERT INTO console_admin (username, password_hash, salt, created_at, must_change_password)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          a.username,
          a.password_hash,
          a.salt,
          tsOrNull(a.created_at) || new Date().toISOString(),
          bool(a.must_change_password),
        ],
      );
    }

    const logs = all(sqlite, 'SELECT * FROM account_switch_logs');
    for (const l of logs) {
      await client.query(
        `INSERT INTO account_switch_logs (
          id, created_at, operator_username, member_id, member_display_name, member_email,
          member_user_id, hostname, client_ip, usage_total_percent, status, error,
          ticket_id, claimed_at, finished_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          l.id,
          tsOrNull(l.created_at) || new Date().toISOString(),
          l.operator_username,
          l.member_id ?? null,
          l.member_display_name ?? null,
          l.member_email ?? null,
          l.member_user_id ?? null,
          l.hostname ?? null,
          l.client_ip ?? null,
          l.usage_total_percent ?? null,
          l.status,
          l.error ?? null,
          l.ticket_id ?? null,
          tsOrNull(l.claimed_at),
          tsOrNull(l.finished_at),
        ],
      );
    }

    // usage_events：旧库可能尚无此表
    let events = [];
    try {
      events = all(sqlite, 'SELECT * FROM usage_events');
    } catch {
      events = [];
    }
    for (const e of events) {
      await client.query(
        `INSERT INTO usage_events (
          member_id, event_id, ts_ms, model, kind, kind_label, is_token_based,
          charged_cents, token_cents, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, total_tokens, cost_label, synced_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT (member_id, event_id) DO NOTHING`,
        [
          e.member_id,
          e.event_id,
          Number(e.ts_ms) || 0,
          e.model ?? null,
          e.kind ?? null,
          e.kind_label ?? null,
          bool(e.is_token_based),
          e.charged_cents ?? null,
          e.token_cents ?? null,
          Number(e.input_tokens) || 0,
          Number(e.output_tokens) || 0,
          Number(e.cache_read_tokens) || 0,
          Number(e.cache_write_tokens) || 0,
          Number(e.total_tokens) || 0,
          e.cost_label ?? null,
          tsOrNull(e.synced_at),
        ],
      );
    }

    await client.query('COMMIT');

    const counts = await client.query(`
      SELECT 'members' AS t, COUNT(*)::int AS c FROM members
      UNION ALL SELECT 'console_users', COUNT(*)::int FROM console_users
      UNION ALL SELECT 'console_admin', COUNT(*)::int FROM console_admin
      UNION ALL SELECT 'account_switch_logs', COUNT(*)::int FROM account_switch_logs
      UNION ALL SELECT 'usage_events', COUNT(*)::int FROM usage_events
    `);
    console.log('迁移完成：', Object.fromEntries(counts.rows.map((r) => [r.t, r.c])));
    console.log(`源 sqlite: ${sqlitePath}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    sqlite.close();
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
