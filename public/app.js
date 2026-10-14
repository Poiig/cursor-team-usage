/**
 * 多账号列表：紧凑卡片、隐私模式、导出；详情跳转独立页面。
 */

import {
  accountIdentity,
  api,
  computeUsagePace,
  createToast,
  daysUntil,
  deltaVsYesterday,
  downloadText,
  escapeHtml,
  fieldForProgressLabel,
  formatDateTimeDot,
  formatDeltaVsYesterday,
  formatPlanLabel,
  formatSpendPart,
  formatTokens,
  loadSettings,
  money,
  planBadgeClass,
  resolveSpendRow,
  saveSettings,
  setBusy,
} from './shared.js';

const els = {
  summary: document.getElementById('summary'),
  list: document.getElementById('memberList'),
  empty: document.getElementById('emptyState'),
  dialog: document.getElementById('memberDialog'),
  forcePasswordDialog: document.getElementById('forcePasswordDialog'),
  displayName: document.getElementById('fieldDisplayName'),
  sessionToken: document.getElementById('fieldSessionToken'),
  dialogTitle: document.getElementById('dialogTitle'),
  toast: document.getElementById('toast'),
  searchInput: document.getElementById('searchInput'),
  sortBy: document.getElementById('sortBy'),
  privacyMode: document.getElementById('privacyMode'),
  currentUsername: document.getElementById('currentUsername'),
  forceNewPassword: document.getElementById('forceNewPassword'),
  forceNewPassword2: document.getElementById('forceNewPassword2'),
  forcePasswordError: document.getElementById('forcePasswordError'),
  tabAccounts: document.getElementById('tabAccounts'),
  tabSwitches: document.getElementById('tabSwitches'),
  tabReports: document.getElementById('tabReports'),
  tabUsers: document.getElementById('tabUsers'),
  tabHelp: document.getElementById('tabHelp'),
  btnAdd: document.getElementById('btnAdd'),
  btnEmptyAdd: document.getElementById('btnEmptyAdd'),
  btnImportInDialog: document.getElementById('btnImportInDialog'),
  btnRefreshAll: document.getElementById('btnRefreshAll'),
  btnRestoreLocal: document.getElementById('btnRestoreLocal'),
  btnSwitchRecommended: document.getElementById('btnSwitchRecommended'),
  btnExport: document.getElementById('btnExport'),
  btnForceChangePassword: document.getElementById('btnForceChangePassword'),
  btnLogout: document.getElementById('btnLogout'),
  btnHelp: document.getElementById('btnHelp'),
  btnSaveMember: document.getElementById('btnSaveMember'),
  btnDialogClose: document.getElementById('btnDialogClose'),
  btnDialogCancel: document.getElementById('btnDialogCancel'),
  todayRankDialog: document.getElementById('todayRankDialog'),
  todayRankBody: document.getElementById('todayRankBody'),
  btnTodayRankClose: document.getElementById('btnTodayRankClose'),
  btnTodayRankCancel: document.getElementById('btnTodayRankCancel'),
  switchLogBody: document.getElementById('switchLogBody'),
  btnRefreshSwitchLogs: document.getElementById('btnRefreshSwitchLogs'),
  reportOperatorBody: document.getElementById('reportOperatorBody'),
  reportRecentBody: document.getElementById('reportRecentBody'),
  reportLogBody: document.getElementById('reportLogBody'),
  btnRefreshReports: document.getElementById('btnRefreshReports'),
  statusFilter: document.getElementById('statusFilter'),
  userTableBody: document.getElementById('userTableBody'),
  loginLogBody: document.getElementById('loginLogBody'),
  userDialog: document.getElementById('userDialog'),
  userDialogTitle: document.getElementById('userDialogTitle'),
  fieldUsername: document.getElementById('fieldUsername'),
  fieldUserPassword: document.getElementById('fieldUserPassword'),
  fieldUserRole: document.getElementById('fieldUserRole'),
  btnAddUser: document.getElementById('btnAddUser'),
  btnInstallExtension: document.getElementById('btnInstallExtension'),
  btnSaveUser: document.getElementById('btnSaveUser'),
  btnUserDialogClose: document.getElementById('btnUserDialogClose'),
  btnUserDialogCancel: document.getElementById('btnUserDialogCancel'),
};

const toast = createToast(els.toast);

/** @type {object[]} */
let membersCache = [];
/** @type {object | null} */
let summaryCache = null;
/** @type {{ id?: string } | null} */
let editing = null;
let refreshingAll = false;
let settings = loadSettings();
let forcePasswordRequired = false;
/** @type {{ username: string, role: string } | null} */
let currentUser = null;
/** @type {object[]} */
let switchLogsCache = [];
/** @type {object[]} */
let usersCache = [];
let recommendedSwitchId = null;
let currentCursorMemberId = null;
let currentCursorChecked = false;
let extensionMeta = null;
let localExtensionInfo = null;
let extensionInstallMode = 'install';
/** @type {'all' | 'ok' | 'expiring' | 'error'} */
let accountStatusFilter = 'all';

/** 额度重置日临期阈值：剩余天数 ≤ 此值（含已到期）算「临期」。 */
const EXPIRING_WITHIN_DAYS = 7;

function isAdmin() {
  return currentUser?.role === 'admin';
}

/** 有 lastError 的账号视为异常，不可切换。 */
function isAbnormalMember(member) {
  return Boolean(member?.lastError);
}

/**
 * 非异常且额度周期在一周内重置（含已到期）→ 临期。
 * 异常优先归异常，不重复计入临期。
 */
function isExpiringMember(member) {
  if (!member || isAbnormalMember(member)) return false;
  const days = daysUntil(member.lastSnapshot?.window?.resetIso);
  return days != null && days <= EXPIRING_WITHIN_DAYS;
}

function switchBlockReason(member) {
  if (!member) return '账号不存在';
  if (isAbnormalMember(member)) return '同步异常，请先更新 Token';
  const used = usedPercent(member);
  if (used == null) return '尚无额度数据，请先刷新';
  if (used >= 100) return '额度已用完';
  if (
    member.maxUsers != null &&
    Number(member.activeUserCount || 0) >= Number(member.maxUsers)
  ) {
    return `使用人数已满（${member.activeUserCount}/${member.maxUsers}）`;
  }
  if (member.id === currentCursorMemberId) return '当前正在使用';
  return '';
}

/** 正常：既非异常也非临期。 */
function isOkMember(member) {
  return !isAbnormalMember(member) && !isExpiringMember(member);
}

/** 格式化切换时快照的 Total usage。 */
function formatUsageTotal(pct) {
  if (pct == null || Number.isNaN(Number(pct))) return '—';
  return `${Number(pct).toFixed(1)}%`;
}

/** 按角色显示/隐藏管理入口。 */
function applyRoleUi() {
  const admin = isAdmin();
  document.querySelectorAll('.admin-only').forEach((el) => {
    el.classList.toggle('hidden', !admin);
  });
  if (els.currentUsername) {
    const name = currentUser?.username || '—';
    els.currentUsername.textContent = admin ? `${name} · 管理员` : name;
  }
  void loadExtensionInstallState();
}

function switchStatusLabel(status) {
  const map = {
    pending: '等待本机领取',
    claimed: '已领取',
    success: '成功',
    failed: '失败',
    expired: '已过期',
  };
  return map[status] || status || '—';
}

function switchStatusClass(status) {
  if (status === 'success') return 'ok';
  if (status === 'failed' || status === 'expired') return 'danger';
  if (status === 'claimed' || status === 'pending') return 'warn';
  return 'muted';
}

