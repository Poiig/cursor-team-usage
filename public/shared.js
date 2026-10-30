/**
 * 列表页与详情页共用的请求、设置与展示工具。
 */

const SETTINGS_KEY = 'cursor-team-usage.settings';

/** @returns {{ privacyMode: boolean }} */
export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { privacyMode: Boolean(parsed.privacyMode) };
    }
  } catch {
    /* ignore corrupt settings */
  }
  return { privacyMode: true };
}

/**
 * @param {Partial<{ privacyMode: boolean }>} patch
 */
export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  // 只认看板自己的未登录。Cursor 上游 401 没有这个 code，不能把人踢出详情页。
  if (res.status === 401 && data.code === 'UNAUTHORIZED' && !path.startsWith('/api/auth/login')) {
    const next = `${location.pathname}${location.search}`;
    location.href = `/login.html${next === '/' ? '' : `?next=${encodeURIComponent(next)}`}${location.hash}`;
    throw new Error('未登录');
  }
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

/**
 * 切换日志 / 报表：用户名后附别名，如 chenyao（陈瑶）。
 * @param {unknown} username
 * @param {unknown} alias
 */
export function formatOperatorLabel(username, alias) {
  const name = String(username || '').trim() || '—';
  const a = String(alias || '').trim();
  return a ? `${name}（${a}）` : name;
}

export function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function money(n, digits = 2) {
  if (n == null || Number.isNaN(n)) return '—';
  return `$${Number(n).toFixed(digits)}`;
}

/**
 * 各账号快照里的当日模型是分开存的，排行和报表要看团队合计。
 * 同一模型出现在多个账号时，账号数按账号计一次。
 * @param {Array<{ lastSnapshot?: { spend?: { todayModels?: Array<{ model?: string, tokens?: number }> } } }>} members
 * @returns {Array<{ model: string, tokens: number, accounts: number }>}
 */
export function aggregateTodayModels(members) {
  /** @type {Map<string, { tokens: number, accounts: number }>} */
  const byModel = new Map();
  for (const member of members || []) {
    for (const row of member?.lastSnapshot?.spend?.todayModels || []) {
      const model = String(row?.model || '').trim();
      const tokens = Number(row?.tokens) || 0;
      if (!model || tokens <= 0) continue;
      const cur = byModel.get(model) || { tokens: 0, accounts: 0 };
      cur.tokens += tokens;
      cur.accounts += 1;
      byModel.set(model, cur);
    }
  }
  return [...byModel.entries()]
    .map(([model, v]) => ({ model, tokens: v.tokens, accounts: v.accounts }))
    .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));
}

/**
 * 点进某个模型后，要看是哪些账号把这个模型的 tokens 用掉的。
 * @param {Array<{ lastSnapshot?: { spend?: { todayModels?: Array<{ model?: string, tokens?: number }> } } }>} members
 * @param {string} model
 * @returns {Array<{ member: any, tokens: number }>}
 */
export function rankAccountsByTodayModel(members, model) {
  const name = String(model || '').trim();
  if (!name) return [];
  return (members || [])
    .map((member) => {
      const row = (member?.lastSnapshot?.spend?.todayModels || []).find(
        (item) => String(item?.model || '').trim() === name,
      );
      return { member, tokens: Number(row?.tokens) || 0 };
    })
    .filter((row) => row.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
}

export function formatTokens(n) {
  if (n == null || !Number.isFinite(n) || n <= 0) return '—';
  // 中文常见量级：≥1 亿用「亿」，≥1 万用「万」
  if (n >= 1e8) {
    const v = n / 1e8;
    const text = v >= 100 ? v.toFixed(0) : v.toFixed(2).replace(/\.?0+$/, '');
    return `${text}亿`;
  }
  if (n >= 1e4) {
    const v = n / 1e4;
    const text = v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '');
    return `${text}万`;
  }
  return String(Math.round(n));
}

/**
 * Today / Yesterday / Last 30 单元格文案：金额 · 调用次数 · tokens。
 * @param {{ text?: string, dollars?: number | null, tokens?: number | null, requests?: number | null } | null | undefined} part
 */
