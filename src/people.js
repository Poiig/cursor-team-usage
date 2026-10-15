/**
 * 人员详情：聚合控制台用户、插件、当前席位、切换与上报记录。
 * 供全员只读详情页，不走 /api/users 管理接口。
 */

import { listAccountSwitchLogs } from './account-switch.js';
import { listPresenceByUsername } from './account-presence.js';
import { listPluginClientViews } from './plugin-clients.js';
import { listReportEvents } from './report-log.js';
import { listMembers } from './store.js';
import { getPublicUser, normalizeUsername } from './users.js';

/**
 * 别名与号池显示名相同的账号（如人在用别人号时，名下仍留着的「自己的号」）。
 * @param {{ alias?: string } | null} user
 * @param {any[]} members
 */
export function relatedPoolMembersForPerson(user, members) {
  const alias = String(user?.alias || '').trim();
  if (!alias) return [];
  return (members || [])
    .filter((m) => String(m.displayName || '').trim() === alias)
    .map((m) => ({
      id: m.id,
      displayName: m.displayName,
      email: m.email || null,
      hostname: m.hostname || null,
      planName: m.planName || null,
    }));
}

/**
 * @param {string} username
 * @param {{ switchLimit?: number, reportLimit?: number }} [opts]
 */
export async function getPersonDetail(username, opts = {}) {
  const name = normalizeUsername(username);
  if (!name) {
    const err = new Error('缺少用户名');
    err.status = 400;
    throw err;
  }

  const switchLimit = Math.min(200, Math.max(1, Number(opts.switchLimit) || 80));
  const reportLimit = Math.min(200, Math.max(1, Number(opts.reportLimit) || 80));

  const [user, plugins, presenceMap, switchLogs, reportLogs, members] = await Promise.all([
    getPublicUser(name),
    listPluginClientViews(),
    listPresenceByUsername(),
    listAccountSwitchLogs({ limit: 500 }),
    listReportEvents(500),
    listMembers(),
  ]);

  const accounts = presenceMap[name] || [];
  const switches = (switchLogs || [])
    .filter((row) => String(row.operatorUsername || '') === name)
    .slice(0, switchLimit);
  const reports = (reportLogs || [])
    .filter((row) => String(row.operatorUsername || '') === name)
    .slice(0, reportLimit);
  const plugin = plugins[name] || null;
  const poolMembers = relatedPoolMembersForPerson(user, members);

  if (
    !user &&
    !accounts.length &&
    !switches.length &&
    !reports.length &&
    !plugin &&
    !poolMembers.length
  ) {
    const err = new Error('人员不存在');
    err.status = 404;
    throw err;
  }

  return {
    username: name,
    user,
    plugin,
    accounts,
    poolMembers,
    switches,
    reports,
  };
}
