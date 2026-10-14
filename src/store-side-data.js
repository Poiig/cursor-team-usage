/**
 * 侧数据（插件版本、登录/上报审计、注册申请、应用日志）的统一实现。
 * 由 sqlite / pg / file 驱动在 init 时 bind，保证与名册同库、同生命周期。
 * 旧 JSON / 按日 .log 仅在表空时导入一次，避免反复覆盖。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');

export const LOGIN_EVENTS_MAX = 2000;
export const REPORT_EVENTS_MAX = 3000;
export const APPLICATIONS_MAX = 500;
export const SWITCH_LOGS_MAX = 5000;
/** presence 超过该时长视为过期，上报/切换时清理。 */
export const PRESENCE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @typedef {{
 *   kind: 'sqlite',
 *   run: (sql: string, params?: any[]) => void,
 *   getAll: (sql: string, params?: any[]) => any[],
 *   getOne: (sql: string, params?: any[]) => any,
 *   persist: () => Promise<void>,
 * } | {
 *   kind: 'pg',
 *   query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>,
 * } | {
 *   kind: 'file',
 *   dataDir?: string,
 * }} SideCtx
 */

/**
 * @param {SideCtx} ctx
 */
export function createSideDataApi(ctx) {
  if (ctx.kind === 'sqlite') return createSqliteApi(ctx);
  if (ctx.kind === 'pg') return createPgApi(ctx);
  return createFileApi(ctx);
}