export function formatSpendPart(part) {
  if (!part || part.text === 'No data') return part?.text || 'No data';
  if (part.requests != null && part.requests > 0 && part.dollars != null) {
    const tokenLabel = formatTokens(part.tokens);
    const tokenText = tokenLabel === '—' ? '0' : tokenLabel;
    return `$${Number(part.dollars).toFixed(2)} · ${part.requests}次 · ${tokenText}`;
  }
  return part.text || 'No data';
}

/**
 * 优先用 snapshot.spend（含 requests）渲染花费行，不依赖 panelLines 旧文案。
 * @param {{ spend?: { today?: object, yesterday?: object, last30?: object } | null } | null | undefined} snap
 * @param {object | null | undefined} panelSpend
 */
export function resolveSpendRow(snap, panelSpend) {
  const s = snap?.spend;
  if (s && (s.today || s.yesterday || s.last30)) {
    return { type: 'spend-row', today: s.today, yesterday: s.yesterday, last30: s.last30 };
  }
  return panelSpend || null;
}

/**
 * 进度条标签 → 日历史字段（Total / Cursor Models / Other Models）。
 * @param {string} label
 * @returns {'total' | 'auto' | 'api' | null}
 */
export function fieldForProgressLabel(label) {
  if (label === 'Total usage') return 'total';
  if (label === 'Cursor Models') return 'auto';
  if (label === 'Other Models') return 'api';
  return null;
}

/**
 * 本地日历「昨天」yyyy-MM-dd，与服务端归档日键一致。
 * @param {number} [nowMs]
 */
export function yesterdayDayKey(nowMs = Date.now()) {
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  const y = new Date(start.getTime() - 86400000);
  const yy = y.getFullYear();
  const mm = String(y.getMonth() + 1).padStart(2, '0');
  const dd = String(y.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * 当前累计% 相对昨日收盘的差值（今日用量）。
 * @param {Array<{ date: string, total?: number | null, auto?: number | null, api?: number | null }> | null | undefined} history
 * @param {'total' | 'auto' | 'api'} field
 * @param {number | null | undefined} current
 * @returns {number | null}
 */
export function deltaVsYesterday(history, field, current) {
  if (current == null || !Number.isFinite(Number(current))) return null;
  const y = (history || []).find((r) => r && r.date === yesterdayDayKey());
  const prev = y?.[field];
  if (prev == null || !Number.isFinite(Number(prev))) return null;
  return Math.round((Number(current) - Number(prev)) * 10) / 10;
}

/**
 * 额度旁「(+x%)」文案；无昨日快照时返回空。
 * @param {number | null | undefined} delta
 */
export function formatDeltaVsYesterday(delta) {
  if (delta == null || !Number.isFinite(delta)) return '';
  const sign = delta > 0 ? '+' : '';
  return `(${sign}${delta.toFixed(1)}%)`;
}

/**
 * 相邻两日累计%之差 → 每日用量柱状图数据。
 * @param {Array<{ date: string, total?: number | null, auto?: number | null, api?: number | null }> | null | undefined} history
 * @param {'total' | 'auto' | 'api'} [field]
 * @returns {Array<{ label: string, value: number }>}
 */
export function dailyPercentDeltaPoints(history, field = 'total') {
  const rows = [...(history || [])]
    .filter((r) => r && r.date && r[field] != null && Number.isFinite(Number(r[field])))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  /** @type {Array<{ label: string, value: number }>} */
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    out.push({
      label: rows[i].date,
      value: Math.round((Number(rows[i][field]) - Number(rows[i - 1][field])) * 10) / 10,
    });
  }
  return out;
}

/**
 * 隐私模式：邮箱中间脱敏，便于投屏/截图。
 * @param {string} email
 */
export function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 0) return s;
  const user = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (user.length <= 2) return `${'*'.repeat(user.length)}@${domain}`;
  return `${user[0]}***${user[user.length - 1]}@${domain}`;
}

export function daysUntil(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const ms = t - Date.now();
  if (ms <= 0) return 0;
  return Math.max(1, Math.ceil(ms / 86400000));
}

/**
 * 统计本地日历 [startMs, endMs] 闭区间内的工作日（周一至周五）。
 * @param {number} startMs
 * @param {number} endMs
 */
export function countWorkingDaysInclusive(startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return 0;
  const cur = new Date(startMs);
  cur.setHours(0, 0, 0, 0);
  const end = new Date(endMs);
  end.setHours(0, 0, 0, 0);
  let n = 0;
  while (cur.getTime() <= end.getTime()) {
    const d = cur.getDay();
    if (d !== 0 && d !== 6) n += 1;
    cur.setDate(cur.getDate() + 1);
  }
  return n;
}