function usedPercent(member) {
  const snap = member.lastSnapshot;
  if (!snap) return null;
  const v =
    snap.meters?.primaryPercent ??
    snap.meters?.totalPercentUsed ??
    snap.meters?.quotaPercent ??
    snap.meters?.spendPercent;
  return v == null ? null : Number(v);
}

function remainingPercent(member) {
  const used = usedPercent(member);
  if (used == null) return null;
  return Math.max(0, Math.round((100 - used) * 10) / 10);
}

function resetMs(member) {
  const iso = member.lastSnapshot?.window?.resetIso;
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

function recommendedMemberFromList() {
  return (
    [...membersCache]
      .filter((member) => !switchBlockReason(member))
      .sort((a, b) => resetMs(a) - resetMs(b) || usedPercent(b) - usedPercent(a))[0] ||
    null
  );
}

/** 今日 tokens，无数据视为 0，便于排行。 */
function todayTokensOf(member) {
  return Number(member.lastSnapshot?.spend?.today?.tokens) || 0;
}

function todayRequestsOf(member) {
  return Number(member.lastSnapshot?.spend?.today?.requests) || 0;
}

function todayDollarsOf(member) {
  return Number(member.lastSnapshot?.spend?.today?.dollars) || 0;
}

function memberStatus(member) {
  // 有 lastError 一律视为异常（含仍有旧快照的情况），避免卡片仍显示「充足」
  if (member.lastError) return 'error';
  if (!member.lastSnapshot) return 'pending';
  const pace = computeUsagePace(member);
  if (pace) return pace.status;
  // 无周期窗口时退回绝对用量阈值
  if ((usedPercent(member) ?? 0) >= 80) return 'warn';
  return 'ok';
}

function statusBadgeHtml(member) {
  const status = memberStatus(member);
  if (status === 'error') {
    return `<span class="badge danger" title="${escapeHtml(member.lastError || '')}">异常</span>`;
  }
  const expiring =
    isExpiringMember(member)
      ? (() => {
          const days = daysUntil(member.lastSnapshot?.window?.resetIso);
          const tip =
            days === 0
              ? '额度周期今日重置或已到重置日'
              : `额度周期 ${days} 天内重置`;
          return `<span class="badge warn" title="${escapeHtml(tip)}">临期</span>`;
        })()
      : '';
  if (status === 'pending') return `${expiring}<span class="badge muted">待同步</span>`;
  const pace = computeUsagePace(member);
  if (status === 'danger') {
    return `${expiring}<span class="badge danger" title="${escapeHtml(pace?.summary || '')}">${escapeHtml(pace?.label || '超速')}</span>`;
  }
  if (status === 'warn') {
    return `${expiring}<span class="badge warn" title="${escapeHtml(pace?.summary || '')}">${escapeHtml(pace?.label || '偏快')}</span>`;
  }
  return `${expiring}<span class="badge ok" title="${escapeHtml(pace?.summary || '')}">${escapeHtml(pace?.label || '充足')}</span>`;
}

function fillClass(pct) {
  if (pct == null) return '';
  if (pct >= 95) return 'danger';
  if (pct >= 80) return 'warn';
  return '';
}

function chipClassForRemaining(remain) {
  if (remain == null) return 'neutral';
  if (remain <= 5) return 'danger';
  if (remain <= 20) return 'warn';
  return '';
}

function chipClassForDays(days) {
  if (days == null) return 'neutral';
  // ≤5 天红；低于 10 天（6–9）黄
  if (days <= 5) return 'danger';
  if (days < 10) return 'warn';
  return 'neutral';
}

function chipClassForTokenExp(iso) {
  const days = daysUntil(iso);
  if (days == null) return 'neutral';
  if (days <= 0) return 'danger';
  if (days <= 2) return 'warn';
  return 'neutral';
}

/** 紧凑色块：剩余额度 / 到期天数+有效期 / Token / 额度更新时间。 */
function metaChips(member) {
  const remain = remainingPercent(member);
  const resetIso = member.lastSnapshot?.window?.resetIso;
  const resetText = formatDateTimeDot(resetIso);
  const resetDays = daysUntil(resetIso);
  const tokenExpText = formatDateTimeDot(member.tokenExpiresAt);
  const syncedText = formatDateTimeDot(member.lastSyncedAt);
  const remainChip =
    remain == null
      ? ''
      : `<span class="chip ${chipClassForRemaining(remain)}" title="剩余额度 ${remain.toFixed(1)}%">${remain.toFixed(0)}%</span>`;
  // 天数放在有效期（额度重置日）之前，便于扫一眼还剩多久
  const resetChip =
    resetText == null
      ? ''
      : `<span class="chip ${chipClassForDays(resetDays)}" title="额度有效期 / 重置时间">${
          resetDays != null ? `${resetDays}天 · ` : ''
        }${escapeHtml(resetText)}</span>`;
  const tokenChip =
    tokenExpText == null
      ? ''
      : `<span class="chip ${chipClassForTokenExp(member.tokenExpiresAt)}" title="会话 Token 有效至">Token ${escapeHtml(tokenExpText)}</span>`;
  const syncedChip =
    syncedText == null
      ? '<span class="chip neutral">额度尚未更新</span>'
      : `<span class="chip neutral" title="自动调用 API 获取额度的时间">额度更新 ${escapeHtml(syncedText)}</span>`;
  return `${remainChip}${resetChip}${tokenChip}${syncedChip}`;
}

function renderActiveUserSlots(member) {
  const max = Number(member.maxUsers);
  if (!Number.isFinite(max) || max <= 0) return '';
  const users = Array.isArray(member.activeUsers) ? member.activeUsers.slice(0, max) : [];
  const slots = Array.from({ length: max }, (_, index) => {
    const user = users[index];
    if (!user) {
      return '<div class="user-slot user-slot--empty"><span class="user-avatar">+</span><span class="user-slot-name">空闲</span></div>';
    }
    const label = String(user.label || user.hostname || '未知');
    const initial = Array.from(label.trim())[0] || '?';
    const hostNote =
      user.hostname && user.hostname !== label ? ` · ${user.hostname}` : '';
    return `<div class="user-slot" title="${escapeHtml(`${label}${hostNote}`)}">
      <span class="user-avatar">${escapeHtml(initial.toUpperCase())}</span>
      <span class="user-slot-name">${escapeHtml(label)}</span>
    </div>`;
  }).join('');
  return `<div class="account-users ${member.capacityFull ? 'account-users--full' : ''}">
    <div class="account-users-head">
      <strong>使用人</strong>
      <span>${users.length}/${max}</span>
    </div>
    <div class="user-slots" style="--user-slot-count:${max}">${slots}</div>
  </div>`;
}

/**
 * @param {object} line
 * @param {Array<{ date: string, total?: number | null, auto?: number | null, api?: number | null }> | null | undefined} history
 */
function renderProgressLine(line, history) {
  const used = Number(line.used) || 0;
  const limit = Number(line.limit) || 100;
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  let valueText;
  if (line.format === 'percent') {
    const field = fieldForProgressLabel(line.label);
    const delta = field ? deltaVsYesterday(history, field, used) : null;
    const deltaText = formatDeltaVsYesterday(delta);
    const deltaCls =
      delta == null ? '' : delta > 0 ? 'pct-delta up' : delta < 0 ? 'pct-delta down' : 'pct-delta';
    valueText = deltaText
      ? `${used.toFixed(1)}% <span class="${deltaCls}" title="较昨日累计">${escapeHtml(deltaText)}</span>`
      : `${used.toFixed(1)}%`;
  } else if (line.format === 'dollars') valueText = `$${used.toFixed(2)} / $${limit.toFixed(2)}`;
  else valueText = `${used}/${limit}${line.suffix ? ` ${line.suffix}` : ''}`;

  return `
    <div class="panel-line">
      <div class="panel-line-head">
        <span class="panel-line-label">${escapeHtml(line.label)}</span>
        <span class="panel-line-value">${valueText}</span>
      </div>
      <div class="panel-track"><div class="panel-fill ${fillClass(pct)}" style="width:${pct}%"></div></div>
    </div>
  `;
}

function renderSpendRow(line) {
  const cell = (label, part) => {
    const text = formatSpendPart(part);
    return `
    <div class="spend-cell">
      <span class="k">${label}</span>
      <span class="v" title="${escapeHtml(text)}">${escapeHtml(text)}</span>
    </div>
  `;
  };
  // 账单行可点进详情日用量%图；阻止冒泡由列表委托处理。
  return `
    <div class="spend-row spend-row--link" data-action="bill" title="查看每日用量百分比图表">
      ${cell('Today', line.today)}
      ${cell('Yesterday', line.yesterday)}
      ${cell('Last 30 Days', line.last30)}
    </div>
  `;
}

function splitLines(lines, { includeGrok = true } = {}) {
  const progress = [];
  let spend = null;
  for (const line of lines || []) {
    if (line.type === 'spend-row') spend = line;
    else if (line.type === 'progress') {
      if (!includeGrok && line.label === 'Grok Bot usage') continue;
      progress.push(line);
    }
  }
  return { progress, spend };
}

function renderAccountRow(member) {
  const snap = member.lastSnapshot;
  const planRaw = snap?.plan?.planName || snap?.plan?.membershipType || 'unknown';
  const plan = formatPlanLabel(planRaw);
  const planClass = planBadgeClass(planRaw);
  const statusBadge = statusBadgeHtml(member);

  const idn = accountIdentity(member, settings.privacyMode);
  const blocked = switchBlockReason(member);
  const isRecommended = member.id === recommendedSwitchId && !blocked;
  const isCurrent = member.id === currentCursorMemberId;
  const err = member.lastError
    ? `<div class="error-box">${escapeHtml(member.lastError)}</div>`
    : '';

  const { progress, spend: panelSpend } = splitLines(snap?.panelLines, { includeGrok: false });
  const spend = resolveSpendRow(snap, panelSpend);
  const history = member.usagePercentHistory;
  const meters =
    progress.length > 0
      ? `<div class="panel-lines">${progress.map((line) => renderProgressLine(line, history)).join('')}</div>`
      : `<p class="muted" style="margin-top:10px">尚无面板数据</p>`;
  const spendHtml = spend ? renderSpendRow(spend) : '';

  const stateClass = isAbnormalMember(member)
    ? ' account--error'
    : isExpiringMember(member)
      ? ' account--expiring'
      : '';
  return `
    <article class="account${stateClass}" data-id="${member.id}">
      <div class="account-top">
        <div class="account-id">
          <div class="account-title">
            <span class="account-name">${escapeHtml(idn.title)}</span>
            ${idn.subtitle ? `<span class="account-sub">${escapeHtml(idn.subtitle)}</span>` : ''}
          </div>
          <div class="badges">
            <span class="badge plan ${planClass}">${escapeHtml(plan)}</span>
            ${isCurrent ? '<span class="badge ok">当前 Cursor</span>' : ''}
            ${isRecommended ? '<span class="badge warn">推荐</span>' : ''}
            ${statusBadge}
            ${metaChips(member)}
          </div>
        </div>
        <div class="account-actions">
          ${
            blocked
              ? `<button type="button" class="btn sm" disabled title="${escapeHtml(blocked)}">${escapeHtml(blocked)}</button>`
              : `<button type="button" class="btn sm primary" data-action="switch" title="切换本机 Cursor 到此账号">${isRecommended ? '推荐切换' : '切换'}</button>`
          }
          <button type="button" class="btn icon" data-action="refresh" title="刷新">↻</button>
          ${
            isAdmin()
              ? `<button type="button" class="btn icon" data-action="edit" title="更新 Token">✎</button>
          <button type="button" class="btn sm danger" data-action="delete">删除</button>`
              : ''
          }
        </div>
      </div>
      ${err}
      ${renderActiveUserSlots(member)}
      ${meters}
      ${spendHtml}
    </article>
  `;
}

function renderSummary(summary) {
  const s = summary || {
    memberCount: 0,
    todayBilledDollars: 0,
    todayRequests: 0,
    todayTokens: 0,
    syncedOk: 0,
    syncedError: 0,
  };
  els.summary.innerHTML = `
    <article class="stat"><p class="label">账号</p><p class="value">${s.memberCount}</p><p class="note">${money(s.todayBilledDollars)} 今日</p></article>
    <button type="button" class="stat stat-click" id="btnTodayUsage" title="查看今日用量排行（按 tokens）">
      <p class="label">今日用量</p>
      <p class="value">${s.todayRequests ?? 0}<span class="unit">次</span></p>
      <p class="note">${formatTokens(s.todayTokens)} tokens · 点击排行</p>
    </button>
    <button type="button" class="stat stat-click" id="btnFilterOk" title="只看正常账号">
      <p class="label">正常</p>
      <p class="value">${membersCache.filter(isOkMember).length}</p>
      <p class="note">点击筛选</p>
    </button>
    <button type="button" class="stat stat-click" id="btnFilterExpiring" title="只看一周内额度周期重置的账号">
      <p class="label">临期</p>
      <p class="value ${membersCache.some(isExpiringMember) ? 'warn' : ''}">${membersCache.filter(isExpiringMember).length}</p>
      <p class="note">额度重置 ≤${EXPIRING_WITHIN_DAYS} 天 · 点击筛选</p>
    </button>
    <button type="button" class="stat stat-click stat-error" id="btnFilterError" title="只看异常账号">
      <p class="label">异常</p>
      <p class="value ${(s.syncedError || 0) > 0 ? 'danger' : ''}">${s.syncedError ?? 0}</p>
      <p class="note">需更新 Token · 点击筛选</p>
    </button>
  `;
  document.getElementById('btnTodayUsage')?.addEventListener('click', openTodayRank);
  document.getElementById('btnFilterOk')?.addEventListener('click', () => setAccountStatusFilter('ok'));
  document
    .getElementById('btnFilterExpiring')
    ?.addEventListener('click', () => setAccountStatusFilter('expiring'));
  document.getElementById('btnFilterError')?.addEventListener('click', () => setAccountStatusFilter('error'));
}

/** 打开今日用量排行：按 tokens 倒序，展示用户名。 */
function openTodayRank() {
  const ranked = [...membersCache].sort((a, b) => todayTokensOf(b) - todayTokensOf(a));
  if (!els.todayRankBody) return;
  if (!ranked.length) {
    els.todayRankBody.innerHTML = `<tr><td colspan="5" class="muted">暂无账号</td></tr>`;
  } else {
    els.todayRankBody.innerHTML = ranked
      .map((m, i) => {
        const idn = accountIdentity(m, settings.privacyMode);
        const tokens = todayTokensOf(m);
        const reqs = todayRequestsOf(m);
        const dollars = todayDollarsOf(m);
        return `
          <tr class="rank-row" data-id="${escapeHtml(m.id)}" title="打开详情">
            <td class="rank-num">${i + 1}</td>
            <td>
              <span class="rank-name">${escapeHtml(idn.title)}</span>
              ${idn.subtitle ? `<span class="rank-sub">${escapeHtml(idn.subtitle)}</span>` : ''}
            </td>
            <td class="rank-metric">${escapeHtml(formatTokens(tokens))}</td>
            <td class="rank-metric">${reqs}次</td>
            <td class="rank-metric">${money(dollars)}</td>
          </tr>
        `;
      })
      .join('');
  }
  els.todayRankDialog?.showModal();
}

function filteredMembers() {
  const q = (els.searchInput.value || '').trim().toLowerCase();
  const sort = els.sortBy?.value || 'reset';
  const list = membersCache.filter((m) => {
    if (accountStatusFilter === 'ok' && !isOkMember(m)) return false;
    if (accountStatusFilter === 'expiring' && !isExpiringMember(m)) return false;
    if (accountStatusFilter === 'error' && !isAbnormalMember(m)) return false;
    if (!q) return true;
    return `${m.displayName} ${m.email || ''} ${m.userId || ''}`.toLowerCase().includes(q);
  });
  list.sort((a, b) => {
    if (sort === 'todayTokens') return todayTokensOf(b) - todayTokensOf(a);
    if (sort === 'remaining') {
      const ar = remainingPercent(a);
      const br = remainingPercent(b);
      if (ar == null && br == null) return 0;
      if (ar == null) return 1;
      if (br == null) return -1;
      if (accountStatusFilter === 'expiring') return br - ar;
      return ar - br;
    }
    if (sort === 'used') {
      const au = usedPercent(a);
      const bu = usedPercent(b);
      if (au == null && bu == null) return 0;
      if (au == null) return 1;
      if (bu == null) return -1;
      return bu - au;
    }
    if (sort === 'reset') return resetMs(a) - resetMs(b);
    return String(a.displayName || a.email || '').localeCompare(
      String(b.displayName || b.email || ''),
      'zh',
    );
  });
  return list;
}

/** 同步筛选 Tab 的激活态与计数。 */
function syncStatusFilterUi() {
  const all = membersCache.length;
  const bad = membersCache.filter(isAbnormalMember).length;
  const expiring = membersCache.filter(isExpiringMember).length;
  const ok = membersCache.filter(isOkMember).length;
  els.statusFilter?.querySelectorAll('.filter-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.status === accountStatusFilter);
  });
  els.statusFilter?.querySelectorAll('[data-count]').forEach((el) => {
    const key = el.getAttribute('data-count');
    const n =
      key === 'ok' ? ok : key === 'expiring' ? expiring : key === 'error' ? bad : all;
    el.textContent = String(n);
  });
}

