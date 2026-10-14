/**
 * 账号详情页：面板指标、图表，以及官方同源逐次请求表。
 */

import {
  accountIdentity,
  api,
  computeUsagePace,
  createToast,
  dailyPercentDeltaPoints,
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
  formatTokensWan,
  loadSettings,
  money,
  planBadgeClass,
  resolveSpendRow,
  setBusy,
} from './shared.js';

const params = new URLSearchParams(location.search);
const memberId = params.get('id');
const settings = loadSettings();
const toast = createToast(document.getElementById('toast'));

const els = {
  title: document.getElementById('detailTitle'),
  sub: document.getElementById('detailSub'),
  meta: document.getElementById('detailMeta'),
  meters: document.getElementById('detailMeters'),
  pace: document.getElementById('detailPace'),
  chartSpend: document.getElementById('chartSpend'),
  chartTokens: document.getElementById('chartTokens'),
  chartUsagePercent: document.getElementById('chartUsagePercent'),
  chartTodayModels: document.getElementById('chartTodayModels'),
  chartModels: document.getElementById('chartModels'),
  eventsDays: document.getElementById('eventsDays'),
  eventsModel: document.getElementById('eventsModel'),
  eventsHint: document.getElementById('eventsHint'),
  usageBody: document.getElementById('usageBody'),
  usageTableWrap: document.getElementById('usageTableWrap'),
  eventsScrollSentinel: document.getElementById('eventsScrollSentinel'),
  btnRefresh: document.getElementById('btnDetailRefresh'),
  btnLoadEvents: document.getElementById('btnLoadEvents'),
  btnExportCsv: document.getElementById('btnExportCsv'),
};

/** @type {object | null} */
let member = null;
/** @type {object[]} */
let eventsCache = [];
let eventsPage = 1;
let eventsTotal = 0;
let eventsTotalTokens = 0;
let hasNextPage = false;
let eventsLoading = false;
/** @type {string | null} */
let eventsSyncedAt = null;
/** @type {IntersectionObserver | null} */
let eventsScrollObserver = null;
function fillClass(pct) {
  if (pct == null) return '';
  if (pct >= 95) return 'danger';
  if (pct >= 80) return 'warn';
  return '';
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
  return `
    <div class="spend-row">
      ${cell('Today', line.today)}
      ${cell('Yesterday', line.yesterday)}
      ${cell('Last 30 Days', line.last30)}
    </div>
  `;
}

function splitLines(lines) {
  const progress = [];
  let spend = null;
  for (const line of lines || []) {
    if (line.type === 'spend-row') spend = line;
    else if (line.type === 'progress') progress.push(line);
  }
  return { progress, spend };
}

/**
 * 柱状图：Y 轴刻度 + 悬停 tooltip，否则只有相对柱高读不出具体数。
 * @param {HTMLElement | null} el
 * @param {Array<{ label: string, value: number }>} points
 * @param {string} color
 * @param {(v: number) => string} [formatValue]
 */