/**
 * 按付费周期工作日节奏预警：日均用量比例 × 剩余工作日，判断能否撑到期末。
 * @param {{ lastSnapshot?: any }} member
 * @param {number} [nowMs]
 * @returns {null | {
 *   usedPercent: number,
 *   elapsedWorkDays: number,
 *   remainingWorkDays: number,
 *   totalWorkDays: number,
 *   dailyPercent: number,
 *   projectedEndPercent: number,
 *   remainingPercent: number,
 *   daysAffordable: number | null,
 *   status: 'ok' | 'warn' | 'danger',
 *   label: string,
 *   summary: string,
 * }}
 */
export function computeUsagePace(member, nowMs = Date.now()) {
  const snap = member?.lastSnapshot;
  if (!snap) return null;
  const usedRaw =
    snap.meters?.totalPercentUsed ??
    snap.meters?.primaryPercent ??
    snap.planMeters?.totalPercentUsed;
  const usedPercent = Number(usedRaw);
  if (!Number.isFinite(usedPercent)) return null;

  const startIso = snap.window?.startIso || snap.planMeters?.billingCycleStart;
  const endIso =
    snap.window?.endIso || snap.window?.resetIso || snap.planMeters?.billingCycleEnd;
  const startMs = startIso ? Date.parse(startIso) : NaN;
  const endMs = endIso ? Date.parse(endIso) : NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;

  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const cycleStart = new Date(startMs);
  cycleStart.setHours(0, 0, 0, 0);
  const cycleEnd = new Date(endMs);
  cycleEnd.setHours(0, 0, 0, 0);

  const elapsedEnd = Math.min(todayMs, cycleEnd.getTime());
  const elapsedWorkDays =
    todayMs < cycleStart.getTime()
      ? 0
      : Math.max(1, countWorkingDaysInclusive(cycleStart.getTime(), elapsedEnd));

  const tomorrow = new Date(todayMs);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const remainingWorkDays =
    tomorrow.getTime() > cycleEnd.getTime()
      ? 0
      : countWorkingDaysInclusive(tomorrow.getTime(), cycleEnd.getTime());

  const totalWorkDays = countWorkingDaysInclusive(cycleStart.getTime(), cycleEnd.getTime());
  const dailyPercent = usedPercent / elapsedWorkDays;
  const remainingPercent = Math.max(0, 100 - usedPercent);
  const projectedEndPercent = Math.round(dailyPercent * totalWorkDays * 10) / 10;
  const daysAffordable =
    dailyPercent > 0 ? Math.round((remainingPercent / dailyPercent) * 10) / 10 : null;

  /** @type {'ok' | 'warn' | 'danger'} */
  let status = 'ok';
  let label = '充足';
  if (remainingWorkDays <= 0) {
    status = usedPercent >= 100 ? 'danger' : 'ok';
    label = usedPercent >= 100 ? '超速' : '充足';
  } else if (daysAffordable == null) {
    status = 'ok';
    label = '充足';
  } else if (daysAffordable < remainingWorkDays) {
    // 按当前节奏撑不到期末：缺口大→超速，否则偏快
    status = daysAffordable < remainingWorkDays * 0.7 ? 'danger' : 'warn';
    label = status === 'danger' ? '超速' : '偏快';
  }

  const dailyText = `${Math.round(dailyPercent * 100) / 100}%`;
  const affordText = daysAffordable == null ? '—' : `${daysAffordable} 个工作日`;
  return {
    usedPercent: Math.round(usedPercent * 10) / 10,
    elapsedWorkDays,
    remainingWorkDays,
    totalWorkDays,
    dailyPercent: Math.round(dailyPercent * 100) / 100,
    projectedEndPercent,
    remainingPercent: Math.round(remainingPercent * 10) / 10,
    daysAffordable,
    status,
    label,
    summary: `日均 ${dailyText}/工作日 · 预计期末 ${projectedEndPercent}% · 剩余可撑 ${affordText}（剩 ${remainingWorkDays} 个工作日）`,
  };
}

/**
 * 有效时间展示：2026-09-16 11.00（本地时区）。
 * @param {string | null | undefined} iso
 */
