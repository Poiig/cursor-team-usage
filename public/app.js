/**
 * 多账号看板：紧凑列表、额度进度条与账号详情图表。
 */

const els = {
  summary: document.getElementById('summary'),
  list: document.getElementById('memberList'),
  empty: document.getElementById('emptyState'),
  dialog: document.getElementById('memberDialog'),
  displayName: document.getElementById('fieldDisplayName'),
  sessionToken: document.getElementById('fieldSessionToken'),
  dialogTitle: document.getElementById('dialogTitle'),
  toast: document.getElementById('toast'),
  searchInput: document.getElementById('searchInput'),
  filterStatus: document.getElementById('filterStatus'),
  sortBy: document.getElementById('sortBy'),
  autoRefresh: document.getElementById('autoRefresh'),
  autoRefreshHint: document.getElementById('autoRefreshHint'),
  tabAccounts: document.getElementById('tabAccounts'),
  tabHelp: document.getElementById('tabHelp'),
  tabDetail: document.getElementById('tabDetail'),
  detailTitle: document.getElementById('detailTitle'),
  detailSub: document.getElementById('detailSub'),
  detailMeters: document.getElementById('detailMeters'),
  chartSpend: document.getElementById('chartSpend'),
  chartTokens: document.getElementById('chartTokens'),
  chartModels: document.getElementById('chartModels'),
  btnBackList: document.getElementById('btnBackList'),
  btnDetailRefresh: document.getElementById('btnDetailRefresh'),
  btnAdd: document.getElementById('btnAdd'),
  btnEmptyAdd: document.getElementById('btnEmptyAdd'),
  btnEmptyImport: document.getElementById('btnEmptyImport'),
  btnImportLocal: document.getElementById('btnImportLocal'),
  btnImportInDialog: document.getElementById('btnImportInDialog'),
  btnRefreshAll: document.getElementById('btnRefreshAll'),
  btnHelp: document.getElementById('btnHelp'),
  btnSaveMember: document.getElementById('btnSaveMember'),
  btnDialogClose: document.getElementById('btnDialogClose'),
  btnDialogCancel: document.getElementById('btnDialogCancel'),
};

/** @type {object[]} */
let membersCache = [];
/** @type {object | null} */
let summaryCache = null;
/** @type {{ id?: string } | null} */
let editing = null;
/** @type {string | null} */
let detailMemberId = null;
/** @type {ReturnType<typeof setInterval> | null} */
let autoRefreshTimer = null;
let refreshingAll = false;

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.add('hidden'), 3600);
}