/** @param {'all' | 'ok' | 'expiring' | 'error'} next */
function setAccountStatusFilter(next) {
  accountStatusFilter = next;
  renderList();
}

function renderList() {
  renderSummary(summaryCache);
  syncStatusFilterUi();
  const list = filteredMembers();
  els.empty.classList.toggle('hidden', membersCache.length > 0);
  if (!membersCache.length) {
    els.list.innerHTML = '';
    return;
  }
  // 「全部」时按正常 / 临期 / 异常分区，临期夹在中间便于扫
  if (accountStatusFilter === 'all') {
    const ok = list.filter(isOkMember);
    const expiring = list.filter(isExpiringMember);
    const bad = list.filter(isAbnormalMember);
    const parts = [];
    if (ok.length) {
      parts.push(
        `<div class="account-section"><h3 class="account-section-title">正常 <span class="muted">${ok.length}</span></h3>${ok
          .map(renderAccountRow)
          .join('')}</div>`,
      );
    }
    if (expiring.length) {
      parts.push(
        `<div class="account-section account-section--expiring"><h3 class="account-section-title">临期 <span class="muted">${expiring.length}</span></h3>${expiring
          .map(renderAccountRow)
          .join('')}</div>`,
      );
    }
    if (bad.length) {
      parts.push(
        `<div class="account-section account-section--error"><h3 class="account-section-title">异常 <span class="muted">${bad.length}</span></h3>${bad
          .map(renderAccountRow)
          .join('')}</div>`,
      );
    }
    els.list.innerHTML = parts.length
      ? parts.join('')
      : `<p class="muted filter-empty">无匹配账号</p>`;
    return;
  }
  els.list.innerHTML = list.length
    ? list.map(renderAccountRow).join('')
    : `<p class="muted filter-empty">当前筛选下无账号</p>`;
}