/** @param {Extract<SideCtx, { kind: 'sqlite' }>} ctx */
function createSqliteApi(ctx) {
  const { run, getAll, getOne, persist } = ctx;

  function ensure() {
    run(`
      CREATE TABLE IF NOT EXISTS plugin_clients (
        username TEXT PRIMARY KEY,
        version TEXT,
        build TEXT,
        installed_at TEXT,
        report_version TEXT,
        report_build TEXT,
        reported_at TEXT,
        hostname TEXT
      )
    `);
    run(`
      CREATE TABLE IF NOT EXISTS login_events (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        username TEXT NOT NULL,
        ok INTEGER NOT NULL,
        role TEXT,
        ip TEXT,
        user_agent TEXT
      )
    `);
    run(`
      CREATE TABLE IF NOT EXISTS report_events (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        operator_username TEXT,
        member_id TEXT,
        member_display_name TEXT,
        member_email TEXT,
        hostname TEXT,
        host_remark TEXT,
        plugin_version TEXT,
        plugin_build TEXT,
        ok INTEGER,
        error TEXT,
        payload TEXT
      )
    `);
    run(`
      CREATE TABLE IF NOT EXISTS applications (
        token TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    run(`
      CREATE TABLE IF NOT EXISTS app_logs (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        action TEXT NOT NULL,
        line TEXT NOT NULL,
        fields_json TEXT
      )
    `);
    ensureIndexes(run);
  }

  /**
   * 表空时从旧 JSON 导入一次。
   */
  async function migrateLegacyIfEmpty() {
    if (!getOne('SELECT 1 AS x FROM plugin_clients LIMIT 1')) {
      const map = await readLegacyJsonObject('plugin-clients.json');
      for (const [username, row] of Object.entries(map)) {
        await upsertPluginClientRow(username, row);
      }
      await renameLegacy('plugin-clients.json');
    }
    if (!getOne('SELECT 1 AS x FROM login_events LIMIT 1')) {
      const rows = await readLegacyJsonArray('login-events.json');
      for (const row of rows) insertLoginEventRow(row);
      await renameLegacy('login-events.json');
    }
    if (!getOne('SELECT 1 AS x FROM report_events LIMIT 1')) {
      const rows = await readLegacyJsonArray('report-events.json');
      for (const row of rows) insertReportEventRow(row);
      await renameLegacy('report-events.json');
    }
    if (!getOne('SELECT 1 AS x FROM applications LIMIT 1')) {
      const rows = await readLegacyJsonArray('applications.json');
      for (const row of rows) insertApplicationRow(row);
      await renameLegacy('applications.json');
    }
    await persist();
  }

  /** @param {string} username @param {any} row */
  async function upsertPluginClientRow(username, row) {
    run(
      `INSERT INTO plugin_clients
        (username, version, build, installed_at, report_version, report_build, reported_at, hostname)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(username) DO UPDATE SET
         version=excluded.version,
         build=excluded.build,
         installed_at=excluded.installed_at,
         report_version=excluded.report_version,
         report_build=excluded.report_build,
         reported_at=excluded.reported_at,
         hostname=excluded.hostname`,
      [
        username,
        row.version ?? null,
        row.build ?? null,
        row.installedAt ?? null,
        row.reportVersion ?? null,
        row.reportBuild ?? null,
        row.reportedAt ?? null,
        row.hostname ?? null,
      ],
    );
  }

  /** @param {any} row */
  function insertLoginEventRow(row) {
    run(
      `INSERT OR IGNORE INTO login_events (id, created_at, username, ok, role, ip, user_agent)
       VALUES (?,?,?,?,?,?,?)`,
      [
        String(row.id || randomUUID()),
        String(row.createdAt || new Date().toISOString()),
        String(row.username || '—'),
        row.ok ? 1 : 0,
        row.role ?? null,
        row.ip ?? null,
        row.userAgent ?? null,
      ],
    );
  }

  /** @param {any} row */
  function insertReportEventRow(row) {
    const known = pickReportKnown(row);
    run(
      `INSERT OR IGNORE INTO report_events
        (id, created_at, operator_username, member_id, member_display_name, member_email,
         hostname, host_remark, plugin_version, plugin_build, ok, error, payload)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        known.id,
        known.createdAt,
        known.operatorUsername,
        known.memberId,
        known.memberDisplayName,
        known.memberEmail,
        known.hostname,
        known.hostRemark,
        known.pluginVersion,
        known.pluginBuild,
        known.ok == null ? null : known.ok ? 1 : 0,
        known.error,
        known.payload,
      ],
    );
  }

  /** @param {any} row */
  function insertApplicationRow(row) {
    if (!row?.token) return;
    run(
      `INSERT OR IGNORE INTO applications (token, username, status, created_at, updated_at)
       VALUES (?,?,?,?,?)`,
      [
        String(row.token),
        String(row.username || ''),
        String(row.status || 'pending'),
        String(row.createdAt || new Date().toISOString()),
        String(row.updatedAt || row.createdAt || new Date().toISOString()),
      ],
    );
  }

  return {
    async initSide() {
      ensure();
      await migrateLegacyIfEmpty();
    },

    async loadPluginClientsMap() {
      /** @type {Record<string, any>} */
      const map = {};
      for (const row of getAll('SELECT * FROM plugin_clients')) {
        map[String(row.username)] = pluginRowFromDb(row);
      }
      return map;
    },

    async savePluginClient(username, row) {
      await upsertPluginClientRow(username, row);
      await persist();
    },

    async deletePluginClient(username) {
      run('DELETE FROM plugin_clients WHERE username = ?', [username]);
      await persist();
    },

    async insertLoginEvent(row) {
      insertLoginEventRow(row);
      await persist();
    },

    async listLoginEvents(limit) {
      return getAll(
        'SELECT * FROM login_events ORDER BY created_at DESC LIMIT ?',
        [limit],
      ).map(loginRowFromDb);
    },

    async insertReportEvent(row) {
      insertReportEventRow(row);
      await persist();
    },

    async listReportEvents(limit) {
      return getAll(
        'SELECT * FROM report_events ORDER BY created_at DESC LIMIT ?',
        [limit],
      ).map(reportRowFromDb);
    },

    async listApplications() {
      return getAll('SELECT * FROM applications ORDER BY updated_at DESC').map(appRowFromDb);
    },

    async upsertApplication(row) {
      run(
        `INSERT INTO applications (token, username, status, created_at, updated_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(token) DO UPDATE SET
           username=excluded.username,
           status=excluded.status,
           updated_at=excluded.updated_at`,
        [row.token, row.username, row.status, row.createdAt, row.updatedAt],
      );
      await persist();
    },

    async getApplicationByToken(token) {
      const row = getOne('SELECT * FROM applications WHERE token = ?', [token]);
      return row ? appRowFromDb(row) : null;
    },

    async insertAppLog(row) {
      run(
        `INSERT INTO app_logs (id, created_at, action, line, fields_json) VALUES (?,?,?,?,?)`,
        [row.id, row.createdAt, row.action, row.line, row.fieldsJson ?? null],
      );
      await persist();
    },

    async listAppLogsForHydrate(sinceIso, limit = 2000) {
      return getAll(
        `SELECT * FROM app_logs WHERE created_at >= ? AND action IN ('上报','注册')
         ORDER BY created_at DESC LIMIT ?`,
        [sinceIso, limit],
      ).map((row) => ({
        createdAt: String(row.created_at),
        action: String(row.action),
        line: String(row.line || ''),
        fields: parseJsonObject(row.fields_json),
      }));
    },

    async pruneLoginEvents(max = LOGIN_EVENTS_MAX) {
      const keep = getAll(
        'SELECT id FROM login_events ORDER BY created_at DESC LIMIT ?',
        [max],
      ).map((r) => String(r.id));
      if (!keep.length) {
        run('DELETE FROM login_events');
      } else {
        run(
          `DELETE FROM login_events WHERE id NOT IN (${keep.map(() => '?').join(',')})`,
          keep,
        );
      }
      await persist();
    },

    async pruneReportEvents(max = REPORT_EVENTS_MAX) {
      const keep = getAll(
        'SELECT id FROM report_events ORDER BY created_at DESC LIMIT ?',
        [max],
      ).map((r) => String(r.id));
      if (!keep.length) {
        run('DELETE FROM report_events');
      } else {
        run(
          `DELETE FROM report_events WHERE id NOT IN (${keep.map(() => '?').join(',')})`,
          keep,
        );
      }
      await persist();
    },

    async pruneApplications(max = APPLICATIONS_MAX) {
      const keep = getAll(
        'SELECT token FROM applications ORDER BY updated_at DESC LIMIT ?',
        [max],
      ).map((r) => String(r.token));
      if (!keep.length) {
        run('DELETE FROM applications');
      } else {
        run(
          `DELETE FROM applications WHERE token NOT IN (${keep.map(() => '?').join(',')})`,
          keep,
        );
      }
      await persist();
    },

    async pruneAppLogsBefore(isoCutoff) {
      run('DELETE FROM app_logs WHERE created_at < ?', [isoCutoff]);
      await persist();
    },

    async pruneSwitchLogs(max = SWITCH_LOGS_MAX) {
      const keep = getAll(
        'SELECT id FROM account_switch_logs ORDER BY created_at DESC LIMIT ?',
        [max],
      ).map((r) => String(r.id));
      if (!keep.length) {
        run('DELETE FROM account_switch_logs');
      } else {
        run(
          `DELETE FROM account_switch_logs WHERE id NOT IN (${keep.map(() => '?').join(',')})`,
          keep,
        );
      }
      await persist();
    },

    async prunePresenceBefore(isoCutoff) {
      run('DELETE FROM account_presence WHERE last_seen_at < ?', [isoCutoff]);
      await persist();
    },
  };
}