export function formatDateTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  // 日期与时间间用不换行空格，表格窄时也不折成两行
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}\u00a0${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`;
}

/**
 * 距今多久：只取最大的两个单位（如「21 小时 11 分钟前」「3 分钟 5 秒前」），为 0 的单位省略，便于扫读。
 * @param {string | null | undefined} iso
 */
export function formatAgo(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  let s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  const parts = [];
  for (const [unit, size] of [['天', 86400], ['小时', 3600], ['分钟', 60]]) {
    const n = Math.floor(s / size);
    if (n) parts.push(`${n} ${unit}`);
    s %= size;
  }
  if (s || !parts.length) parts.push(`${s} 秒`);
  return `${parts.slice(0, 2).join(' ')}前`;
}

/**
 * 套餐文案 → badge 修饰类，按档位配色一眼区分 free / pro / pro+。
 * @param {string | null | undefined} plan
 * @returns {'plan-free' | 'plan-pro' | 'plan-pro-plus' | 'plan-ultra' | 'plan-business' | 'plan-unknown'}
 */
export function planBadgeClass(plan) {
  const s = String(plan || '')
    .trim()
    .toLowerCase();
  if (!s || s === 'unknown') return 'plan-unknown';
  if (s.includes('ultra')) return 'plan-ultra';
  if (
    s.includes('pro+') ||
    s.includes('pro plus') ||
    s.includes('pro_plus') ||
    s.includes('proplus')
  ) {
    return 'plan-pro-plus';
  }
  if (s.includes('business') || s.includes('team') || s.includes('enterprise')) {
    return 'plan-business';
  }
  if (s === 'pro' || /\bpro\b/.test(s)) return 'plan-pro';
  if (s.includes('free') || s.includes('hobby')) return 'plan-free';
  return 'plan-unknown';
}

/**
 * 套餐展示名：把 API 里的 pro_plus 等归一成可读文案，已是 Pro+ 则原样保留。
 * @param {string | null | undefined} plan
 */
export function formatPlanLabel(plan) {
  const raw = String(plan || '').trim();
  if (!raw || raw.toLowerCase() === 'unknown') return 'unknown';
  const s = raw.toLowerCase();
  if (s === 'pro_plus' || s === 'proplus' || s === 'pro plus') return 'Pro+';
  if (s === 'pro') return 'Pro';
  if (s === 'free' || s === 'hobby') return 'Free';
  if (s === 'ultra') return 'Ultra';
  if (s === 'business' || s === 'team') return raw.charAt(0).toUpperCase() + raw.slice(1);
  return raw;
}

export function accountIdentity(member, privacyMode) {
  const emailRaw = member.email || '';
  const email = privacyMode && emailRaw ? maskEmail(emailRaw) : emailRaw;
  const name = (member.displayName || '').trim();
  const same =
    emailRaw &&
    (name.toLowerCase() === emailRaw.toLowerCase() ||
      name.toLowerCase() === emailRaw.split('@')[0].toLowerCase());
  if (name && !same) {
    return {
      title: privacyMode && name.includes('@') ? maskEmail(name) : name,
      subtitle: email || member.userId || '',
    };
  }
  if (email) return { title: email, subtitle: '' };
  return { title: member.userId || member.id || '账号', subtitle: '' };
}

/** sessionStorage 键：账号列表最近一次的 hash（页签、排序、搜索）。 */
export const ACCOUNTS_HASH_KEY = 'accountsListHash';

// 「← 返回账号列表」：直达列表并恢复上次筛选，不受当前页内历史条数影响
globalThis.document?.addEventListener('click', (event) => {
  const a = event.target instanceof Element ? event.target.closest('a[data-back-list]') : null;
  if (!a) return;
  event.preventDefault();
  location.href = `/${sessionStorage.getItem(ACCOUNTS_HASH_KEY) || ''}`;
});

// 「← 返回」：从本站页面进来时走浏览器后退，回到上一页原来的筛选与页签
globalThis.document?.addEventListener('click', (event) => {
  const a = event.target instanceof Element ? event.target.closest('a[data-back]') : null;
  if (!a || !document.referrer.startsWith(location.origin) || history.length < 2) return;
  event.preventDefault();
  history.back();
});

/**
 * @param {HTMLElement | null} el
 * @returns {(message: string, ms?: number) => void}
 */
export function createToast(el) {
  return function toast(message, ms = 3600) {
    if (!el) return;
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), Math.max(1200, Number(ms) || 3600));
  };
}

export function setBusy(btn, busy, busyLabel) {
  if (!btn) return;
  if (busy) {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent || '';
    btn.classList.add('busy');
    btn.disabled = true;
    if (busyLabel) {
      const spin = document.createElement('span');
      spin.className = 'spin';
      spin.textContent = '↻';
      btn.replaceChildren(spin, document.createTextNode(` ${busyLabel}`));
    }
  } else {
    btn.classList.remove('busy');
    btn.disabled = false;
    if (btn.dataset.label != null) {
      btn.textContent = btn.dataset.label;
      delete btn.dataset.label;
    }
  }
}

/**
 * 下载 JSON / CSV 文本文件。
 * @param {string} filename
 * @param {string} content
 * @param {string} mime
 */
export function downloadText(filename, content, mime = 'application/json') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * 实时拉账号在 Cursor 云端的 User Rules（不落库，规则随时可能在 Cursor 里被改）。
 * @param {string} memberId
 * @returns {Promise<Array<{ id: string, title: string, content: string, createdAt: string | null }>>}
 */
export async function fetchUserRules(memberId) {
  const { rules } = await api(`/api/members/${encodeURIComponent(memberId)}/user-rules`);
  return rules || [];
}

/**
 * 规则正文本身就是 Markdown，按「标题 + 创建时间 + 原文」拼成一份文档，弹窗展示与下载共用。
 * @param {Array<{ title: string, content: string, createdAt: string | null }>} rules
 * @param {string} account
 */
export function userRulesMarkdown(rules, account) {
  const parts = [`# ${account} 的 Cursor 用户规则`, '', `导出时间：${formatDateTime(new Date())}`];
  for (const r of rules) {
    parts.push('', '---', '', `## ${r.title || '未命名规则'}`, '');
    if (r.createdAt) parts.push(`> 创建时间：${formatDateTime(r.createdAt)}`, '');
    parts.push(r.content);
  }
  return `${parts.join('\n')}\n`;
}