function showView(view) {
  const allowed = new Set(['accounts', 'switches', 'help']);
  if (isAdmin()) {
    allowed.add('users');
    allowed.add('reports');
  }
  const next = allowed.has(view) ? view : 'accounts';
  els.tabAccounts?.classList.toggle('hidden', next !== 'accounts');
  els.tabSwitches?.classList.toggle('hidden', next !== 'switches');
  els.tabReports?.classList.toggle('hidden', next !== 'reports');
  els.tabUsers?.classList.toggle('hidden', next !== 'users');
  els.tabHelp?.classList.toggle('hidden', next !== 'help');
  // 仅账号列表需要顶部汇总条。
  if (els.summary) els.summary.classList.toggle('hidden', next !== 'accounts');
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === next);
  });
  if (next === 'switches') void loadSwitchLogs();
  if (next === 'reports' && isAdmin()) void loadReports();
  if (next === 'users' && isAdmin()) void loadUsers();
}

async function load() {
  const data = await api('/api/members');
  membersCache = data.members || [];
  summaryCache = data.summary || {};
  recommendedSwitchId = data.recommendedSwitchId || null;
  renderList();
  if (!currentCursorChecked) void detectCurrentCursorAccount();
}

async function refreshAll(silent = false) {
  if (refreshingAll) return;
  refreshingAll = true;
  setBusy(els.btnRefreshAll, true, '更新中…');
  try {
    await api('/api/refresh-all', { method: 'POST', body: '{}' });
    await load();
    toast(silent ? '已自动更新' : '全部账号已更新');
  } catch (e) {
    toast(e.message || String(e));
  } finally {
    refreshingAll = false;
    setBusy(els.btnRefreshAll, false);
  }
}

function applySettingsToForm() {
  if (els.privacyMode) els.privacyMode.checked = Boolean(settings.privacyMode);
}

/** 默认密码登录后的不可关闭改密弹窗。 */
function openForcePasswordDialog() {
  if (!els.forcePasswordDialog) return;
  if (els.forceNewPassword) els.forceNewPassword.value = '';
  if (els.forceNewPassword2) els.forceNewPassword2.value = '';
  els.forcePasswordError?.classList.add('hidden');
  if (!els.forcePasswordDialog.open) els.forcePasswordDialog.showModal();
  els.forceNewPassword?.focus();
}

/** 启动时检查登录身份与是否须强制改密。 */
async function ensurePasswordPolicy() {
  try {
    const me = await api('/api/auth/me');
    currentUser = { username: me.username || '—', role: me.role || 'user' };
    applyRoleUi();
    // 面板显隐只走 showView，避免 admin-only 把用户管理挂在账号列表下方
    showView('accounts');
    forcePasswordRequired = Boolean(me.mustChangePassword);
    if (forcePasswordRequired || sessionStorage.getItem('ctu_force_password') === '1') {
      openForcePasswordDialog();
    }
  } catch {
    /* 未登录时由 api 跳转登录页 */
  }
}

