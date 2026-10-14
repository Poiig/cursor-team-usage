/** 每个看板用户最近一次安装 / 上报的插件版本。落存储驱动。 */

import {
  deletePluginClient,
  loadPluginClientsMap,
  savePluginClient,
} from './store.js';

/** @param {unknown} value @param {number} max */
function cleanToken(value, max) {
  const text = String(value || '').trim();
  if (!text || text.length > max) return '';
  return /^[\w.+-]+$/.test(text) ? text : '';
}

/**
 * 展示用：安装时间更新的用安装版本，上报时间更新的用正在跑的版本。
 * @param {any} row
 */
export function pluginClientView(row) {
  if (!row) return null;
  const reportNewer =
    row.reportedAt && (!row.installedAt || String(row.reportedAt) >= String(row.installedAt));
  const version = reportNewer ? row.reportVersion || row.version : row.version || row.reportVersion;
  const build = reportNewer ? row.reportBuild || row.build : row.build || row.reportBuild;
  if (!version) return null;
  return {
    version,
    build: build || null,
    installedAt: row.installedAt || null,
    reportedAt: row.reportedAt || null,
    hostname: row.hostname || null,
    state: row.reportedAt ? 'reported' : 'installed',
  };
}

/**
 * 个性化安装包被下载时记下版本。版本以服务端实际下发的为准。
 * @param {string} username
 * @param {{ version?: string, build?: string }} info
 */
export async function recordPluginInstall(username, info) {
  const name = String(username || '').trim();
  const version = cleanToken(info?.version, 40);
  if (!name || !version) return null;
  const rows = await loadPluginClientsMap();
  const prev = rows[name] || {};
  const next = {
    ...prev,
    version,
    build: cleanToken(info?.build, 64) || null,
    installedAt: new Date().toISOString(),
  };
  await savePluginClient(name, next);
  return pluginClientView(next);
}

/**
 * 签名通过的上报（含首次注册账号）更新正在使用的版本。
 * @param {string} username
 * @param {{ version?: string, build?: string, hostname?: string }} info
 */
export async function recordPluginReport(username, info) {
  const name = String(username || '').trim();
  if (!name) return null;
  const rows = await loadPluginClientsMap();
  const prev = rows[name] || {};
  const version = cleanToken(info?.version, 40) || prev.reportVersion || prev.version || '';
  if (!version) return null;
  const hostname = String(info?.hostname || '')
    .replace(/[\r\n]/g, '')
    .trim()
    .slice(0, 80);
  const next = {
    ...prev,
    reportVersion: version,
    reportBuild: cleanToken(info?.build, 64) || prev.reportBuild || null,
    reportedAt: new Date().toISOString(),
    hostname: hostname || prev.hostname || null,
  };
  await savePluginClient(name, next);
  return pluginClientView(next);
}

export async function listPluginClientViews() {
  const rows = await loadPluginClientsMap();
  /** @type {Record<string, ReturnType<typeof pluginClientView>>} */
  const out = {};
  for (const [name, row] of Object.entries(rows)) {
    const view = pluginClientView(row);
    if (view) out[name] = view;
  }
  return out;
}

/** @param {string} username */
export async function forgetPluginClient(username) {
  const name = String(username || '').trim();
  if (!name) return;
  await deletePluginClient(name);
}