function setBusy(btn, busy, busyLabel) {
  if (!btn) return;
  if (busy) {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent || '';
    btn.classList.add('busy');
    btn.disabled = true;
    if (busyLabel) btn.innerHTML = `<span class="spin">↻</span> ${busyLabel}`;
  } else {
    btn.classList.remove('busy');
    btn.disabled = false;
    if (btn.dataset.label != null) {
      btn.textContent = btn.dataset.label;
      delete btn.dataset.label;
    }
  }
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function money(n, digits = 2) {
  if (n == null || Number.isNaN(n)) return '—';
  return `$${Number(n).toFixed(digits)}`;
}

function formatTokens(n) {
  if (n == null || !Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

function daysUntil(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const ms = t - Date.now();
  if (ms <= 0) return 0;
  return Math.max(1, Math.ceil(ms / 86400000));
}

function accountIdentity(member) {
  const email = member.email || '';
  const name = (member.displayName || '').trim();
  const same =
    name &&
    email &&
    (name.toLowerCase() === email.toLowerCase() ||
      name.toLowerCase() === email.split('@')[0].toLowerCase());
  if (name && !same) return { title: name, subtitle: email || member.userId || '' };
  if (email) return { title: email, subtitle: '' };
  return { title: name || member.userId || '未命名', subtitle: '' };
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

/**
 * 紧凑色块：剩余额度 / 剩余天数，避免长文案撑破布局。
 */
function metaChips(member) {
  const remain = remainingPercent(member);
  const days = daysUntil(member.lastSnapshot?.window?.resetIso);
  const remainChip =
    remain == null
      ? ''
      : `<span class="chip ${chipClassForRemaining(remain)}" title="剩余额度 ${remain.toFixed(1)}%">${remain.toFixed(0)}%</span>`;
  const daysChip =
    days == null
      ? ''
      : `<span class="chip ${chipClassForDays(days)}" title="距重置还有 ${days} 天">${days}d</span>`;
  return `${remainChip}${daysChip}`;
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
      // 列表页隐藏 Grok，详情页再展示，避免占行。
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

  const idn = accountIdentity(member);
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
          <button type="button" class="btn sm" data-action="test">测试</button>
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
  const status = els.filterStatus.value;
  const sort = els.sortBy?.value || 'name';
  const list = membersCache.filter((m) => {
    if (status !== 'all' && memberStatus(m) !== status) return false;
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
    if (sort === 'used') return (usedPercent(b) ?? -1) - (usedPercent(a) ?? -1);
    if (sort === 'reset') return resetMs(a) - resetMs(b);
    return String(a.displayName || '').localeCompare(String(b.displayName || ''), 'zh');
  });
  return list;
}

function renderList() {
  renderSummary(summaryCache);
  const members = filteredMembers();
  if (!membersCache.length) {
    els.list.innerHTML = '';
    els.empty.classList.remove('hidden');
    return;
  }
  els.empty.classList.add('hidden');
  if (!members.length) {
    els.list.innerHTML = `<div class="empty"><p>没有符合筛选条件的账号</p></div>`;
    return;
  }
  els.list.innerHTML = members.map(renderAccountRow).join('');
}

/**
 * 轻量 SVG 柱状图，避免引入 Chart.js 依赖。
 * @param {HTMLElement} el
 * @param {Array<{ label: string, value: number }>} points
 * @param {string} color
 */
function renderBarChart(el, points, color) {
  if (!el) return;
  const vals = points.map((p) => p.value);
  const max = Math.max(...vals, 0);
  if (!points.length || max <= 0) {
    el.innerHTML = `<div class="chart-empty">No data</div>`;
    return;
  }
  const w = 600;
  const h = 180;
  const padL = 8;
  const padR = 8;
  const padT = 12;
  const padB = 28;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const gap = 2;
  const barW = Math.max(2, (innerW - gap * (points.length - 1)) / points.length);

  const bars = points
    .map((p, i) => {
      const bh = (p.value / max) * innerH;
      const x = padL + i * (barW + gap);
      const y = padT + innerH - bh;
      const title = `${p.label}: ${p.value}`;
      return `<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(bh, 1)}" rx="1.5" fill="${color}"><title>${escapeHtml(title)}</title></rect>`;
    })
    .join('');

  const labels = [0, Math.floor(points.length / 2), points.length - 1]
    .filter((i, idx, arr) => arr.indexOf(i) === idx)
    .map((i) => {
      const x = padL + i * (barW + gap) + barW / 2;
      const label = points[i]?.label?.slice(5) || ''; // MM-DD
      return `<text x="${x}" y="${h - 8}" text-anchor="middle" fill="currentColor" font-size="10" opacity="0.65">${escapeHtml(label)}</text>`;
    })
    .join('');

  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img">${bars}${labels}</svg>`;
}

function renderHorizontalBars(el, items, color) {
  if (!el) return;
  if (!items.length) {
    el.innerHTML = `<div class="chart-empty">No data</div>`;
    return;
  }
  const max = Math.max(...items.map((i) => i.value), 1);
  el.innerHTML = `
    <div style="display:grid;gap:8px;padding-top:4px">
      ${items
        .map(
          (item) => `
        <div>
          <div class="panel-line-head">
            <span class="panel-line-label">${escapeHtml(item.label)}</span>
            <span class="panel-line-value">${item.value}</span>
          </div>
          <div class="panel-track"><div class="panel-fill" style="width:${(item.value / max) * 100}%;background:${color}"></div></div>
        </div>`,
        )
        .join('')}
    </div>
  `;
}

function showView(view) {
  els.tabAccounts.classList.toggle('hidden', view !== 'accounts');
  els.tabHelp.classList.toggle('hidden', view !== 'help');
  els.tabDetail.classList.toggle('hidden', view !== 'detail');
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === (view === 'detail' ? 'accounts' : view));
  });
}

function openDetail(memberId) {
  const member = membersCache.find((m) => m.id === memberId);
  if (!member) return;
  detailMemberId = memberId;
  const idn = accountIdentity(member);
  const snap = member.lastSnapshot;
  els.detailTitle.textContent = idn.title;
  els.detailSub.textContent = [
    snap?.plan?.planName || snap?.plan?.membershipType || '',
    idn.subtitle,
    member.lastSyncedAt ? `同步 ${new Date(member.lastSyncedAt).toLocaleString('zh-CN')}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const { progress, spend } = splitLines(snap?.panelLines, { includeGrok: true });
  els.detailMeters.innerHTML =
    progress.map(renderProgressLine).join('') + (spend ? renderSpendRow(spend) : '');

  const daily = snap?.spend?.daily || [];
  renderBarChart(
    els.chartSpend,
    daily.map((d) => ({ label: d.date, value: d.dollars || 0 })),
    '#2dd4bf',
  );
  renderBarChart(
    els.chartTokens,
    daily.map((d) => ({ label: d.date, value: d.tokens || 0 })),
    '#4daafc',
  );
  const models = (snap?.usage?.topModels || []).slice(0, 8);
  renderHorizontalBars(
    els.chartModels,
    models.map((m) => ({ label: m.model, value: m.count })),
    '#a78bfa',
  );

  showView('detail');
}

async function load() {
  const data = await api('/api/members');
  membersCache = data.members || [];
  summaryCache = data.summary || {};
  renderList();
  if (detailMemberId && !els.tabDetail.classList.contains('hidden')) {
    openDetail(detailMemberId);
  }
}

async function refreshAll(silent = false) {
  if (refreshingAll) return;
  refreshingAll = true;
  setBusy(els.btnRefreshAll, true, '刷新中…');
  try {
    await api('/api/refresh-all', { method: 'POST', body: '{}' });
    await load();
    toast(silent ? '已自动刷新' : '全部账号已刷新');
    updateAutoRefreshHint(true);
  } catch (e) {
    toast(e.message || String(e));
  } finally {
    refreshingAll = false;
    setBusy(els.btnRefreshAll, false);
  }
}

function updateAutoRefreshHint(justRan = false) {
  if (!els.autoRefreshHint) return;
  const sec = Number(els.autoRefresh?.value || 0);
  if (!sec) {
    els.autoRefreshHint.textContent = '自动刷新已关闭';
    return;
  }
  const mins = sec / 60;
  els.autoRefreshHint.textContent = justRan
    ? `已刷新 · 下一次约 ${mins} 分钟后`
    : `自动刷新：每 ${mins} 分钟`;
}

function setupAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  const sec = Number(els.autoRefresh?.value || 0);
  updateAutoRefreshHint(false);
  if (!sec) return;
  autoRefreshTimer = setInterval(() => {
    if (document.hidden) return;
    refreshAll(true);
  }, sec * 1000);
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
    detailMemberId = null;
    showView(btn.dataset.tab === 'help' ? 'help' : 'accounts');
  });
});

els.btnHelp.addEventListener('click', () => showView('help'));
els.btnBackList.addEventListener('click', () => {
  detailMemberId = null;
  showView('accounts');
});
els.btnAdd.addEventListener('click', () => openMemberDialog());
els.btnEmptyAdd.addEventListener('click', () => openMemberDialog());
els.btnDialogClose.addEventListener('click', closeMemberDialog);
els.btnDialogCancel.addEventListener('click', closeMemberDialog);
els.searchInput.addEventListener('input', renderList);
els.filterStatus.addEventListener('change', renderList);
els.sortBy?.addEventListener('change', renderList);
els.autoRefresh?.addEventListener('change', setupAutoRefresh);

els.btnImportLocal.addEventListener('click', async () => {
  setBusy(els.btnImportLocal, true, '导入中…');
  try {
    await importLocalCursor();
  } catch (e) {
    toast(e.message || String(e));
  } finally {
    setBusy(els.btnImportLocal, false);
  }
});

els.btnEmptyImport.addEventListener('click', async () => {
  setBusy(els.btnEmptyImport, true, '导入中…');
  try {
    await importLocalCursor();
  } catch (e) {
    toast(e.message || String(e));
  } finally {
    setBusy(els.btnEmptyImport, false);
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
  if (!editing?.id && !sessionToken) return toast('请粘贴会话 Token，或改用「从本机 Cursor 导入」');

  setBusy(els.btnSaveMember, true, '保存中…');
  try {
    if (editing?.id) {
      const body = { displayName };
      if (sessionToken) body.sessionToken = sessionToken;
      await api(`/api/members/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      if (sessionToken) await api(`/api/members/${editing.id}/refresh`, { method: 'POST', body: '{}' });
      toast('账号已更新');
    } else {
      await api('/api/members', { method: 'POST', body: JSON.stringify({ displayName, sessionToken }) });
      toast('账号已添加并完成首次同步');
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

els.btnDetailRefresh.addEventListener('click', async () => {
  if (!detailMemberId) return;
  setBusy(els.btnDetailRefresh, true, '刷新中…');
  try {
    await api(`/api/members/${detailMemberId}/refresh`, { method: 'POST', body: '{}' });
    await load();
    toast('已刷新');
  } catch (e) {
    toast(e.message || String(e));
  } finally {
    setBusy(els.btnDetailRefresh, false);
  }
});

els.list.addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-action]');
  const card = event.target.closest('.account');
  const id = card?.dataset.id;
  if (!id) return;

  if (btn) {
    event.stopPropagation();
    const action = btn.dataset.action;
    const member = membersCache.find((m) => m.id === id);

    if (action === 'refresh' || action === 'test') {
      if (action === 'refresh') {
        btn.innerHTML = '<span class="spin">↻</span>';
        btn.classList.add('busy');
        btn.disabled = true;
      } else setBusy(btn, true, '测试中…');
      try {
        const data = await api(`/api/members/${id}/refresh`, { method: 'POST', body: '{}' });
        toast(
          action === 'test'
            ? data.member?.lastError
              ? `测试失败：${data.member.lastError}`
              : '测试通过'
            : '已刷新',
        );
        await load();
      } catch (e) {
        toast(e.message || String(e));
      } finally {
        if (action === 'refresh') {
          btn.classList.remove('busy');
          btn.disabled = false;
          btn.textContent = '↻';
        } else setBusy(btn, false);
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

  openDetail(id);
});

load()
  .then(() => setupAutoRefresh())
  .catch((e) => toast(e.message || String(e)));