async function loadSwitchLogs() {
  if (!els.switchLogBody) return;
  try {
    const data = await api('/api/switch-logs?limit=100');
    switchLogsCache = data.logs || [];
    if (!switchLogsCache.length) {
      els.switchLogBody.innerHTML = `<tr><td colspan="8" class="muted">暂无切换记录</td></tr>`;
      return;
    }
    els.switchLogBody.innerHTML = switchLogsCache
      .map((log) => {
        const account =
          log.memberDisplayName || log.memberEmail || log.memberUserId || log.memberId || '—';
        const when = formatDateTimeDot(log.createdAt) || log.createdAt || '—';
        return `
          <tr>
            <td>${escapeHtml(when)}</td>
            <td>${escapeHtml(log.operatorUsername || '—')}</td>
            <td>
              <span class="rank-name">${escapeHtml(account)}</span>
              ${
                log.memberEmail && log.memberEmail !== account
                  ? `<span class="rank-sub">${escapeHtml(log.memberEmail)}</span>`
                  : ''
              }
            </td>
            <td class="rank-metric">${escapeHtml(formatUsageTotal(log.usageTotalPercent))}</td>
            <td>${escapeHtml(log.hostname || '—')}</td>
            <td>${escapeHtml(log.clientIp || '—')}</td>
            <td><span class="badge ${switchStatusClass(log.status)}">${escapeHtml(
              switchStatusLabel(log.status),
            )}</span></td>
            <td class="muted">${escapeHtml(log.error || '—')}</td>
          </tr>
        `;
      })
      .join('');
  } catch (e) {
    toast(e.message || String(e));
  }
}

/** 管理员报表：操作者汇总 + 最近明细。 */
async function loadReports() {
  if (!els.reportOperatorBody || !isAdmin()) return;
  try {
    const [data, reportData] = await Promise.all([
      api('/api/reports/switches?limit=500'),
      api('/api/report-logs?limit=200'),
    ]);
    const operators = data.operators || [];
    const recent = data.recent || [];
    els.reportOperatorBody.innerHTML = operators.length
      ? operators
          .map(
            (row) => `
          <tr>
            <td>${escapeHtml(row.username || '—')}</td>
            <td class="rank-metric">${row.switchCount ?? 0}</td>
            <td class="rank-metric">${row.successCount ?? 0}</td>
            <td class="rank-metric">${row.memberCount ?? 0}</td>
            <td>${escapeHtml((row.ips || []).join(', ') || '—')}</td>
            <td>${escapeHtml((row.hostnames || []).join(', ') || '—')}</td>
          </tr>
        `,
          )
          .join('')
      : `<tr><td colspan="6" class="muted">暂无切换数据</td></tr>`;
    if (els.reportRecentBody) {
      els.reportRecentBody.innerHTML = recent.length
        ? recent
            .map((log) => {
              const account =
                log.memberDisplayName || log.memberEmail || log.memberUserId || log.memberId || '—';
              const when = formatDateTimeDot(log.createdAt) || log.createdAt || '—';
              return `
              <tr>
                <td>${escapeHtml(when)}</td>
                <td>${escapeHtml(log.operatorUsername || '—')}</td>
                <td>${escapeHtml(account)}</td>
                <td class="rank-metric">${escapeHtml(formatUsageTotal(log.usageTotalPercent))}</td>
                <td>${escapeHtml(log.hostname || '—')}</td>
                <td>${escapeHtml(log.clientIp || '—')}</td>
                <td><span class="badge ${switchStatusClass(log.status)}">${escapeHtml(
                  switchStatusLabel(log.status),
                )}</span></td>
              </tr>
            `;
            })
            .join('')
        : `<tr><td colspan="7" class="muted">暂无切换记录</td></tr>`;
    }
    if (els.reportLogBody) {
      const logs = reportData.logs || [];
      els.reportLogBody.innerHTML = logs.length
        ? logs
            .map(
              (log) => `
          <tr>
            <td>${escapeHtml(formatDateTimeDot(log.createdAt) || log.createdAt || '—')}</td>
            <td>${escapeHtml(log.operatorUsername || log.hostRemark || '旧版插件')}</td>
            <td>${escapeHtml(log.memberDisplayName || log.memberEmail || '—')}</td>
            <td>${escapeHtml(
              [log.hostname, log.hostRemark].filter(Boolean).join(' / ') || '—',
            )}</td>
            <td>${escapeHtml(
              [log.pluginVersion, log.pluginBuild].filter(Boolean).join(' · ') || '旧版',
            )}</td>
            <td><span class="badge ${log.ok ? 'ok' : 'danger'}">${
              log.ok ? '成功' : '失败'
            }</span>${log.error ? ` <span class="muted">${escapeHtml(log.error)}</span>` : ''}</td>
          </tr>`,
            )
            .join('')
        : '<tr><td colspan="6" class="muted">暂无自动上报记录</td></tr>';
    }
  } catch (e) {
    toast(e.message || String(e));
  }
}

function pluginCell(plugin) {
  if (!plugin?.version) return '<span class="muted">未安装</span>';
  const ver = [plugin.version, plugin.build].filter(Boolean).join(' · ');
  const when = formatDateTimeDot(plugin.reportedAt || plugin.installedAt);
  const how = plugin.state === 'reported' ? '已上报' : '已安装';
  return `${escapeHtml(ver)}<div class="muted">${escapeHtml(how)}${when ? ` ${escapeHtml(when)}` : ''}</div>`;
}

async function loadUsers() {
  if (!els.userTableBody || !isAdmin()) return;
  try {
    const [data, loginData] = await Promise.all([
      api('/api/users'),
      api('/api/login-logs?limit=100'),
    ]);
    usersCache = data.users || [];
    els.userTableBody.innerHTML = usersCache
      .map((u) => {
        const created = formatDateTimeDot(u.createdAt) || u.createdAt || '—';
        const roleLabel = u.role === 'admin' ? '管理员' : '普通用户';
        const status = u.pending
          ? '待审批'
          : u.disabled
            ? '已禁用'
            : u.mustChangePassword
              ? '须改密'
              : '正常';
        const canDelete = u.username !== 'admin';
        const activeAccounts = (u.activeAccounts || [])
          .map(
            (row) =>
              `${row.memberDisplayName || row.memberId || '未知账号'} · ${
                row.hostname || '未知主机'
              }`,
          )
          .join('；');
        const actions = u.pending
          ? `<button type="button" class="btn sm primary" data-user-action="approve">同意</button>
              <button type="button" class="btn sm danger" data-user-action="reject">拒绝</button>`
          : `<button type="button" class="btn sm" data-user-action="alias">别名</button>
              <button type="button" class="btn sm" data-user-action="reset">重置密码</button>
              ${
                canDelete
                  ? `<button type="button" class="btn sm" data-user-action="toggle">${
                      u.disabled ? '启用' : '禁用'
                    }</button>
              <button type="button" class="btn sm danger" data-user-action="delete">删除</button>`
                  : ''
              }`;
        return `
          <tr data-username="${escapeHtml(u.username)}" class="${u.pending ? 'user-row-pending' : ''}">
            <td>${escapeHtml(u.username)}</td>
            <td>${escapeHtml(u.alias || '—')}</td>
            <td>${escapeHtml(roleLabel)}</td>
            <td>${
              u.pending ? `<span class="badge warn">${escapeHtml(status)}</span>` : escapeHtml(status)
            }</td>
            <td>${escapeHtml(activeAccounts || '—')}</td>
            <td>${pluginCell(u.plugin)}</td>
            <td>${escapeHtml(created)}</td>
            <td class="user-actions">${actions}</td>
          </tr>
        `;
      })
      .join('');
    if (els.loginLogBody) {
      const logs = loginData.logs || [];
      els.loginLogBody.innerHTML = logs.length
        ? logs
            .map(
              (log) => `
          <tr>
            <td>${escapeHtml(formatDateTimeDot(log.createdAt) || log.createdAt || '—')}</td>
            <td>${escapeHtml(log.username || '—')}</td>
            <td><span class="badge ${log.ok ? 'ok' : 'danger'}">${
              log.ok ? '成功' : '失败'
            }</span></td>
            <td>${escapeHtml(log.ip || '—')}</td>
            <td class="muted">${escapeHtml(log.userAgent || '—')}</td>
          </tr>`,
            )
            .join('')
        : '<tr><td colspan="5" class="muted">暂无登录记录</td></tr>';
    }
  } catch (e) {
    toast(e.message || String(e));
  }
}

