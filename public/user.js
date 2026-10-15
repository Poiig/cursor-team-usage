/**
 * 人员详情：注册/上报时间、当前席位、号池账号、切换与上报记录。
 * 全员可读；管理员可移出席位 / 删除号池账号（不回收授权）。
 */

import { api, createToast, escapeHtml, formatDateTime, formatOperatorLabel } from './shared.js';

const params = new URLSearchParams(location.search);
const username = String(params.get('u') || params.get('username') || '').trim();
const toast = createToast(document.getElementById('toast'));

const els = {
  title: document.getElementById('personTitle'),
  sub: document.getElementById('personSub'),
  meta: document.getElementById('personMeta'),
  facts: document.getElementById('personFacts'),
  accounts: document.getElementById('personAccounts'),
  poolMembers: document.getElementById('personPoolMembers'),
  switchBody: document.getElementById('personSwitchBody'),
  reportBody: document.getElementById('personReportBody'),
};

/** @type {{ username: string, role: string } | null} */
let me = null;
/** @type {any} */
let personData = null;

function isAdmin() {
  return me?.role === 'admin';
}

function emptyRow(cols, text) {
  return `<tr><td colspan="${cols}" class="muted">${escapeHtml(text)}</td></tr>`;
}

function statusBadge(ok, label) {
  if (ok == null && !label) return '<span class="muted">—</span>';
  const text = label || (ok ? '成功' : '失败');
  const cls = ok === true ? 'ok' : ok === false ? 'danger' : 'warn';
  return `<span class="badge ${cls}">${escapeHtml(text)}</span>`;
}

function renderAccounts() {
  const accounts = personData?.accounts || [];
  const admin = isAdmin();
  if (!accounts.length) {
    els.accounts.innerHTML = '<p class="muted">当前未占用任何账号席位</p>';
    return;
  }
  els.accounts.innerHTML = `<ul class="person-account-list">${accounts
    .map((row) => {
      const memberLabel = row.memberDisplayName || row.memberId || '未知账号';
      const host = row.hostname || '—';
      const seen = formatDateTime(row.lastSeenAt) || '—';
      const href = row.memberId
        ? `/detail.html?id=${encodeURIComponent(row.memberId)}`
        : '';
      const nameHtml = href
        ? `<a href="${href}">${escapeHtml(memberLabel)}</a>`
        : escapeHtml(memberLabel);
      const removeBtn =
        admin && row.memberId && row.hostname
          ? `<button type="button" class="btn sm" data-person-action="remove-seat" data-member-id="${escapeHtml(row.memberId)}" data-hostname="${escapeHtml(row.hostname)}">移出席位</button>`
          : '';
      return `<li class="person-account-row">
        <div>${nameHtml}<span class="muted"> · ${escapeHtml(host)} · ${escapeHtml(seen)}</span></div>
        ${removeBtn}
      </li>`;
    })
    .join('')}</ul>`;
}

function renderPoolMembers() {
  const pool = personData?.poolMembers || [];
  const admin = isAdmin();
  if (!pool.length) {
    els.poolMembers.innerHTML = '<p class="muted">没有与别名同名的号池账号</p>';
    return;
  }
  els.poolMembers.innerHTML = `<ul class="person-account-list">${pool
    .map((m) => {
      const href = `/detail.html?id=${encodeURIComponent(m.id)}`;
      const meta = [m.email, m.hostname, m.planName].filter(Boolean).join(' · ') || '—';
      const delBtn = admin
        ? `<button type="button" class="btn sm danger" data-person-action="delete-pool" data-member-id="${escapeHtml(m.id)}" data-member-name="${escapeHtml(m.displayName || '')}">从号池删除</button>`
        : '';
      return `<li class="person-account-row">
        <div><a href="${href}">${escapeHtml(m.displayName || m.id)}</a><span class="muted"> · ${escapeHtml(meta)}</span></div>
        ${delBtn}
      </li>`;
    })
    .join('')}</ul>`;
}

