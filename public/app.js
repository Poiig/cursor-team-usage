/**
 * 多账号列表：紧凑卡片、隐私模式、导出；详情跳转独立页面。
 */

import {
  accountIdentity,
  api,
  createToast,
  daysUntil,
  downloadText,
  escapeHtml,
  formatDateTimeDot,
  formatTokens,
  loadSettings,
  money,
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
  tabHelp: document.getElementById('tabHelp'),
  btnAdd: document.getElementById('btnAdd'),
  btnEmptyAdd: document.getElementById('btnEmptyAdd'),
  btnImportInDialog: document.getElementById('btnImportInDialog'),
  btnRefreshAll: document.getElementById('btnRefreshAll'),
  btnExport: document.getElementById('btnExport'),
  btnForceChangePassword: document.getElementById('btnForceChangePassword'),
  btnLogout: document.getElementById('btnLogout'),
  btnHelp: document.getElementById('btnHelp'),
  btnSaveMember: document.getElementById('btnSaveMember'),
  btnDialogClose: document.getElementById('btnDialogClose'),
  btnDialogCancel: document.getElementById('btnDialogCancel'),
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

function memberStatus(member) {
  if (member.lastError && !member.lastSnapshot) return 'error';
  if (!member.lastSnapshot) return 'pending';
  if ((usedPercent(member) ?? 0) >= 80) return 'warn';
  return 'ok';
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
  if (days <= 2) return 'danger';
  if (days <= 7) return 'warn';
  return 'neutral';
}

function chipClassForTokenExp(iso) {
  const days = daysUntil(iso);
  if (days == null) return 'neutral';
  if (days <= 0) return 'danger';
  if (days <= 2) return 'warn';
  return 'neutral';
}

/** 紧凑色块：剩余额度 / 额度重置时间 / Token 有效时间。 */
function metaChips(member) {
  const remain = remainingPercent(member);
  const resetIso = member.lastSnapshot?.window?.resetIso;
  const resetText = formatDateTimeDot(resetIso);
  const resetDays = daysUntil(resetIso);
  const tokenExpText = formatDateTimeDot(member.tokenExpiresAt);
  const remainChip =
    remain == null
      ? ''
      : `<span class="chip ${chipClassForRemaining(remain)}" title="剩余额度 ${remain.toFixed(1)}%">${remain.toFixed(0)}%</span>`;
  const resetChip =
    resetText == null
      ? ''
      : `<span class="chip ${chipClassForDays(resetDays)}" title="额度重置时间">${escapeHtml(resetText)}</span>`;
  const tokenChip =
    tokenExpText == null
      ? ''
      : `<span class="chip ${chipClassForTokenExp(member.tokenExpiresAt)}" title="会话 Token 有效至">Token ${escapeHtml(tokenExpText)}</span>`;
  return `${remainChip}${resetChip}${tokenChip}`;
}

function renderProgressLine(line) {
  const used = Number(line.used) || 0;
  const limit = Number(line.limit) || 100;
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  let valueText;
  if (line.format === 'percent') valueText = `${used.toFixed(1)}%`;
  else if (line.format === 'dollars') valueText = `$${used.toFixed(2)} / $${limit.toFixed(2)}`;
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
  const cell = (label, part) => `
    <div class="spend-cell">
      <span class="k">${label}</span>
      <span class="v" title="${escapeHtml(part?.text || 'No data')}">${escapeHtml(part?.text || 'No data')}</span>
    </div>
  `;
  return `
    <div class="spend-row">
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
  const status = memberStatus(member);
  const plan = snap?.plan?.planName || snap?.plan?.membershipType || 'unknown';
  const statusBadge =
    status === 'error'
      ? '<span class="badge danger">失败</span>'
      : status === 'warn'
        ? '<span class="badge warn">偏高</span>'
        : status === 'ok'
          ? '<span class="badge ok">正常</span>'
          : '<span class="badge muted">待同步</span>';

  const idn = accountIdentity(member, settings.privacyMode);
  const err = member.lastError
    ? `<div class="error-box">${escapeHtml(member.lastError)}</div>`
    : '';

  const { progress, spend } = splitLines(snap?.panelLines, { includeGrok: false });
  const meters =
    progress.length > 0
      ? `<div class="panel-lines">${progress.map(renderProgressLine).join('')}</div>`
      : `<p class="muted" style="margin-top:10px">尚无面板数据</p>`;
  const spendHtml = spend ? renderSpendRow(spend) : '';

  return `
    <article class="account" data-id="${member.id}">
      <div class="account-top">
        <div class="account-id">
          <div class="account-title">
            <span class="account-name">${escapeHtml(idn.title)}</span>
            ${idn.subtitle ? `<span class="account-sub">${escapeHtml(idn.subtitle)}</span>` : ''}
          </div>
          <div class="badges">
            <span class="badge plan">${escapeHtml(plan)}</span>
            ${statusBadge}
            ${metaChips(member)}
          </div>
        </div>
        <div class="account-actions">
          <button type="button" class="btn icon" data-action="refresh" title="刷新">↻</button>
          <button type="button" class="btn icon" data-action="edit" title="更新 Token">✎</button>
          <button type="button" class="btn sm danger" data-action="delete">删除</button>
        </div>
      </div>
      ${err}
      ${meters}
      ${spendHtml}
    </article>
  `;
}

function renderSummary(summary) {
  const s = summary || {
    memberCount: 0,
    cycleBilledDollars: 0,
    cycleRequests: 0,
    cycleTokens: 0,
    syncedOk: 0,
    syncedError: 0,
  };
  els.summary.innerHTML = `
    <article class="stat"><p class="label">账号</p><p class="value">${s.memberCount}</p><p class="note">${money(s.cycleBilledDollars)} credits</p></article>
    <article class="stat"><p class="label">额度 / 用量</p><p class="value">${s.cycleRequests ?? 0}</p><p class="note">${formatTokens(s.cycleTokens)} tokens</p></article>
    <article class="stat"><p class="label">正常</p><p class="value">${s.syncedOk ?? 0}</p><p class="note">已完成同步</p></article>
    <article class="stat"><p class="label">失败</p><p class="value ${(s.syncedError || 0) > 0 ? 'danger' : ''}">${s.syncedError ?? 0}</p><p class="note">需更新 Token</p></article>
  `;
}

function filteredMembers() {
  const q = (els.searchInput.value || '').trim().toLowerCase();
  const sort = els.sortBy?.value || 'name';
  const list = membersCache.filter((m) => {
    if (!q) return true;
    return `${m.displayName} ${m.email || ''} ${m.userId || ''}`.toLowerCase().includes(q);
  });
  list.sort((a, b) => {
    if (sort === 'remaining') {
      const ar = remainingPercent(a);
      const br = remainingPercent(b);
      if (ar == null && br == null) return 0;
      if (ar == null) return 1;
      if (br == null) return -1;
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

function renderList() {
  renderSummary(summaryCache);
  const list = filteredMembers();
  els.empty.classList.toggle('hidden', membersCache.length > 0);
  els.list.innerHTML = list.map(renderAccountRow).join('');
}

function showView(view) {
  els.tabAccounts.classList.toggle('hidden', view !== 'accounts');
  els.tabHelp.classList.toggle('hidden', view !== 'help');
  // 说明页不需要顶部汇总条。
  if (els.summary) els.summary.classList.toggle('hidden', view !== 'accounts');
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === view);
  });
}

async function load() {
  const data = await api('/api/members');
  membersCache = data.members || [];
  summaryCache = data.summary || {};
  renderList();
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

/** 启动时检查是否须强制改密。 */
async function ensurePasswordPolicy() {
  try {
    const me = await api('/api/auth/me');
    if (els.currentUsername) els.currentUsername.textContent = me.username || '—';
    forcePasswordRequired = Boolean(me.mustChangePassword);
    if (forcePasswordRequired || sessionStorage.getItem('ctu_force_password') === '1') {
      openForcePasswordDialog();
    }
  } catch {
    /* 未登录时由 api 跳转登录页 */
  }
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
    showView(btn.dataset.tab === 'help' ? 'help' : 'accounts');
  });
});

els.btnHelp.addEventListener('click', () => showView('help'));
els.btnAdd.addEventListener('click', () => openMemberDialog());
els.btnEmptyAdd.addEventListener('click', () => openMemberDialog());
els.btnDialogClose.addEventListener('click', closeMemberDialog);
els.btnDialogCancel.addEventListener('click', closeMemberDialog);
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

els.list.addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-action]');
  const card = event.target.closest('.account');
  const id = card?.dataset.id;
  if (!id) return;

  if (btn) {
    event.stopPropagation();
    const action = btn.dataset.action;
    const member = membersCache.find((m) => m.id === id);

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
      openMemberDialog({ id, displayName: member?.displayName || '' });
      return;
    }

    if (action === 'delete') {
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
