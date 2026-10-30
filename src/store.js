/**
 * 存储门面：默认本地 SQLite；可切 postgres；file 为遗留 JSON。
 * 控制台账号与名册走同一驱动，避免密码与成员分属两套文件。
 */

import { getStoreDriver } from './config.js';

/** @type {any} */
let backend = null;

/** 启动时调用一次：选驱动并建表 / 打开库。 */
export async function initStore() {
  const driver = getStoreDriver();
  if (driver === 'postgres') {
    backend = await import('./store-pg.js');
  } else if (driver === 'file') {
    backend = await import('./store-file.js');
  } else {
    backend = await import('./store-sqlite.js');
  }
  await backend.init();
  return driver;
}

function api() {
  if (!backend) throw new Error('存储尚未初始化，请先 await initStore()');
  return backend;
}

/** @param {any} m */
export function toPublicMember(m) {
  return api().toPublicMember(m);
}

export async function listMembers() {
  return api().listMembers();
}

/** @param {{ displayName: string, sessionToken: string }} input */
export async function addMember(input) {
  return api().addMember(input);
}

/**
 * @param {string} id
 * @param {{ displayName?: string, sessionToken?: string }} patch
 */
export async function updateMember(id, patch) {
  return api().updateMember(id, patch);
}

/**
 * @param {{ displayName?: string, sessionToken: string, email?: string }} input
 */
export async function upsertMemberBySession(input) {
  return api().upsertMemberBySession(input);
}

/** 上报写入后刷新仍鉴权失败时，还原上一份会话。 */
export async function rollbackMemberSession(id) {
  return api().rollbackMemberSession(id);
}

/** @param {string} id */
export async function deleteMember(id) {
  return api().deleteMember(id);
}

/** @param {string} id */
export async function getMemberInternal(id) {
  return api().getMemberInternal(id);
}

/** @param {string} userId */
export async function findMemberByUserId(userId) {
  return api().findMemberByUserId(userId);
}

export async function getAllMembersInternal() {
  return api().getAllMembersInternal();
}

/**
 * @param {string} id
 * @param {{ snapshot?: object | null, error?: string | null, transient?: boolean }} result
 */
export async function saveSyncResult(id, result) {
  return api().saveSyncResult(id, result);
}

/**
 * @param {string} id
 * @param {Array<{ date: string, total?: number | null, auto?: number | null, api?: number | null }>} history
 */
export async function setUsagePercentHistory(id, history) {
  return api().setUsagePercentHistory(id, history);
}

/**
 * @param {string} id
 * @param {object} summary
 */
export async function setPrevCycleSummary(id, summary) {
  return api().setPrevCycleSummary(id, summary);
}

export async function listConsoleUsers() {
  return api().listConsoleUsers();
}

/** @param {string} username */
export async function getConsoleUser(username) {
  return api().getConsoleUser(username);
}

/** @param {any} user */
export async function createConsoleUser(user) {
  return api().createConsoleUser(user);
}

/** @param {any} user */
export async function saveConsoleUser(user) {
  return api().saveConsoleUser(user);
}

/** @param {string} username */
export async function deleteConsoleUser(username) {
  return api().deleteConsoleUser(username);
}

/** @param {any} log */
export async function insertSwitchLog(log) {
  return api().insertSwitchLog(log);
}

/**
 * @param {string} id
 * @param {any} patch
 */
export async function updateSwitchLog(id, patch) {
  return api().updateSwitchLog(id, patch);
}

/** @param {{ limit?: number }} [opts] */
export async function listSwitchLogs(opts) {
  return api().listSwitchLogs(opts);
}

/** @param {string} id */
export async function getSwitchLog(id) {
  return api().getSwitchLog(id);
}

/**
 * @param {string} memberId
 * @param {any[]} events
 */
export async function upsertUsageEvents(memberId, events) {
  return api().upsertUsageEvents(memberId, events);
}

/** @param {string} memberId */
export async function getUsageEventsWatermark(memberId) {
  return api().getUsageEventsWatermark(memberId);
}

/** @param {string} memberId */
export async function getUsageEventsMeta(memberId) {
  return api().getUsageEventsMeta(memberId);
}