function openUserDialog() {
  if (!els.userDialog) return;
  if (els.fieldUsername) els.fieldUsername.value = '';
  if (els.fieldUserPassword) els.fieldUserPassword.value = '';
  if (els.fieldUserRole) els.fieldUserRole.value = 'user';
  els.userDialog.showModal();
  els.fieldUsername?.focus();
}

function closeUserDialog() {
  if (els.userDialog?.open) els.userDialog.close();
}

/** 本机扩展桥默认端口；与扩展设置 cursorTeamUsage.localBridgePort 一致。 */
const LOCAL_BRIDGE_PORTS = [3781];

/**
 * 探测本机扩展桥是否可用。
 * @returns {Promise<number | null>}
 */
async function findLocalBridgePort() {
  for (const port of LOCAL_BRIDGE_PORTS) {
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(800),
      });
      if (health.ok) return port;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

/** 登录看板后从本机扩展读取当前 Cursor 账号，并匹配名册人员。 */
async function detectCurrentCursorAccount() {
  const port = await findLocalBridgePort();
  if (port == null) return;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/current-account`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const info = await res.json();
    currentCursorChecked = true;
    const email = String(info.email || '').toLowerCase();
    const userId = String(info.userId || '');
    const member = membersCache.find(
      (m) =>
        (userId && String(m.userId || '') === userId) ||
        (email && String(m.email || '').toLowerCase() === email),
    );
    currentCursorMemberId = member?.id || null;
    recommendedSwitchId = recommendedMemberFromList()?.id || null;
    renderList();

    const shownKey = `ctu_current_cursor_shown_${currentUser?.username || 'user'}`;
    if (sessionStorage.getItem(shownKey) !== '1') {
      sessionStorage.setItem(shownKey, '1');
      const account = info.email || info.userId || '未识别';
      const person = member?.displayName || '名册中未匹配到人员';
      alert(`当前 Cursor 账号：${account}\n对应人员：${person}`);
    }
  } catch {
    /* 旧版扩展尚无 current-account 接口，不阻塞看板 */
  }
}

/** 进入页面时只检查一次：未安装 / 可更新 / 已是最新版。 */
async function loadExtensionInstallState() {
  if (extensionMeta) return;
  try {
    extensionMeta = await api('/api/extension/meta');
    const port = await findLocalBridgePort();
    if (port != null) {
      const res = await fetch(`http://127.0.0.1:${port}/extension-info`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) localExtensionInfo = await res.json();
      else localExtensionInfo = { version: '已安装版本', build: '' };
    }
    if (!localExtensionInfo?.version) {
      extensionInstallMode = 'install';
    } else if (
      localExtensionInfo.version !== extensionMeta.version ||
      localExtensionInfo.build !== extensionMeta.build ||
      localExtensionInfo.operatorUsername !== currentUser?.username
    ) {
      extensionInstallMode = 'update';
    } else {
      extensionInstallMode = 'reinstall';
    }
    if (els.btnInstallExtension) {
      els.btnInstallExtension.textContent =
        extensionInstallMode === 'install'
          ? '安装插件'
          : extensionInstallMode === 'update'
            ? '更新插件'
            : '重新安装插件';
    }
  } catch {
    extensionInstallMode = 'install';
  }
}

/** 个性化安装：VSIX 写入当前看板用户名，优先走本机桥。 */
async function oneClickInstallExtension() {
  const btn = els.btnInstallExtension;
  setBusy(btn, true, '准备中…');
  try {
    await loadExtensionInstallState();
    const username = currentUser?.username || '当前用户';
    const action =
      extensionInstallMode === 'install'
        ? '安装'
        : extensionInstallMode === 'update'
          ? '更新'
          : '重新安装';
    const prompt =
      extensionInstallMode === 'update'
        ? `将 Reporter 从 ${localExtensionInfo?.version || '旧版本'} 更新到 ${
            extensionMeta?.version || '最新版'
          }，并绑定看板用户「${username}」。继续？`
        : `${action} Reporter，并绑定看板用户「${username}」。继续？`;
    if (!confirm(prompt)) return;

    const link = await api('/api/extension/install-link', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const port = await findLocalBridgePort();
    if (port != null) {
      const res = await fetch(`http://127.0.0.1:${port}/install-extension`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vsixUrl: link.vsixUrl }),
        signal: AbortSignal.timeout(120_000),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok !== false) {
        toast(`已为「${username}」${action}插件，Cursor 正在自动重载`);
        return;
      }
      toast(body.error || `${action}失败，已复制备用命令`);
    } else {
      toast(`未检测到本机桥，已复制 PowerShell ${action}命令`);
    }
    try {
      await navigator.clipboard.writeText(link.oneLiner);
    } catch {
      /* 剪贴板失败时仍弹出 */
    }
    window.prompt(
      `在本机 PowerShell 执行${action}（已尝试复制）：`,
      link.oneLiner,
    );
  } catch (e) {
    toast(e.message || String(e));
  } finally {
    setBusy(btn, false);
  }
}

/**
 * 探测并通知本机扩展桥（Agent 模式不走 cursor://）。
 * @param {string} ticketId
 */
async function notifyLocalBridge(ticketId) {
  const port = await findLocalBridgePort();
  if (port == null) return { ok: false, port: null };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticketId }),
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok || res.status === 202) return { ok: true, port };
  } catch {
    /* 桥在但切换失败 */
  }
  return { ok: false, port: null };
}

/**
 * 通过本机桥从备份区恢复切换前的 Cursor 账号。
 */