function renderBarChart(el, points, color, formatValue = (v) => String(v)) {
  if (!el) return;
  if (!points.length) {
    el.innerHTML = `<div class="chart-empty">No data</div>`;
    return;
  }
  const w = 640;
  const h = 180;
  const padL = 52;
  const padR = 16;
  const padT = 16;
  const padB = 28;
  const max = Math.max(...points.map((p) => p.value), 1);
  const plotH = h - padT - padB;
  const plotW = w - padL - padR;
  const bw = plotW / points.length;
  const fmt = (v) => formatValue(Number(v) || 0);
  const yTicks = [0, 0.5, 1].map((t) => {
    const val = max * t;
    const y = padT + plotH * (1 - t);
    return `
      <line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="currentColor" opacity="0.08" />
      <text x="${padL - 6}" y="${y + 3}" text-anchor="end" fill="currentColor" font-size="10" opacity="0.65">${escapeHtml(fmt(val))}</text>
    `;
  }).join('');
  const bars = points
    .map((p, i) => {
      const value = Number(p.value) || 0;
      const bh = Math.max(1, (value / max) * plotH);
      const x = padL + i * bw + bw * 0.15;
      const y = padT + plotH - bh;
      const tip = `${p.label} · ${fmt(value)}`;
      return `<rect class="chart-bar" x="${x}" y="${y}" width="${bw * 0.7}" height="${bh}" fill="${color}" rx="2" data-tip="${escapeHtml(tip)}"></rect>`;
    })
    .join('');
  const labels = points
    .map((p, i) => {
      if (points.length > 16 && i % 5 !== 0 && i !== points.length - 1) return '';
      const x = padL + i * bw + bw / 2;
      const label = String(p.label || '').slice(5);
      return `<text x="${x}" y="${h - 8}" text-anchor="middle" fill="currentColor" font-size="10" opacity="0.65">${escapeHtml(label)}</text>`;
    })
    .join('');
  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" role="img">${yTicks}${bars}${labels}</svg>
    <div class="chart-tooltip" hidden></div>
  `;
  const tipEl = el.querySelector('.chart-tooltip');
  /** 相对 chart-box 定位，避免 SVG rect 的 offset 坐标系不一致。 */
  const placeTip = (ev) => {
    if (!tipEl) return;
    const box = el.getBoundingClientRect();
    tipEl.style.left = `${ev.clientX - box.left + 12}px`;
    tipEl.style.top = `${ev.clientY - box.top - 8}px`;
  };
  el.querySelectorAll('.chart-bar').forEach((bar) => {
    bar.addEventListener('pointerenter', (ev) => {
      if (!tipEl) return;
      tipEl.hidden = false;
      tipEl.textContent = bar.getAttribute('data-tip') || '';
      placeTip(ev);
    });
    bar.addEventListener('pointermove', placeTip);
    bar.addEventListener('pointerleave', () => {
      if (tipEl) tipEl.hidden = true;
    });
  });
}

/**
 * 横向条：右侧数值可格式化（当日模型用 tokens 万/亿，周期 Top 用次数）。
 * @param {HTMLElement | null} el
 * @param {Array<{ label: string, value: number }>} items
 * @param {string} color
 * @param {(v: number) => string} [formatValue]
 */
function renderHorizontalBars(el, items, color, formatValue = (v) => String(v)) {
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
            <span class="panel-line-value">${escapeHtml(formatValue(item.value))}</span>
          </div>
          <div class="panel-track"><div class="panel-fill" style="width:${(item.value / max) * 100}%;background:${color}"></div></div>
        </div>`,
        )
        .join('')}
    </div>
  `;
}

/** 用量事件时间：毫秒时间戳 → 本地 yyyy-MM-dd HH.mm（与看板其它时间列一致）。 */
function formatEventDate(timestamp) {
  let ms = Number(timestamp);
  if (!Number.isFinite(ms)) ms = Date.parse(String(timestamp));
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1e12) ms *= 1000;
  return formatDateTimeDot(new Date(ms).toISOString()) || '—';
}

function eventRowHtml(e) {
  const tokens =
    e.isTokenBasedCall === false && !(e.totalTokens > 0)
      ? '—'
      : formatTokensWan(e.totalTokens);
  return `
      <tr>
        <td>${escapeHtml(formatEventDate(e.timestamp))}</td>
        <td>${escapeHtml(e.kindLabel || '—')}</td>
        <td>${escapeHtml(e.model || '—')}</td>
        <td>${escapeHtml(tokens)}</td>
        <td>${escapeHtml(e.costLabel || '—')}</td>
      </tr>`;
}

function renderEventsTable(events, { append = false } = {}) {
  if (!append) {
    if (!events.length) {
      els.usageBody.innerHTML = `<tr><td colspan="5" class="muted">该时间范围内无请求</td></tr>`;
      return;
    }
    els.usageBody.innerHTML = events.map(eventRowHtml).join('');
    return;
  }
  if (!events.length) return;
  els.usageBody.insertAdjacentHTML('beforeend', events.map(eventRowHtml).join(''));
}

function updateEventsMeta() {
  const days = Number(els.eventsDays.value || 1);
  const model = String(els.eventsModel?.value || '').trim();
  const modelNote = model ? ` · ${model}` : '';
  const syncNote = eventsSyncedAt
    ? ` · 同步 ${formatDateTimeDot(eventsSyncedAt) || eventsSyncedAt}`
    : '';
  const rangeLabel = days === 1 ? '今天' : `近 ${days} 天`;
  const tokensNote = ` · 总 ${formatTokens(eventsTotalTokens)} tokens`;
  els.eventsHint.textContent = `${rangeLabel}${modelNote} · 已显示 ${eventsCache.length} / ${eventsTotal} 条${tokensNote}${syncNote}`;
}

/**
 * 用接口返回的 models 填充下拉；保留当前选中项（若仍在列表中）。
 * @param {string[]} models
 */
function fillEventsModelOptions(models) {
  if (!els.eventsModel) return;
  const prev = String(els.eventsModel.value || '');
  const opts = ['<option value="">全部模型</option>'].concat(
    (models || []).map(
      (m) => `<option value="${escapeHtml(m)}"${m === prev ? ' selected' : ''}>${escapeHtml(m)}</option>`,
    ),
  );
  els.eventsModel.innerHTML = opts.join('');
  if (prev && !(models || []).includes(prev)) {
    els.eventsModel.value = '';
  }
}

/** 表格容器触底自动加载下一页。 */
function setupEventsInfiniteScroll() {
  if (!els.eventsScrollSentinel || !els.usageTableWrap || eventsScrollObserver) return;
  eventsScrollObserver = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      if (!hasNextPage || eventsLoading) return;
      loadEvents({ reset: false });
    },
    { root: els.usageTableWrap, rootMargin: '80px', threshold: 0 },
  );
  eventsScrollObserver.observe(els.eventsScrollSentinel);
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

/** 详情页元信息：有效期/Token/更新时间（更新不放在列表头部）。 */
function renderDetailMeta(member) {
  const resetIso = member.lastSnapshot?.window?.resetIso;
  const resetText = formatDateTimeDot(resetIso);
  const resetDays = daysUntil(resetIso);
  const tokenExpText = formatDateTimeDot(member.tokenExpiresAt);
  const syncedText = formatDateTimeDot(member.lastSyncedAt);
  const chips = [];
  if (resetText) {
    chips.push(
      `<span class="chip ${chipClassForDays(resetDays)}" title="额度有效期 / 重置时间">${
        resetDays != null ? `${resetDays}天 · ` : ''
      }${escapeHtml(resetText)}</span>`,
    );
  }
  if (tokenExpText) {
    chips.push(
      `<span class="chip ${chipClassForTokenExp(member.tokenExpiresAt)}" title="会话 Token 有效至">Token ${escapeHtml(tokenExpText)}</span>`,
    );
  }
  if (syncedText) {
    chips.push(
      `<span class="chip neutral" title="上次用量更新时间">更新 ${escapeHtml(syncedText)}</span>`,
    );
  }
  return chips.join('');
}

function renderMember() {
  if (!member) return;
  const idn = accountIdentity(member, settings.privacyMode);
  const snap = member.lastSnapshot;
  els.title.textContent = idn.title;
  els.sub.textContent = idn.subtitle || '';
  const planRaw = snap?.plan?.planName || snap?.plan?.membershipType || '';
  const planBadge = planRaw
    ? `<span class="badge plan ${planBadgeClass(planRaw)}">${escapeHtml(formatPlanLabel(planRaw))}</span>`
    : '';
  if (els.meta) els.meta.innerHTML = planBadge + renderDetailMeta(member);

  const pace = computeUsagePace(member);
  if (els.pace) {
    if (!pace) {
      els.pace.classList.add('hidden');
      els.pace.innerHTML = '';
    } else {
      els.pace.classList.remove('hidden');
      const badgeClass =
        pace.status === 'danger' ? 'danger' : pace.status === 'warn' ? 'warn' : 'ok';
      els.pace.innerHTML = `
        <div class="pace-head">
          <h3>用量节奏预警</h3>
          <span class="badge ${badgeClass}">${escapeHtml(pace.label)}</span>
        </div>
        <p class="muted pace-summary">${escapeHtml(pace.summary)}</p>
        <ul class="pace-facts">
          <li>Total usage <strong>${pace.usedPercent}%</strong> ÷ 已过工作日 <strong>${pace.elapsedWorkDays}</strong> = 日均 <strong>${pace.dailyPercent}%</strong>/工作日</li>
          <li>周期工作日合计 <strong>${pace.totalWorkDays}</strong> · 剩余工作日 <strong>${pace.remainingWorkDays}</strong></li>
          <li>剩余额度 <strong>${pace.remainingPercent}%</strong> ÷ 日均 ≈ 可撑 <strong>${pace.daysAffordable == null ? '—' : pace.daysAffordable}</strong> 个工作日</li>
          <li>按此节奏预计期末用量 <strong>${pace.projectedEndPercent}%</strong>（${pace.projectedEndPercent > 100 ? '会超额' : '可覆盖'}）</li>
        </ul>
      `;
    }
  }

  const { progress, spend: panelSpend } = splitLines(snap?.panelLines);
  const spend = resolveSpendRow(snap, panelSpend);
  const history = member.usagePercentHistory;
  els.meters.innerHTML =
    progress.map((line) => renderProgressLine(line, history)).join('') +
    (spend ? renderSpendRow(spend) : '');

  const daily = snap?.spend?.daily || [];
  renderBarChart(
    els.chartSpend,
    daily.map((d) => ({ label: d.date, value: d.dollars || 0 })),
    '#2dd4bf',
    (v) => money(v),
  );
  renderBarChart(
    els.chartTokens,
    daily.map((d) => ({ label: d.date, value: d.tokens || 0 })),
    '#4daafc',
    (v) => (v <= 0 ? '0' : formatTokens(v)),
  );
  // 日用量% = 相邻两日周期累计%之差；需至少两天归档才有柱。
  renderBarChart(
    els.chartUsagePercent,
    dailyPercentDeltaPoints(history, 'total'),
    '#f59e0b',
    (v) => `${Number(v).toFixed(1)}%`,
  );
  const todayModels = (snap?.spend?.todayModels || []).slice(0, 8);
  renderHorizontalBars(
    els.chartTodayModels,
    todayModels.map((m) => ({ label: m.model, value: m.tokens || 0 })),
    '#2dd4bf',
    (v) => (v <= 0 ? '0' : formatTokens(v)),
  );
  const models = (snap?.usage?.topModels || []).slice(0, 8);
  renderHorizontalBars(
    els.chartModels,
    models.map((m) => ({ label: m.model, value: m.count })),
    '#a78bfa',
  );

  if (location.hash === '#usage-percent') {
    document.getElementById('usage-percent')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

async function loadMember() {
  const data = await api(`/api/members/${encodeURIComponent(memberId)}`);
  member = data.member;
  renderMember();
}

/**
 * 读本地缓存事件；reset 时可选 forceSync 打官方增量。
 * @param {{ reset?: boolean, forceSync?: boolean }} [opts]
 */
async function loadEvents({ reset = true, forceSync = false } = {}) {
  if (eventsLoading) return;
  const days = Number(els.eventsDays.value || 1);
  const model = String(els.eventsModel?.value || '').trim();
  if (reset) {
    eventsPage = 1;
    eventsCache = [];
    hasNextPage = false;
    eventsTotal = 0;
    eventsTotalTokens = 0;
    els.usageBody.innerHTML = `<tr><td colspan="5" class="muted">正在加载…</td></tr>`;
  }
  eventsLoading = true;
  setBusy(els.btnLoadEvents, true, forceSync ? '同步中…' : '加载中…');
  try {
    const qs = new URLSearchParams({
      days: String(days),
      page: String(eventsPage),
      pageSize: '50',
    });
    if (model) qs.set('model', model);
    if (forceSync) qs.set('sync', '1');
    const data = await api(
      `/api/members/${encodeURIComponent(memberId)}/usage-events?${qs.toString()}`,
    );
    const batch = data.events || [];
    eventsTotal = Number(data.total) || eventsTotal;
    eventsTotalTokens = Number(data.totalTokens) || eventsTotalTokens;
    hasNextPage = Boolean(data.hasNext);
    eventsSyncedAt = data.syncedAt || eventsSyncedAt;
    if (reset) fillEventsModelOptions(data.models || []);
    if (reset) {
      eventsCache = batch;
      renderEventsTable(eventsCache, { append: false });
    } else {
      eventsCache = eventsCache.concat(batch);
      renderEventsTable(batch, { append: true });
    }
    if (hasNextPage) eventsPage += 1;
    updateEventsMeta();
  } catch (e) {
    if (reset) {
      els.usageBody.innerHTML = `<tr><td colspan="5" class="muted">加载失败：${escapeHtml(e.message || String(e))}</td></tr>`;
    }
    toast(e.message || String(e));
  } finally {
    eventsLoading = false;
    setBusy(els.btnLoadEvents, false);
    updateEventsMeta();
  }
}

function exportCsv() {
  if (!eventsCache.length) {
    toast('请先加载请求明细');
    return;
  }
  const header = ['Date', 'Type', 'Model', 'Tokens', 'Cost'];
  const rows = eventsCache.map((e) => {
    const tokens =
      e.isTokenBasedCall === false && !(e.totalTokens > 0) ? '' : String(e.totalTokens || 0);
    return [
      formatEventDate(e.timestamp),
      e.kindLabel || '',
      e.model || '',
      tokens,
      e.costLabel || '',
    ]
      .map((cell) => `"${String(cell).replaceAll('"', '""')}"`)
      .join(',');
  });
  const csv = [header.join(','), ...rows].join('\n');
  const stamp = new Date().toISOString().slice(0, 10);
  downloadText(`usage-events-${stamp}.csv`, csv, 'text/csv;charset=utf-8');
  toast(`已导出当前已加载的 ${eventsCache.length} 条`);
}

if (!memberId) {
  els.title.textContent = '缺少账号 id';
  els.sub.textContent = '请从列表页点击账号进入';
} else {
  setupEventsInfiniteScroll();
  loadMember()
    .then(() => loadEvents({ reset: true }))
    .catch((e) => toast(e.message || String(e)));
}

els.btnRefresh?.addEventListener('click', async () => {
  setBusy(els.btnRefresh, true, '刷新中…');
  try {
    await api(`/api/members/${encodeURIComponent(memberId)}/refresh`, {
      method: 'POST',
      body: '{}',
    });
    await loadMember();
    await loadEvents({ reset: true });
    toast('已刷新');
  } catch (e) {
    toast(e.message || String(e));
  } finally {
    setBusy(els.btnRefresh, false);
  }
});

els.btnLoadEvents?.addEventListener('click', () => loadEvents({ reset: true, forceSync: true }));
els.eventsDays?.addEventListener('change', () => loadEvents({ reset: true }));
els.eventsModel?.addEventListener('change', () => loadEvents({ reset: true }));
els.btnExportCsv?.addEventListener('click', () => exportCsv());