/**
 * @param {Array<{ title: string, content: string, createdAt: string | null }>} rules
 * @param {string} account
 */
export function downloadUserRules(rules, account) {
  const stamp = new Date().toISOString().slice(0, 10);
  downloadText(
    `user-rules-${account}-${stamp}.md`,
    userRulesMarkdown(rules, account),
    'text/markdown;charset=utf-8',
  );
}

/**
 * 行内 Markdown：代码、加粗、链接。先整体转义再替换，规则里的原始 HTML 只会按文本显示。
 * @param {string} text
 */
function renderInlineMarkdown(text) {
  const codes = [];
  let s = escapeHtml(text).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
    );
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

/**
 * 轻量 Markdown 渲染，只覆盖用户规则里常见的块：标题、分隔线、引用、列表、代码块、表格、段落。
 * 不引第三方库：看板前端无构建，规则文本也不需要完整 CommonMark。
 * @param {string} md
 */
export function renderMarkdown(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l || '');
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const body = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(`<h${h[1].length}>${renderInlineMarkdown(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push('<hr />');
      i++;
      continue;
    }
    if (line.includes('|') && isTableSep(lines[i + 1])) {
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) {
        rows.push(cells(lines[i]));
      }
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${renderInlineMarkdown(c)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${renderInlineMarkdown(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      );
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) body.push(lines[i].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${renderInlineMarkdown(body.join(' '))}</blockquote>`);
      continue;
    }
    const listRe = /^\s*([-*]|\d+\.)\s+(.*)$/;
    if (listRe.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      for (; i < lines.length && listRe.test(lines[i]); i++) items.push(lines[i].match(listRe)[2]);
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => `<li>${renderInlineMarkdown(it)}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para = [];
    for (
      ;
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|\s*```|\s*>|\s*([-*]|\d+\.)\s)/.test(lines[i]) &&
      !(lines[i].includes('|') && isTableSep(lines[i + 1]));
      i++
    ) {
      para.push(renderInlineMarkdown(lines[i]));
    }
    out.push(`<p>${para.join('<br />')}</p>`);
  }
  return out.join('\n');
}

/**
 * 简易柱状图（报表用）。
 * @param {HTMLElement | null} el
 * @param {Array<{ label: string, value: number }>} points
 * @param {string} color
 * @param {(v: number) => string} [formatValue]
 */