async function load() {
  if (!username) {
    els.title.textContent = '人员详情';
    els.sub.textContent = '缺少用户名参数';
    return;
  }

  const [meRes, data] = await Promise.all([
    api('/api/auth/me'),
    api(`/api/people/${encodeURIComponent(username)}`),
  ]);
  me = { username: meRes.username || '—', role: meRes.role || 'user' };
  personData = data;

  const user = data.user;
  const alias = user?.alias || '';
  const title = formatOperatorLabel(data.username, alias);
  document.title = `${title} · 人员详情`;
  els.title.textContent = title;
  els.sub.textContent = alias && alias !== data.username ? data.username : '';

  const roleLabel =
    user?.role === 'admin' ? '管理员' : user ? '普通用户' : '未注册看板账号';
  const status = !user
    ? '仅有活动记录'
    : user.pending
      ? '待审批'
      : user.disabled
        ? '已禁用'
        : '正常';
  els.meta.innerHTML = `
    <span class="badge plan">${escapeHtml(roleLabel)}</span>
    <span class="badge ${user?.disabled || user?.pending ? 'warn' : 'ok'}">${escapeHtml(status)}</span>
  `;

  const plugin = data.plugin;
  const pluginOnlineHtml = !plugin?.version
    ? '—'
    : plugin.online === true
      ? '<span class="plugin-presence online">在线</span>'
      : '<span class="plugin-presence offline">离线</span>';
  const facts = [
    ['用户名', data.username],
    ['别名', alias || '—'],
    ['注册时间', formatDateTime(user?.createdAt) || (user ? '—' : '无看板账号')],
    ['插件状态', pluginOnlineHtml],
    ['最近上报', formatDateTime(plugin?.reportedAt) || '—'],
    ['插件安装', formatDateTime(plugin?.installedAt) || '—'],
    [
      '插件版本',
      plugin?.version
        ? [plugin.version, plugin.build].filter(Boolean).join(' · ')
        : '—',
    ],
    ['上报主机', plugin?.hostname || '—'],
  ];
  els.facts.innerHTML = facts
    .map(
      ([k, v]) =>
        `<div class="person-fact"><span class="label">${escapeHtml(k)}</span><span class="value">${
          k === '插件状态' ? v : escapeHtml(String(v))
        }</span></div>`,
    )
    .join('');

  renderAccounts();
  renderPoolMembers();

  const switches = data.switches || [];
  els.switchBody.innerHTML = switches.length
    ? switches
        .map((log) => {
          const member = log.memberDisplayName || log.memberEmail || log.memberId || '—';
          const memberHtml = log.memberId
            ? `<a href="/detail.html?id=${encodeURIComponent(log.memberId)}">${escapeHtml(member)}</a>`
            : escapeHtml(member);
          return `<tr>
            <td>${escapeHtml(formatDateTime(log.createdAt) || log.createdAt || '—')}</td>
            <td>${memberHtml}</td>
            <td>${escapeHtml(log.hostname || '—')}</td>
            <td>${statusBadge(
              log.status === 'success' ? true : log.status === 'failed' ? false : null,
              log.status || '—',
            )}${log.error ? ` <span class="muted">${escapeHtml(log.error)}</span>` : ''}</td>
          </tr>`;
        })
        .join('')
    : emptyRow(4, '暂无切换记录');

  document.getElementById('personReportCard')?.classList.toggle('hidden', !data.reports);
  const reports = data.reports || [];
  els.reportBody.innerHTML = reports.length
    ? reports
        .map((log) => {
          const member = log.memberDisplayName || log.memberEmail || log.memberId || '—';
          const memberHtml = log.memberId
            ? `<a href="/detail.html?id=${encodeURIComponent(log.memberId)}">${escapeHtml(member)}</a>`
            : escapeHtml(member);
          const pluginText =
            [log.pluginVersion, log.pluginBuild].filter(Boolean).join(' · ') || '—';
          const host = [log.hostname, log.hostRemark].filter(Boolean).join(' / ') || '—';
          return `<tr>
            <td>${escapeHtml(formatDateTime(log.createdAt) || log.createdAt || '—')}</td>
            <td>${memberHtml}</td>
            <td>${escapeHtml(host)}</td>
            <td>${escapeHtml(pluginText)}</td>
            <td>${statusBadge(log.ok)}${
              log.error ? ` <span class="muted">${escapeHtml(log.error)}</span>` : ''
            }</td>
          </tr>`;
        })
        .join('')
    : emptyRow(5, '暂无上报记录');
}

document.getElementById('personRoot')?.addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-person-action]');
  if (!btn || !isAdmin()) return;
  const action = btn.dataset.personAction;

  if (action === 'remove-seat') {
    const memberId = String(btn.dataset.memberId || '').trim();
    const hostname = String(btn.dataset.hostname || '').trim();
    if (!memberId || !hostname) return;
    if (!confirm(`确定从该账号移出主机「${hostname}」的席位？\n仅改看板记录，不会回收 Cursor 登录。`)) {
      return;
    }
    btn.disabled = true;
    try {
      await api(
        `/api/members/${encodeURIComponent(memberId)}/presence?hostname=${encodeURIComponent(hostname)}`,
        { method: 'DELETE' },
      );
      toast('已移出席位');
      await load();
    } catch (e) {
      toast(e.message || String(e));
      btn.disabled = false;
    }
    return;
  }

  if (action === 'delete-pool') {
    const memberId = String(btn.dataset.memberId || '').trim();
    const memberName = String(btn.dataset.memberName || memberId).trim();
    if (!memberId) return;
    if (
      !confirm(
        `确定从号池删除账号「${memberName}」？\n只删看板号池与席位，不影响 Cursor 本机登录与订阅。`,
      )
    ) {
      return;
    }
    btn.disabled = true;
    try {
      await api(`/api/members/${encodeURIComponent(memberId)}`, { method: 'DELETE' });
      toast('已从号池删除');
      await load();
    } catch (e) {
      toast(e.message || String(e));
      btn.disabled = false;
    }
  }
});

load().catch((e) => {
  els.title.textContent = '人员详情';
  els.sub.textContent = e.message || String(e);
  toast(e.message || String(e));
});
