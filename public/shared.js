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
  return { privacyMode: false };
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
  if (res.status === 401 && !path.startsWith('/api/auth/login')) {
    location.href = '/login.html';
    throw new Error('未登录');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
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

/** 官方用量页 Tokens 列：与 formatTokens 相同（万 / 亿）。 */
export function formatTokensWan(n) {
  return formatTokens(n);
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
 * 有效时间展示：2026-09-16 11.00（本地时区）。
 * @param {string | null | undefined} iso
 */
export function formatDateTimeDot(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}.${mm}`;
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

export function createToast(el) {
  return function toast(message) {
    if (!el) return;
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 3600);
  };
}

export function setBusy(btn, busy, busyLabel) {
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