export function renderBarChart(el, points, color, formatValue = (v) => String(v)) {
  if (!el) return;
  if (!points.length) {
    el.innerHTML = `<div class="chart-empty">暂无数据</div>`;
    return;
  }
  const h = 180;
  const w = chartViewWidth(el, h);
  const padL = 44;
  const padR = 12;
  const padT = 14;
  const padB = 28;
  const max = Math.max(...points.map((p) => Number(p.value) || 0), 1);
  const plotH = h - padT - padB;
  const plotW = w - padL - padR;
  const bw = plotW / points.length;
  const fmt = (v) => formatValue(Number(v) || 0);
  const yTicks = [0, 0.5, 1]
    .map((t) => {
      const val = max * t;
      const y = padT + plotH * (1 - t);
      return `
      <line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="currentColor" opacity="0.08" />
      <text x="${padL - 6}" y="${y + 3}" text-anchor="end" fill="currentColor" font-size="10" opacity="0.65">${escapeHtml(fmt(val))}</text>`;
    })
    .join('');
  const showValues = bw >= 30;
  const bars = points
    .map((p, i) => {
      const value = Number(p.value) || 0;
      const bh = Math.max(1, (value / max) * plotH);
      const x = padL + i * bw + bw * 0.15;
      const y = padT + plotH - bh;
      const valueText =
        showValues && value > 0
          ? `<text x="${x + bw * 0.35}" y="${y - 3}" text-anchor="middle" fill="currentColor" font-size="9" opacity="0.8">${escapeHtml(fmt(value))}</text>`
          : '';
      return `<rect class="chart-bar" x="${x}" y="${y}" width="${bw * 0.7}" height="${bh}" fill="${color}" rx="2"></rect>${valueText}`;
    })
    .join('');
  const hits = chartHitColumns(points, (i) => padL + i * bw, bw, padT, plotH, fmt);
  const labels = chartXLabels(points, (i) => padL + i * bw + bw / 2, h, plotW);
  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img">${yTicks}${bars}${labels}${hits}</svg><div class="chart-tooltip" hidden></div>`;
  bindChartTips(el);
}

/** viewBox 宽按容器实际宽高比算，宽卡片才能铺满而不是居中留白。 */
function chartViewWidth(el, h) {
  const { width, height } = el.getBoundingClientRect();
  return width > 0 && height > 0 ? Math.max(320, Math.round((width / height) * h)) : 640;
}

/** X 轴日期只显示 MM-DD，并按点数抽稀，避免文字重叠。 */
function chartXLabels(points, xAt, h, plotW) {
  const step = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(plotW / 48))));
  return points
    .map((p, i) => {
      if (i % step !== 0 && i !== points.length - 1) return '';
      if (i !== points.length - 1 && points.length - 1 - i < step / 2) return '';
      const raw = String(p.label || '');
      const label = /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(5, 10) : raw;
      return `<text x="${xAt(i)}" y="${h - 8}" text-anchor="middle" fill="currentColor" font-size="10" opacity="0.65">${escapeHtml(label)}</text>`;
    })
    .join('');
}

/** 每个点一整列透明热区：悬停该日任意高度都能看到数值（柱很矮 / 点很小时也可用）。 */
function chartHitColumns(points, leftAt, colW, padT, plotH, fmt) {
  return points
    .map(
      (p, i) =>
        `<rect class="chart-hit" x="${leftAt(i)}" y="${padT}" width="${colW}" height="${plotH}" fill="transparent" data-label="${escapeHtml(p.label)}" data-tip="${escapeHtml(`${p.label} · ${fmt(p.value)}`)}"></rect>`,
    )
    .join('');
}

/**
 * 简易折线图（日均用量等）。
 * @param {HTMLElement | null} el
 * @param {Array<{ label: string, value: number }>} points
 * @param {string} color
 * @param {(v: number) => string} [formatValue]
 */
