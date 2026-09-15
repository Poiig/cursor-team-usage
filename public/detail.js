/**
 * 账号详情页：面板指标、图表，以及官方同源逐次请求表。
 */

import {
  accountIdentity,
  api,
  createToast,
  downloadText,
  escapeHtml,
  formatTokensWan,
  loadSettings,
  setBusy,
} from './shared.js';

const params = new URLSearchParams(location.search);
const memberId = params.get('id');
const settings = loadSettings();
const toast = createToast(document.getElementById('toast'));

const els = {
  title: document.getElementById('detailTitle'),
  sub: document.getElementById('detailSub'),
  meters: document.getElementById('detailMeters'),
  chartSpend: document.getElementById('chartSpend'),
  chartTokens: document.getElementById('chartTokens'),
  chartModels: document.getElementById('chartModels'),
  eventsDays: document.getElementById('eventsDays'),
  eventsHint: document.getElementById('eventsHint'),
  usageBody: document.getElementById('usageBody'),
  btnRefresh: document.getElementById('btnDetailRefresh'),
  btnLoadEvents: document.getElementById('btnLoadEvents'),
  btnLoadMore: document.getElementById('btnLoadMore'),
  btnExportCsv: document.getElementById('btnExportCsv'),
};

/** @type {object | null} */
let member = null;
/** @type {object[]} */
let eventsCache = [];
let eventsPage = 1;
let eventsTotal = 0;
let hasNextPage = false;
let eventsLoading = false;
function fillClass(pct) {
  if (pct == null) return '';
  if (pct >= 95) return 'danger';
  if (pct >= 80) return 'warn';
  return '';
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
      <span class="v">${escapeHtml(part?.text || 'No data')}</span>
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

function splitLines(lines) {
  const progress = [];
  let spend = null;
  for (const line of lines || []) {
    if (line.type === 'spend-row') spend = line;
    else if (line.type === 'progress') progress.push(line);
  }
  return { progress, spend };
}

function renderBarChart(el, points, color) {
  if (!el) return;
  if (!points.length) {
    el.innerHTML = `<div class="chart-empty">No data</div>`;
    return;
  }
  const w = 640;
  const h = 180;
  const pad = 28;
  const max = Math.max(...points.map((p) => p.value), 1);
  const bw = (w - pad * 2) / points.length;
  const bars = points
    .map((p, i) => {
      const bh = Math.max(1, ((p.value || 0) / max) * (h - pad * 2));
      const x = pad + i * bw + bw * 0.15;
      const y = h - pad - bh;
      return `<rect x="${x}" y="${y}" width="${bw * 0.7}" height="${bh}" fill="${color}" rx="2"></rect>`;
    })
    .join('');
  const labels = points
    .map((p, i) => {
      if (points.length > 16 && i % 5 !== 0 && i !== points.length - 1) return '';
      const x = pad + i * bw + bw / 2;
      const label = String(p.label || '').slice(5);
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

/** 官方 Date 列风格：本地时区短日期时间。 */
function formatEventDate(timestamp) {
  let ms = Number(timestamp);
  if (!Number.isFinite(ms)) ms = Date.parse(String(timestamp));
  if (!Number.isFinite(ms)) return '—';
  // 偶发秒级时间戳
  if (ms < 1e12) ms *= 1000;
  const d = new Date(ms);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
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
  const days = Number(els.eventsDays.value || 7);
  els.eventsHint.textContent = `近 ${days} 天 · 已显示 ${eventsCache.length} / ${eventsTotal} 条`;
  if (els.btnLoadMore) els.btnLoadMore.disabled = !hasNextPage || eventsLoading;
}

function renderMember() {
  if (!member) return;
  const idn = accountIdentity(member, settings.privacyMode);
  const snap = member.lastSnapshot;
  els.title.textContent = idn.title;
  els.sub.textContent = [
    snap?.plan?.planName || snap?.plan?.membershipType || '',
    idn.subtitle,
    member.lastSyncedAt ? `同步 ${new Date(member.lastSyncedAt).toLocaleString('zh-CN')}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const { progress, spend } = splitLines(snap?.panelLines);
  els.meters.innerHTML =
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
}

async function loadMember() {
  const data = await api(`/api/members/${encodeURIComponent(memberId)}`);
  member = data.member;
  renderMember();
}

/**
 * 分页拉用量事件；reset=true 从第 1 页重来。
 * @param {{ reset?: boolean }} [opts]
 */
async function loadEvents({ reset = true } = {}) {
  if (eventsLoading) return;
  const days = Number(els.eventsDays.value || 7);
  if (reset) {
    eventsPage = 1;
    eventsCache = [];
    hasNextPage = false;
    eventsTotal = 0;
    els.usageBody.innerHTML = `<tr><td colspan="5" class="muted">正在加载…</td></tr>`;
  }
  eventsLoading = true;
  setBusy(els.btnLoadEvents, true, '加载中…');
  if (els.btnLoadMore) {
    setBusy(els.btnLoadMore, !reset, '加载中…');
    els.btnLoadMore.disabled = true;
  }
  try {
    const data = await api(
      `/api/members/${encodeURIComponent(memberId)}/usage-events?days=${days}&page=${eventsPage}&pageSize=50`,
    );
    const batch = data.events || [];
    eventsTotal = Number(data.total) || eventsTotal;
    hasNextPage = Boolean(data.hasNext);
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
    if (els.btnLoadMore) setBusy(els.btnLoadMore, false);
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

els.btnLoadEvents?.addEventListener('click', () => loadEvents({ reset: true }));
els.btnLoadMore?.addEventListener('click', () => loadEvents({ reset: false }));
els.eventsDays?.addEventListener('change', () => loadEvents({ reset: true }));
els.btnExportCsv?.addEventListener('click', () => exportCsv());