/**
 * @param {string} memberId
 * @param {{ days?: number, model?: string, page?: number, pageSize?: number, nowMs?: number }} [opts]
 */
export async function listUsageEvents(memberId, opts) {
  return api().listUsageEvents(memberId, opts);
}

/** @param {string} memberId @param {number} startMs @param {number} endMs */
export async function listUsageEventsInRange(memberId, startMs, endMs) {
  return api().listUsageEventsInRange(memberId, startMs, endMs);
}

/** 账号使用人席位（按主机）。 */
export async function loadAccountPresenceMap() {
  return api().loadAccountPresenceMap();
}

/** @param {Record<string, any>} map */
export async function saveAccountPresenceMap(map) {
  return api().saveAccountPresenceMap(map);
}

export async function loadPluginClientsMap() {
  return api().loadPluginClientsMap();
}

/** @param {string} username @param {any} row */
export async function savePluginClient(username, row) {
  return api().savePluginClient(username, row);
}

/** @param {string} username */
export async function deletePluginClient(username) {
  return api().deletePluginClient(username);
}

/** @param {any} row */
export async function insertLoginEvent(row) {
  return api().insertLoginEvent(row);
}

/** @param {number} limit */
export async function listStoredLoginEvents(limit) {
  return api().listLoginEvents(limit);
}

/** @param {any} row */
export async function insertReportEvent(row) {
  return api().insertReportEvent(row);
}

/** @param {number} limit */
export async function listStoredReportEvents(limit) {
  return api().listReportEvents(limit);
}

export async function listStoredApplications() {
  return api().listApplications();
}

/** @param {any} row */
export async function upsertApplication(row) {
  return api().upsertApplication(row);
}

/** @param {string} token */
export async function getApplicationByToken(token) {
  return api().getApplicationByToken(token);
}

/** @param {any} row */
export async function insertAppLog(row) {
  return api().insertAppLog(row);
}

/** @param {string} sinceIso @param {number} [limit] */
export async function listAppLogsForHydrate(sinceIso, limit) {
  return api().listAppLogsForHydrate(sinceIso, limit);
}

/** @param {number} [max] */
export async function pruneLoginEvents(max) {
  return api().pruneLoginEvents(max);
}

/** @param {number} [max] */
export async function pruneReportEvents(max) {
  return api().pruneReportEvents(max);
}

/** @param {number} [max] */
export async function pruneApplications(max) {
  return api().pruneApplications(max);
}

/** @param {string} isoCutoff */
export async function pruneAppLogsBefore(isoCutoff) {
  return api().pruneAppLogsBefore(isoCutoff);
}

/** @param {number} [max] */
export async function pruneSwitchLogs(max) {
  return api().pruneSwitchLogs(max);
}

/** @param {string} isoCutoff */
export async function prunePresenceBefore(isoCutoff) {
  return api().prunePresenceBefore(isoCutoff);
}

/**
 * 上报/切换后清理过期 presence 与超额审计行，控制表体积。
 * @param {{ appLogRetentionDays?: number }} [opts]
 */
export async function pruneOperationalData(opts = {}) {
  const {
    LOGIN_EVENTS_MAX,
    REPORT_EVENTS_MAX,
    APPLICATIONS_MAX,
    SWITCH_LOGS_MAX,
    PRESENCE_KEEP_MS,
  } = await import('./store-side-data.js');
  const cutoff = new Date(Date.now() - PRESENCE_KEEP_MS).toISOString();
  await prunePresenceBefore(cutoff);
  await pruneLoginEvents(LOGIN_EVENTS_MAX);
  await pruneReportEvents(REPORT_EVENTS_MAX);
  await pruneApplications(APPLICATIONS_MAX);
  await pruneSwitchLogs(SWITCH_LOGS_MAX);
  const days = Number(opts.appLogRetentionDays);
  if (Number.isFinite(days) && days > 0) {
    const logCutoff = new Date();
    logCutoff.setHours(0, 0, 0, 0);
    logCutoff.setDate(logCutoff.getDate() - days);
    await pruneAppLogsBefore(logCutoff.toISOString());
  }
}