export function renderLineChart(el, points, color, formatValue = (v) => String(v)) {
  if (!el) return;
  if (!points.length) {
    el.innerHTML = `<div class="chart-empty">暂无数据</div>`;
    return;
  }
  const h = 180;
  const w = chartViewWidth(el, h);
  const padL = 44;
  const padR = 28;
  const padT = 14;
  const padB = 28;
  const max = Math.max(...points.map((p) => Number(p.value) || 0), 1);
  const plotH = h - padT - padB;
  const plotW = w - padL - padR;
  const step = points.length > 1 ? plotW / (points.length - 1) : 0;
  const fmt = (v) => formatValue(Number(v) || 0);
  const coords = points.map((p, i) => {
    const x = padL + i * step;
    const y = padT + plotH * (1 - (Number(p.value) || 0) / max);
    return { x, y, p };
  });
  const poly = coords.map((c) => `${c.x},${c.y}`).join(' ');
  const showValues = points.length === 1 || step >= 30;
  const dots = coords
    .map(
      (c) =>
        `<circle class="chart-dot" cx="${c.x}" cy="${c.y}" r="3.5" fill="${color}"></circle>${
          showValues
            ? `<text x="${c.x}" y="${c.y - 7}" text-anchor="middle" fill="currentColor" font-size="9" opacity="0.8">${escapeHtml(fmt(c.p.value))}</text>`
            : ''
        }`,
    )
    .join('');
  const colW = points.length > 1 ? step : plotW;
  const hits = chartHitColumns(
    points,
    (i) => (points.length > 1 ? padL + i * step - step / 2 : padL),
    colW,
    padT,
    plotH,
    fmt,
  );
  const yTicks = [0, 0.5, 1]
    .map((t) => {
      const val = max * t;
      const y = padT + plotH * (1 - t);
      return `
      <line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="currentColor" opacity="0.08" />
      <text x="${padL - 6}" y="${y + 3}" text-anchor="end" fill="currentColor" font-size="10" opacity="0.65">${escapeHtml(fmt(val))}</text>`;
    })
    .join('');
  const labels = chartXLabels(points, (i) => coords[i].x, h, plotW);
  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img">${yTicks}<polyline fill="none" stroke="${color}" stroke-width="2.2" points="${poly}" />${dots}${labels}${hits}</svg><div class="chart-tooltip" hidden></div>`;
  bindChartTips(el);
}

/**
 * 横向条形图。
 * @param {HTMLElement | null} el
 * @param {Array<{ label: string, value: number, color?: string, tip?: string, badge?: { text: string, className: string } }>} items
 * @param {string} color
 * @param {(v: number) => string} [formatValue]
 * @param {{ max?: number }} [opts] 百分比类传 max=100，条长才对应真实比例
 */
export function renderHorizontalBars(el, items, color, formatValue = (v) => String(v), opts = {}) {
  if (!el) return;
  if (!items.length) {
    el.innerHTML = `<div class="chart-empty">暂无数据</div>`;
    return;
  }
  const max = opts.max || Math.max(...items.map((i) => Number(i.value) || 0), 1);
  el.innerHTML = `<div class="h-bars">${items
    .map((item) => {
      const value = Number(item.value) || 0;
      const pct = Math.min(100, Math.max(2, (value / max) * 100));
      const tip = item.tip || `${item.label} · ${formatValue(value)}`;
      return `<div class="h-bar-row" title="${escapeHtml(tip)}">
        <span class="h-bar-label"><span class="h-bar-name">${escapeHtml(item.label)}</span>${
          item.badge
            ? `<span class="badge plan ${escapeHtml(item.badge.className)}">${escapeHtml(item.badge.text)}</span>`
            : ''
        }</span>
        <span class="h-bar-track"><span class="h-bar-fill" style="width:${pct}%;background:${item.color || color}"></span></span>
        <span class="h-bar-value">${escapeHtml(formatValue(value))}</span>
      </div>`;
    })
    .join('')}</div>`;
}

/** @param {HTMLElement} el */
function bindChartTips(el) {
  const tipEl = el.querySelector('.chart-tooltip');
  if (!tipEl) return;
  const placeTip = (ev) => {
    const box = el.getBoundingClientRect();
    tipEl.style.left = `${ev.clientX - box.left + 12}px`;
    tipEl.style.top = `${ev.clientY - box.top - 8}px`;
  };
  el.querySelectorAll('[data-tip]').forEach((node) => {
    node.addEventListener('pointerenter', (ev) => {
      tipEl.hidden = false;
      tipEl.textContent = node.getAttribute('data-tip') || '';
      placeTip(ev);
    });
    node.addEventListener('pointermove', placeTip);
    node.addEventListener('pointerleave', () => {
      tipEl.hidden = true;
    });
  });
}