async function restoreLastLocalAccount() {
  const port = await findLocalBridgePort();
  if (port == null) {
    toast('未连上本机桥 :3781。请确认已安装 Reporter 扩展（≥0.2.2）并已启动 Cursor，或在命令面板执行「恢复上次账号」。');
    return;
  }
  try {
    const infoRes = await fetch(`http://127.0.0.1:${port}/backup`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
    const info = await infoRes.json().catch(() => ({}));
    if (!info.exists) {
      toast('备份区没有上次账号。请先通过看板「切换」一次，才会生成备份。');
      return;
    }
    const label = info.email || info.userId || '上次账号';
    const when = info.savedAt ? new Date(info.savedAt).toLocaleString('zh-CN') : '未知时间';
    if (!confirm(`将从本机备份区恢复「${label}」（备份于 ${when}）并重启 Cursor。\n请在 Cursor 弹窗中确认。继续？`)) {
      return;
    }
    setBusy(els.btnRestoreLocal, true, '恢复中…');
    const res = await fetch(`http://127.0.0.1:${port}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok && res.status !== 202) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `桥返回 ${res.status}`);
    }
    toast(`已通知本机 Cursor 恢复「${label}」，请在弹窗中确认`);
  } catch (e) {
    toast(e.message || String(e));
  } finally {
    setBusy(els.btnRestoreLocal, false);
  }
}

/**
 * 发起一键切换：优先本机 HTTP 桥（Agent 可用），再试 cursor://（IDE 模式）。
 * @param {string} id
 * @param {HTMLButtonElement} btn
 */
async function switchMember(id, btn) {
  const member = membersCache.find((m) => m.id === id);
  const label = member?.displayName || member?.email || id;
  const blocked = switchBlockReason(member);
  if (blocked) {
    toast(`${label}：${blocked}`);
    return;
  }
  if (
    !confirm(
      `切换到「${label}」？\n剩余额度：${
        remainingPercent(member)?.toFixed(1) ?? '未知'
      }% · 使用人：${Number(member?.activeUserCount || 0)}/${
        member?.maxUsers ?? '不限'
      }`,
    )
  ) {
    return;
  }
  setBusy(btn, true, '切换中…');
  try {
    const data = await api(`/api/members/${id}/switch`, { method: 'POST', body: '{}' });
    if (!data?.ticketId) throw new Error('服务端未返回切换票据');
    const ticketId = String(data.ticketId);

    const bridge = await notifyLocalBridge(ticketId);
    if (bridge.ok) {
      toast(`已通知本机 Cursor（桥 :${bridge.port}）切换到「${label}」，请在弹窗中确认`);
      void loadSwitchLogs();
      return;
    }

    // 回退：cursor:// UriHandler（经典 IDE 窗口通常可用；Agent/Glass 往往无效）
    if (data.uri) {
      const a = document.createElement('a');
      a.href = data.uri;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    toast(
      `未连上本机桥 :3781。已尝试 cursor://。可在 Cursor 命令面板执行「粘贴切换票据」并粘贴：${ticketId}`,
      8000,
    );
    try {
      await navigator.clipboard.writeText(ticketId);
    } catch {
      /* 无剪贴板权限时忽略 */
    }
    void loadSwitchLogs();
  } catch (e) {
    toast(e.message || String(e));
  } finally {
    setBusy(btn, false);
  }
}

async function switchRecommendedMember() {
  const member = membersCache.find((m) => m.id === recommendedSwitchId);
  if (!member) {
    toast('没有可切换的账号（需同步正常且仍有额度）');
    return;
  }
  await switchMember(member.id, els.btnSwitchRecommended);
}

function closeMemberDialog() {
  if (els.dialog.open) els.dialog.close();
}

function openMemberDialog(member = null) {
  editing = member;
  els.dialogTitle.textContent = member ? '更新账号' : '添加账号';
  els.displayName.value = member?.displayName || '';
  els.sessionToken.value = '';
  els.btnImportInDialog.classList.toggle('hidden', Boolean(member?.id));
  els.dialog.showModal();
  els.displayName.focus();
}

async function importLocalCursor(displayName) {
  const body = { fromLocalCursor: true };
  const name = (displayName || '').trim();
  if (name) body.displayName = name;
  await api('/api/members', { method: 'POST', body: JSON.stringify(body) });
  toast('已导入本机 Cursor 账号');
  await load();
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    showView(btn.dataset.tab || 'accounts');
  });
});

els.statusFilter?.addEventListener('click', (event) => {
  const btn = event.target.closest('.filter-tab');
  if (!btn?.dataset.status) return;
  setAccountStatusFilter(
    /** @type {'all' | 'ok' | 'expiring' | 'error'} */ (btn.dataset.status),
  );
});

els.btnHelp.addEventListener('click', () => showView('help'));
els.btnAdd?.addEventListener('click', () => openMemberDialog());
els.btnEmptyAdd?.addEventListener('click', () => openMemberDialog());
els.btnRefreshSwitchLogs?.addEventListener('click', () => loadSwitchLogs());
els.btnRefreshReports?.addEventListener('click', () => loadReports());
els.btnAddUser?.addEventListener('click', () => openUserDialog());
els.btnInstallExtension?.addEventListener('click', () => oneClickInstallExtension());
els.btnUserDialogClose?.addEventListener('click', closeUserDialog);
els.btnUserDialogCancel?.addEventListener('click', closeUserDialog);
els.btnSaveUser?.addEventListener('click', async () => {
  const username = els.fieldUsername?.value.trim() || '';
  const password = els.fieldUserPassword?.value || '';
  const role = els.fieldUserRole?.value || 'user';
  if (!username) return toast('请填写用户名');
  if (password.length < 4) return toast('密码至少 4 位');
  setBusy(els.btnSaveUser, true, '创建中…');
  try {
    await api('/api/users', {
      method: 'POST',
      body: JSON.stringify({ username, password, role }),
    });
    toast(`已创建用户 ${username}`);
    closeUserDialog();
    await loadUsers();
  } catch (e) {
    toast(e.message || String(e));
  } finally {
    setBusy(els.btnSaveUser, false);
  }
});