/** @param {Extract<SideCtx, { kind: 'pg' }>} ctx */
function createPgApi(ctx) {
  const { query } = ctx;

  async function ensure() {
    await query(`
      CREATE TABLE IF NOT EXISTS plugin_clients (
        username TEXT PRIMARY KEY,
        version TEXT,
        build TEXT,
        installed_at TIMESTAMPTZ,
        report_version TEXT,
        report_build TEXT,
        reported_at TIMESTAMPTZ,
        hostname TEXT
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS login_events (
        id UUID PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL,
        username TEXT NOT NULL,
        ok BOOLEAN NOT NULL,
        role TEXT,
        ip TEXT,
        user_agent TEXT
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS report_events (
        id UUID PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL,
        operator_username TEXT,
        member_id TEXT,
        member_display_name TEXT,
        member_email TEXT,
        hostname TEXT,
        host_remark TEXT,
        plugin_version TEXT,
        plugin_build TEXT,
        ok BOOLEAN,
        error TEXT,
        payload JSONB
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS applications (
        token TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS app_logs (
        id UUID PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL,
        action TEXT NOT NULL,
        line TEXT NOT NULL,
        fields_json JSONB
      )
    `);
    await ensureIndexesPg(query);
  }

  async function migrateLegacyIfEmpty() {
    const { rows: pc } = await query('SELECT 1 AS x FROM plugin_clients LIMIT 1');
    if (!pc.length) {
      const map = await readLegacyJsonObject('plugin-clients.json');
      for (const [username, row] of Object.entries(map)) {
        await upsertPluginClientRow(username, row);
      }
      await renameLegacy('plugin-clients.json');
    }
    const { rows: le } = await query('SELECT 1 AS x FROM login_events LIMIT 1');
    if (!le.length) {
      for (const row of await readLegacyJsonArray('login-events.json')) {
        await insertLoginEventRow(row);
      }
      await renameLegacy('login-events.json');
    }
    const { rows: re } = await query('SELECT 1 AS x FROM report_events LIMIT 1');
    if (!re.length) {
      for (const row of await readLegacyJsonArray('report-events.json')) {
        await insertReportEventRow(row);
      }
      await renameLegacy('report-events.json');
    }
    const { rows: ap } = await query('SELECT 1 AS x FROM applications LIMIT 1');
    if (!ap.length) {
      for (const row of await readLegacyJsonArray('applications.json')) {
        await insertApplicationRow(row);
      }
      await renameLegacy('applications.json');
    }
  }

  /** @param {string} username @param {any} row */
  async function upsertPluginClientRow(username, row) {
    await query(
      `INSERT INTO plugin_clients
        (username, version, build, installed_at, report_version, report_build, reported_at, hostname)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(username) DO UPDATE SET
         version=EXCLUDED.version,
         build=EXCLUDED.build,
         installed_at=EXCLUDED.installed_at,
         report_version=EXCLUDED.report_version,
         report_build=EXCLUDED.report_build,
         reported_at=EXCLUDED.reported_at,
         hostname=EXCLUDED.hostname`,
      [
        username,
        row.version ?? null,
        row.build ?? null,
        row.installedAt ?? null,
        row.reportVersion ?? null,
        row.reportBuild ?? null,
        row.reportedAt ?? null,
        row.hostname ?? null,
      ],
    );
  }

  /** @param {any} row */
  async function insertLoginEventRow(row) {
    await query(
      `INSERT INTO login_events (id, created_at, username, ok, role, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO NOTHING`,
      [
        String(row.id || randomUUID()),
        String(row.createdAt || new Date().toISOString()),
        String(row.username || '—'),
        Boolean(row.ok),
        row.role ?? null,
        row.ip ?? null,
        row.userAgent ?? null,
      ],
    );
  }

  /** @param {any} row */
  async function insertReportEventRow(row) {
    const known = pickReportKnown(row);
    await query(
      `INSERT INTO report_events
        (id, created_at, operator_username, member_id, member_display_name, member_email,
         hostname, host_remark, plugin_version, plugin_build, ok, error, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        known.id,
        known.createdAt,
        known.operatorUsername,
        known.memberId,
        known.memberDisplayName,
        known.memberEmail,
        known.hostname,
        known.hostRemark,
        known.pluginVersion,
        known.pluginBuild,
        known.ok,
        known.error,
        known.payload || '{}',
      ],
    );
  }

  /** @param {any} row */
  async function insertApplicationRow(row) {
    if (!row?.token) return;
    await query(
      `INSERT INTO applications (token, username, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (token) DO NOTHING`,
      [
        String(row.token),
        String(row.username || ''),
        String(row.status || 'pending'),
        String(row.createdAt || new Date().toISOString()),
        String(row.updatedAt || row.createdAt || new Date().toISOString()),
      ],
    );
  }

  return {
    async initSide() {
      await ensure();
      await migrateLegacyIfEmpty();
    },

    async loadPluginClientsMap() {
      const { rows } = await query('SELECT * FROM plugin_clients');
      /** @type {Record<string, any>} */
      const map = {};
      for (const row of rows) map[String(row.username)] = pluginRowFromDb(row);
      return map;
    },

    async savePluginClient(username, row) {
      await upsertPluginClientRow(username, row);
    },

    async deletePluginClient(username) {
      await query('DELETE FROM plugin_clients WHERE username = $1', [username]);
    },

    async insertLoginEvent(row) {
      await insertLoginEventRow(row);
    },

    async listLoginEvents(limit) {
      const { rows } = await query(
        'SELECT * FROM login_events ORDER BY created_at DESC LIMIT $1',
        [limit],
      );
      return rows.map(loginRowFromDb);
    },

    async insertReportEvent(row) {
      await insertReportEventRow(row);
    },

    async listReportEvents(limit) {
      const { rows } = await query(
        'SELECT * FROM report_events ORDER BY created_at DESC LIMIT $1',
        [limit],
      );
      return rows.map(reportRowFromDb);
    },

    async listApplications() {
      const { rows } = await query('SELECT * FROM applications ORDER BY updated_at DESC');
      return rows.map(appRowFromDb);
    },

    async upsertApplication(row) {
      await query(
        `INSERT INTO applications (token, username, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT(token) DO UPDATE SET
           username=EXCLUDED.username,
           status=EXCLUDED.status,
           updated_at=EXCLUDED.updated_at`,
        [row.token, row.username, row.status, row.createdAt, row.updatedAt],
      );
    },

    async getApplicationByToken(token) {
      const { rows } = await query('SELECT * FROM applications WHERE token = $1', [token]);
      return rows[0] ? appRowFromDb(rows[0]) : null;
    },

    async insertAppLog(row) {
      await query(
        `INSERT INTO app_logs (id, created_at, action, line, fields_json)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [row.id, row.createdAt, row.action, row.line, row.fieldsJson || '{}'],
      );
    },

    async listAppLogsForHydrate(sinceIso, limit = 2000) {
      const { rows } = await query(
        `SELECT * FROM app_logs WHERE created_at >= $1 AND action = ANY($2::text[])
         ORDER BY created_at DESC LIMIT $3`,
        [sinceIso, ['上报', '注册'], limit],
      );
      return rows.map((row) => ({
        createdAt: new Date(row.created_at).toISOString(),
        action: String(row.action),
        line: String(row.line || ''),
        fields: typeof row.fields_json === 'object' ? row.fields_json : parseJsonObject(row.fields_json),
      }));
    },

    async pruneLoginEvents(max = LOGIN_EVENTS_MAX) {
      await query(
        `DELETE FROM login_events WHERE id NOT IN (
           SELECT id FROM login_events ORDER BY created_at DESC LIMIT $1
         )`,
        [max],
      );
    },

    async pruneReportEvents(max = REPORT_EVENTS_MAX) {
      await query(
        `DELETE FROM report_events WHERE id NOT IN (
           SELECT id FROM report_events ORDER BY created_at DESC LIMIT $1
         )`,
        [max],
      );
    },

    async pruneApplications(max = APPLICATIONS_MAX) {
      await query(
        `DELETE FROM applications WHERE token NOT IN (
           SELECT token FROM applications ORDER BY updated_at DESC LIMIT $1
         )`,
        [max],
      );
    },

    async pruneAppLogsBefore(isoCutoff) {
      await query('DELETE FROM app_logs WHERE created_at < $1', [isoCutoff]);
    },

    async pruneSwitchLogs(max = SWITCH_LOGS_MAX) {
      await query(
        `DELETE FROM account_switch_logs WHERE id NOT IN (
           SELECT id FROM account_switch_logs ORDER BY created_at DESC LIMIT $1
         )`,
        [max],
      );
    },

    async prunePresenceBefore(isoCutoff) {
      await query('DELETE FROM account_presence WHERE last_seen_at < $1', [isoCutoff]);
    },
  };
}

/** @param {Extract<SideCtx, { kind: 'file' }>} ctx */
function createFileApi(ctx) {
  const dataDir = ctx.dataDir || DATA_DIR;
  const paths = {
    plugin: path.join(dataDir, 'plugin-clients.json'),
    login: path.join(dataDir, 'login-events.json'),
    report: path.join(dataDir, 'report-events.json'),
    applications: path.join(dataDir, 'applications.json'),
    appLogs: path.join(dataDir, 'app-logs.json'),
    presence: path.join(dataDir, 'account-presence.json'),
    // 与 store-file 的 SWITCH_LOGS_PATH 对齐
    switchLogs: path.join(dataDir, 'switch-logs.json'),
  };

  /** @param {string} file @param {any} fallback */
  async function readJson(file, fallback) {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  /** @param {string} file @param {any} data */
  async function writeJson(file, data) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }

  return {
    async initSide() {},

    async loadPluginClientsMap() {
      const parsed = await readJson(paths.plugin, {});
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    },

    async savePluginClient(username, row) {
      const map = await this.loadPluginClientsMap();
      map[username] = row;
      await writeJson(paths.plugin, map);
    },

    async deletePluginClient(username) {
      const map = await this.loadPluginClientsMap();
      delete map[username];
      await writeJson(paths.plugin, map);
    },

    async insertLoginEvent(row) {
      const rows = await readJson(paths.login, []);
      const list = Array.isArray(rows) ? rows : [];
      list.unshift(row);
      if (list.length > LOGIN_EVENTS_MAX) list.length = LOGIN_EVENTS_MAX;
      await writeJson(paths.login, list);
    },

    async listLoginEvents(limit) {
      const rows = await readJson(paths.login, []);
      return (Array.isArray(rows) ? rows : []).slice(0, limit);
    },

    async insertReportEvent(row) {
      const rows = await readJson(paths.report, []);
      const list = Array.isArray(rows) ? rows : [];
      list.unshift(row);
      if (list.length > REPORT_EVENTS_MAX) list.length = REPORT_EVENTS_MAX;
      await writeJson(paths.report, list);
    },

    async listReportEvents(limit) {
      const rows = await readJson(paths.report, []);
      return (Array.isArray(rows) ? rows : []).slice(0, limit);
    },

    async listApplications() {
      const rows = await readJson(paths.applications, []);
      return Array.isArray(rows) ? rows : [];
    },

    async upsertApplication(row) {
      const rows = await this.listApplications();
      const idx = rows.findIndex((r) => r.token === row.token);
      if (idx >= 0) rows[idx] = row;
      else rows.unshift(row);
      if (rows.length > APPLICATIONS_MAX) rows.length = APPLICATIONS_MAX;
      await writeJson(paths.applications, rows);
    },

    async getApplicationByToken(token) {
      const rows = await this.listApplications();
      return rows.find((r) => r.token === token) || null;
    },

    async insertAppLog(row) {
      const rows = await readJson(paths.appLogs, []);
      const list = Array.isArray(rows) ? rows : [];
      list.unshift(row);
      if (list.length > 20000) list.length = 20000;
      await writeJson(paths.appLogs, list);
    },

    async listAppLogsForHydrate(sinceIso, limit = 2000) {
      const rows = await readJson(paths.appLogs, []);
      return (Array.isArray(rows) ? rows : [])
        .filter(
          (r) =>
            String(r.createdAt || '') >= sinceIso &&
            (r.action === '上报' || r.action === '注册'),
        )
        .slice(0, limit)
        .map((r) => ({
          createdAt: String(r.createdAt),
          action: String(r.action),
          line: String(r.line || ''),
          fields: r.fields || parseJsonObject(r.fieldsJson),
        }));
    },

    async pruneLoginEvents(max = LOGIN_EVENTS_MAX) {
      const rows = await readJson(paths.login, []);
      const list = Array.isArray(rows) ? rows : [];
      if (list.length > max) {
        list.length = max;
        await writeJson(paths.login, list);
      }
    },

    async pruneReportEvents(max = REPORT_EVENTS_MAX) {
      const rows = await readJson(paths.report, []);
      const list = Array.isArray(rows) ? rows : [];
      if (list.length > max) {
        list.length = max;
        await writeJson(paths.report, list);
      }
    },

    async pruneApplications(max = APPLICATIONS_MAX) {
      const rows = await this.listApplications();
      if (rows.length > max) {
        rows.length = max;
        await writeJson(paths.applications, rows);
      }
    },

    async pruneAppLogsBefore(isoCutoff) {
      const rows = await readJson(paths.appLogs, []);
      const list = (Array.isArray(rows) ? rows : []).filter(
        (r) => String(r.createdAt || '') >= isoCutoff,
      );
      await writeJson(paths.appLogs, list);
    },

    async pruneSwitchLogs(max = SWITCH_LOGS_MAX) {
      const parsed = await readJson(paths.switchLogs, { logs: [] });
      const list = Array.isArray(parsed?.logs)
        ? parsed.logs
        : Array.isArray(parsed)
          ? parsed
          : [];
      if (list.length > max) {
        list.length = max;
        await writeJson(paths.switchLogs, { logs: list });
      }
    },

    async prunePresenceBefore(isoCutoff) {
      const map = await readJson(paths.presence, {});
      if (!map || typeof map !== 'object') return;
      for (const [key, row] of Object.entries(map)) {
        if (String(row?.lastSeenAt || '') < isoCutoff) delete map[key];
      }
      await writeJson(paths.presence, map);
    },
  };
}

/** @param {(sql: string) => void} run */
function ensureIndexes(run) {
  run(`CREATE INDEX IF NOT EXISTS idx_login_events_created ON login_events (created_at DESC)`);
  run(`CREATE INDEX IF NOT EXISTS idx_report_events_created ON report_events (created_at DESC)`);
  run(
    `CREATE INDEX IF NOT EXISTS idx_report_events_member_created ON report_events (member_id, created_at DESC)`,
  );
  run(
    `CREATE INDEX IF NOT EXISTS idx_applications_user_updated ON applications (username, updated_at DESC)`,
  );
  run(`CREATE INDEX IF NOT EXISTS idx_app_logs_created ON app_logs (created_at DESC)`);
  run(
    `CREATE INDEX IF NOT EXISTS idx_app_logs_action_created ON app_logs (action, created_at DESC)`,
  );
  run(
    `CREATE INDEX IF NOT EXISTS idx_account_presence_member ON account_presence (member_id)`,
  );
  run(
    `CREATE INDEX IF NOT EXISTS idx_account_presence_seen ON account_presence (last_seen_at)`,
  );
  run(
    `CREATE INDEX IF NOT EXISTS idx_switch_logs_created ON account_switch_logs (created_at DESC)`,
  );
  run(
    `CREATE INDEX IF NOT EXISTS idx_switch_logs_operator ON account_switch_logs (operator_username, created_at DESC)`,
  );
  run(
    `CREATE INDEX IF NOT EXISTS idx_switch_logs_member ON account_switch_logs (member_id, created_at DESC)`,
  );
  run(`CREATE INDEX IF NOT EXISTS idx_members_updated ON members (updated_at)`);
}

/** @param {(sql: string) => Promise<any>} query */
async function ensureIndexesPg(query) {
  await query(`CREATE INDEX IF NOT EXISTS idx_login_events_created ON login_events (created_at DESC)`);
  await query(
    `CREATE INDEX IF NOT EXISTS idx_report_events_created ON report_events (created_at DESC)`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS idx_report_events_member_created ON report_events (member_id, created_at DESC)`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS idx_applications_user_updated ON applications (username, updated_at DESC)`,
  );
  await query(`CREATE INDEX IF NOT EXISTS idx_app_logs_created ON app_logs (created_at DESC)`);
  await query(
    `CREATE INDEX IF NOT EXISTS idx_app_logs_action_created ON app_logs (action, created_at DESC)`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS idx_account_presence_member ON account_presence (member_id)`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS idx_account_presence_seen ON account_presence (last_seen_at)`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS idx_switch_logs_created ON account_switch_logs (created_at DESC)`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS idx_switch_logs_operator ON account_switch_logs (operator_username, created_at DESC)`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS idx_switch_logs_member ON account_switch_logs (member_id, created_at DESC)`,
  );
  await query(`CREATE INDEX IF NOT EXISTS idx_members_updated ON members (updated_at)`);
}

/** @param {string} name */
async function readLegacyJsonObject(name) {
  try {
    const parsed = JSON.parse(await readFile(path.join(DATA_DIR, name), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** @param {string} name */
async function readLegacyJsonArray(name) {
  try {
    const parsed = JSON.parse(await readFile(path.join(DATA_DIR, name), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** @param {string} name */
async function renameLegacy(name) {
  const file = path.join(DATA_DIR, name);
  try {
    await rename(file, `${file}.migrated`);
  } catch {
    /* 无文件或已迁过 */
  }
}

/** @param {any} row */
function pluginRowFromDb(row) {
  return {
    version: row.version ?? null,
    build: row.build ?? null,
    installedAt: toIso(row.installed_at),
    reportVersion: row.report_version ?? null,
    reportBuild: row.report_build ?? null,
    reportedAt: toIso(row.reported_at),
    hostname: row.hostname ?? null,
  };
}

/** @param {any} row */
function loginRowFromDb(row) {
  return {
    id: String(row.id),
    username: String(row.username),
    ok: Boolean(row.ok),
    role: row.role ?? null,
    ip: row.ip ?? null,
    userAgent: row.user_agent ?? null,
    createdAt: toIso(row.created_at) || new Date().toISOString(),
  };
}

/** @param {any} row */
function reportRowFromDb(row) {
  const payload = typeof row.payload === 'object' ? row.payload : parseJsonObject(row.payload);
  return {
    id: String(row.id),
    createdAt: toIso(row.created_at) || new Date().toISOString(),
    operatorUsername: row.operator_username ?? null,
    memberId: row.member_id ?? null,
    memberDisplayName: row.member_display_name ?? null,
    memberEmail: row.member_email ?? null,
    hostname: row.hostname ?? null,
    hostRemark: row.host_remark ?? null,
    pluginVersion: row.plugin_version ?? null,
    pluginBuild: row.plugin_build ?? null,
    ok: row.ok == null ? null : Boolean(row.ok),
    error: row.error ?? null,
    ...payload,
  };
}

/** @param {any} row */
function appRowFromDb(row) {
  return {
    token: String(row.token),
    username: String(row.username),
    status: String(row.status),
    createdAt: toIso(row.created_at) || new Date().toISOString(),
    updatedAt: toIso(row.updated_at) || new Date().toISOString(),
  };
}

/** @param {any} input */
function pickReportKnown(input) {
  const {
    id,
    createdAt,
    operatorUsername,
    memberId,
    memberDisplayName,
    memberEmail,
    hostname,
    hostRemark,
    pluginVersion,
    pluginBuild,
    ok,
    error,
    ...rest
  } = input || {};
  return {
    id: String(id || randomUUID()),
    createdAt: String(createdAt || new Date().toISOString()),
    operatorUsername: operatorUsername != null ? String(operatorUsername) : null,
    memberId: memberId != null ? String(memberId) : null,
    memberDisplayName: memberDisplayName != null ? String(memberDisplayName) : null,
    memberEmail: memberEmail != null ? String(memberEmail) : null,
    hostname: hostname != null ? String(hostname) : null,
    hostRemark: hostRemark != null ? String(hostRemark) : null,
    pluginVersion: pluginVersion != null ? String(pluginVersion) : null,
    pluginBuild: pluginBuild != null ? String(pluginBuild) : null,
    ok: ok == null ? null : Boolean(ok),
    error: error != null ? String(error) : null,
    payload: Object.keys(rest).length ? JSON.stringify(rest) : null,
  };
}

/** @param {unknown} raw */
function parseJsonObject(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return /** @type {Record<string, unknown>} */ (raw);
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** @param {unknown} v */
function toIso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : s;
}

/**
 * 构造一条应用日志行（供 writeAppLog 落库）。
 * @param {string} action
 * @param {Record<string, unknown>} fields
 * @param {string} line
 */
export function buildAppLogRow(action, fields, line) {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    action: String(action || ''),
    line: String(line || ''),
    fieldsJson: JSON.stringify(fields || {}),
    fields,
  };
}

/** 生成注册申请 token。 */
export function newApplicationToken() {
  return randomBytes(24).toString('base64url');
}

/**
 * 尝试导入旧按日文本日志里的上报行到 app_logs（仅当库中尚无 app_logs 时由调用方决定）。
 * 这里只提供读文本解析，真正写入由 api.insertAppLog。
 * @param {number} [retentionDays]
 */
export async function readLegacyTextLogLines(retentionDays = 7) {
  const logDir = path.join(DATA_DIR, 'log');
  let names = [];
  try {
    names = await readdir(logDir);
  } catch {
    return [];
  }
  const cutoff = Date.now() - retentionDays * 86400000;
  /** @type {Array<{ createdAt: string, action: string, line: string, fields: Record<string, unknown> }>} */
  const out = [];
  for (const name of names.sort().reverse()) {
    if (!/^\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
    let text = '';
    try {
      text = await readFile(path.join(logDir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      const time = line.match(/^\[([^\]]+)\]/)?.[1];
      const action = line.match(/\]\s*\[([^\]]+)\]/)?.[1];
      if (!time || !action) continue;
      const createdAt = new Date(time.replace(' ', 'T')).toISOString();
      if (Date.parse(createdAt) < cutoff) continue;
      out.push({ createdAt, action, line, fields: {} });
    }
  }
  return out;
}