els.userTableBody?.addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-user-action]');
  const row = event.target.closest('tr[data-username]');
  if (!btn || !row) return;
  const username = row.dataset.username;
  const action = btn.dataset.userAction;
  const user = usersCache.find((u) => u.username === username);
  if (!username || !user) return;

  if (action === 'approve') {
    setBusy(btn, true, '…');
    try {
      await api(`/api/users/${encodeURIComponent(username)}/approve`, {
        method: 'POST',
        body: '{}',
      });
      toast(`已同意 ${username} 的注册申请`);
      await loadUsers();
    } catch (e) {
      toast(e.message || String(e));
      setBusy(btn, false);
    }
    return;
  }

  if (action === 'reject') {
    if (!confirm(`确定拒绝「${username}」的注册申请？将删除该申请账号。`)) return;
    setBusy(btn, true, '…');
    try {
      await api(`/api/users/${encodeURIComponent(username)}/reject`, {
        method: 'POST',
        body: '{}',
      });
      toast(`已拒绝 ${username}`);
      await loadUsers();
    } catch (e) {
      toast(e.message || String(e));
      setBusy(btn, false);
    }
    return;
  }

  if (action === 'alias') {
    const next = prompt(`为「${username}」设置别名。席位上会显示这个名字，留空则清除：`, user.alias || '');
    if (next == null) return;
    if (next.trim().length > 32) return toast('别名最多 32 个字');
    setBusy(btn, true, '…');
    try {
      await api(`/api/users/${encodeURIComponent(username)}`, {
        method: 'PUT',
        body: JSON.stringify({ alias: next.trim() }),
      });
      toast(next.trim() ? `已把 ${username} 的别名设为 ${next.trim()}` : `已清除 ${username} 的别名`);
      await loadUsers();
      await load();
    } catch (e) {
      toast(e.message || String(e));
      setBusy(btn, false);
    }
    return;
  }

  if (action === 'reset') {
    const password = prompt(`为「${username}」设置新密码（至少 4 位）：`);
    if (password == null) return;
    if (password.length < 4) return toast('密码至少 4 位');
    setBusy(btn, true, '…');
    try {
      await api(`/api/users/${encodeURIComponent(username)}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      toast(`已重置 ${username} 的密码`);
      await loadUsers();
    } catch (e) {
      toast(e.message || String(e));
      setBusy(btn, false);
    }
    return;
  }

  if (action === 'toggle') {
    setBusy(btn, true, '…');
    try {
      await api(`/api/users/${encodeURIComponent(username)}`, {
        method: 'PUT',
        body: JSON.stringify({ disabled: !user.disabled }),
      });
      toast(user.disabled ? `已启用 ${username}` : `已禁用 ${username}`);
      await loadUsers();
    } catch (e) {
      toast(e.message || String(e));
      setBusy(btn, false);
    }
    return;
  }

  if (action === 'delete') {
    if (!confirm(`确定删除用户「${username}」？`)) return;
    setBusy(btn, true, '删除中…');
    try {
      await api(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
      toast(`已删除 ${username}`);
      await loadUsers();
    } catch (e) {
      toast(e.message || String(e));
      setBusy(btn, false);
    }
  }
});
els.btnDialogClose.addEventListener('click', closeMemberDialog);
els.btnDialogCancel.addEventListener('click', closeMemberDialog);
els.btnTodayRankClose?.addEventListener('click', () => els.todayRankDialog?.close());
els.btnTodayRankCancel?.addEventListener('click', () => els.todayRankDialog?.close());
els.todayRankBody?.addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-id]');
  if (!row?.dataset.id) return;
  els.todayRankDialog?.close();
  location.href = `/detail.html?id=${encodeURIComponent(row.dataset.id)}`;
});
els.searchInput.addEventListener('input', renderList);
els.sortBy?.addEventListener('change', renderList);

els.privacyMode?.addEventListener('change', () => {
  settings = saveSettings({ privacyMode: Boolean(els.privacyMode.checked) });
  renderList();
});

els.btnForceChangePassword?.addEventListener('click', async () => {
  const p1 = els.forceNewPassword?.value || '';
  const p2 = els.forceNewPassword2?.value || '';
  if (els.forcePasswordError) {
    els.forcePasswordError.classList.add('hidden');
    els.forcePasswordError.textContent = '';
  }
  if (p1.length < 4) {
    if (els.forcePasswordError) {
      els.forcePasswordError.textContent = '密码至少 4 位';
      els.forcePasswordError.classList.remove('hidden');
    }
    return;
  }
  if (p1 !== p2) {
    if (els.forcePasswordError) {
      els.forcePasswordError.textContent = '两次输入不一致';
      els.forcePasswordError.classList.remove('hidden');
    }
    return;
  }
  setBusy(els.btnForceChangePassword, true, '保存中…');
  try {
    await api('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ password: p1 }),
    });
    sessionStorage.removeItem('ctu_force_password');
    forcePasswordRequired = false;
    if (els.forcePasswordDialog?.open) els.forcePasswordDialog.close();
    toast('密码已更新，可继续使用');
  } catch (e) {
    if (els.forcePasswordError) {
      els.forcePasswordError.textContent = e.message || String(e);
      els.forcePasswordError.classList.remove('hidden');
    } else {
      toast(e.message || String(e));
    }
  } finally {
    setBusy(els.btnForceChangePassword, false);
  }
});

// 强制改密弹窗不允许 Esc / 点遮罩关闭。
els.forcePasswordDialog?.addEventListener('cancel', (e) => {
  if (forcePasswordRequired || sessionStorage.getItem('ctu_force_password') === '1') {
    e.preventDefault();
  }
});

els.btnLogout?.addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST', body: '{}' });
  } catch {
    /* ignore */
  }
  sessionStorage.removeItem('ctu_force_password');
  sessionStorage.removeItem(`ctu_current_cursor_shown_${currentUser?.username || 'user'}`);
  location.href = '/login.html';
});

els.btnExport?.addEventListener('click', async () => {
  setBusy(els.btnExport, true, '导出中…');
  try {
    const data = await api('/api/export/accounts');
    const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '');
    downloadText(
      `cursor-team-usage-accounts-${stamp}.json`,
      JSON.stringify(data, null, 2),
      'application/json',
    );
    toast(`已导出 ${data.members?.length || 0} 个账号（含 Token，请妥善保管）`);
  } catch (e) {
    toast(e.message || String(e));
  } finally {
    setBusy(els.btnExport, false);
  }
});

els.btnImportInDialog.addEventListener('click', async () => {
  setBusy(els.btnImportInDialog, true, '导入中…');
  try {
    await importLocalCursor(els.displayName.value);
    closeMemberDialog();
  } catch (e) {
    toast(e.message || String(e));
  } finally {
    setBusy(els.btnImportInDialog, false);
  }
});

els.btnSaveMember.addEventListener('click', async () => {
  const displayName = els.displayName.value.trim();
  const sessionToken = els.sessionToken.value.trim();
  if (!displayName) return toast('请填写显示名');
  if (!editing?.id && !sessionToken) return toast('请填写会话 Token');
  setBusy(els.btnSaveMember, true, '保存中…');
  try {
    if (editing?.id) {
      const body = { displayName };
      if (sessionToken) body.sessionToken = sessionToken;
      await api(`/api/members/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      if (sessionToken) {
        await api(`/api/members/${editing.id}/refresh`, { method: 'POST', body: '{}' });
      }
      toast('已更新');
    } else {
      await api('/api/members', {
        method: 'POST',
        body: JSON.stringify({ displayName, sessionToken }),
      });
      toast('已添加并同步');
    }
    closeMemberDialog();
    await load();
  } catch (e) {
    toast(e.message || String(e));
  } finally {
    setBusy(els.btnSaveMember, false);
  }
});

els.btnRefreshAll.addEventListener('click', () => refreshAll(false));
els.btnRestoreLocal?.addEventListener('click', () => restoreLastLocalAccount());
els.btnSwitchRecommended?.addEventListener('click', () => switchRecommendedMember());

els.list.addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-action]');
  const bill = event.target.closest('[data-action="bill"]');
  const card = event.target.closest('.account');
  const id = card?.dataset.id;
  if (!id) return;

  // 点账单行进详情日用量%图，避免整卡跳转丢锚点。
  if (bill) {
    event.stopPropagation();
    location.href = `/detail.html?id=${encodeURIComponent(id)}#usage-percent`;
    return;
  }

  if (btn) {
    event.stopPropagation();
    const action = btn.dataset.action;
    const member = membersCache.find((m) => m.id === id);

    if (action === 'switch') {
      await switchMember(id, btn);
      return;
    }

    if (action === 'refresh') {
      btn.innerHTML = '<span class="spin">↻</span>';
      btn.classList.add('busy');
      btn.disabled = true;
      try {
        await api(`/api/members/${id}/refresh`, { method: 'POST', body: '{}' });
        toast('已刷新');
        await load();
      } catch (e) {
        toast(e.message || String(e));
      } finally {
        btn.classList.remove('busy');
        btn.disabled = false;
        btn.textContent = '↻';
      }
      return;
    }

    if (action === 'edit') {
      if (!isAdmin()) return toast('需要管理员权限');
      openMemberDialog({ id, displayName: member?.displayName || '' });
      return;
    }

    if (action === 'delete') {
      if (!isAdmin()) return toast('需要管理员权限');
      if (!confirm('确定删除该账号？不会影响其 Cursor 订阅。')) return;
      setBusy(btn, true, '删除中…');
      try {
        await api(`/api/members/${id}`, { method: 'DELETE' });
        toast('已删除');
        await load();
      } catch (e) {
        toast(e.message || String(e));
        setBusy(btn, false);
      }
    }
    return;
  }

  location.href = `/detail.html?id=${encodeURIComponent(id)}`;
});

applySettingsToForm();
ensurePasswordPolicy()
  .then(() => load())
  .catch((e) => toast(e.message || String(e)));
