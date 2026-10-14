/**
 * 通知推送：目前仅企业微信群机器人 webhook。
 * 配置 NOTIFY_CHANNEL + NOTIFY_BOT_ID；定时推送临期且额度充足、可切换的账号。
 */

import { enrichMembersWithPresence } from './account-presence.js';
import { switchBlockReason, usageTotalPercentOf } from './account-switch.js';
import { getNotifyConfig } from './config.js';
import { listMembers } from './store.js';
import { writeAppLog } from './app-log.js';

/** 与看板「临期」筛选一致：重置日剩余天数 ≤ 此值。 */
export const EXPIRING_WITHIN_DAYS = 10;
/** 已用额度低于此比例视为「额度充足」（与卡片 warn 线对齐）。 */
export const SUFFICIENT_USED_MAX = 80;

const WECOM_WEBHOOK_BASE = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send';

/** @type {ReturnType<typeof setTimeout> | null} */
let scheduleTimer = null;
/** @type {ReturnType<typeof setInterval> | null} */
let scheduleInterval = null;

/**
 * 距下次本地 HH:MM 的毫秒数（已过则推到明天）。
 * @param {number} hour
 * @param {number} minute
 * @param {number} [nowMs]
 */
export function msUntilNextLocalTime(hour, minute, nowMs = Date.now()) {
  const next = new Date(nowMs);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= nowMs) next.setDate(next.getDate() + 1);
  return Math.max(1000, next.getTime() - nowMs);
}

/**
 * @param {unknown} iso
 * @param {number} [nowMs]
 * @returns {number | null}
 */
export function daysUntilReset(iso, nowMs = Date.now()) {
  if (!iso) return null;
  const t = new Date(String(iso)).getTime();
  if (Number.isNaN(t)) return null;
  const ms = t - nowMs;
  if (ms <= 0) return 0;
  return Math.max(1, Math.ceil(ms / 86400000));
}

/**
 * 机器人 id：支持纯 key，或完整 webhook URL。
 * @param {string} botId
 * @returns {string | null}
 */
export function resolveWecomWebhookUrl(botId) {
  const raw = String(botId || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${WECOM_WEBHOOK_BASE}?key=${encodeURIComponent(raw)}`;
}

/**
 * 临期 + 可切换 + 额度充足。
 * @param {any} member
 * @param {number} [nowMs]
 */
export function isExpiringSwitchableMember(member, nowMs = Date.now()) {
  if (!member || switchBlockReason(member)) return false;
  const used = usageTotalPercentOf(member);
  if (used == null || used > SUFFICIENT_USED_MAX) return false;
  const days = daysUntilReset(member.lastSnapshot?.window?.resetIso, nowMs);
  return days != null && days <= EXPIRING_WITHIN_DAYS;
}

/**
 * @param {any[]} members
 * @param {number} [nowMs]
 */
export function listExpiringSwitchableMembers(members, nowMs = Date.now()) {
  return [...(members || [])]
    .filter((m) => isExpiringSwitchableMember(m, nowMs))
    .sort((a, b) => {
      const aReset = Date.parse(a?.lastSnapshot?.window?.resetIso || '') || Infinity;
      const bReset = Date.parse(b?.lastSnapshot?.window?.resetIso || '') || Infinity;
      if (aReset !== bReset) return aReset - bReset;
      return (usageTotalPercentOf(a) || 0) - (usageTotalPercentOf(b) || 0);
    });
}

/**
 * 组装推送正文（纯文本，企微 markdown/text 均可）。
 * @param {{ members: any[], panelUrl?: string|null, nowMs?: number }} input
 */
export function buildExpiringNotifyText(input) {
  const nowMs = input.nowMs ?? Date.now();
  const candidates = listExpiringSwitchableMembers(input.members, nowMs);
  const panelUrl = String(input.panelUrl || '').trim().replace(/\/+$/, '');
  const lines = [
    'Cursor Team Usage',
    '检查到有账号即将临期且额度充足，推荐使用超速的用户暂时切换使用。',
    '',
  ];
  if (!candidates.length) {
    lines.push('当前暂无符合条件的可切换账号。');
  } else {
    lines.push(`可切换账号（${candidates.length}）：`);
    // 不展示账号名，避免群里泄露个人标识
    for (const m of candidates.slice(0, 15)) {
      const used = usageTotalPercentOf(m);
      const left = used == null ? '—' : `${Math.max(0, Math.round((100 - used) * 10) / 10)}%`;
      const days = daysUntilReset(m.lastSnapshot?.window?.resetIso, nowMs);
      const resetLabel =
        days == null ? '重置日未知' : days === 0 ? '今日重置' : `${days} 天后重置`;
      lines.push(`· 剩余 ${left} · ${resetLabel}`);
    }
    if (candidates.length > 15) {
      lines.push(`…另有 ${candidates.length - 15} 个账号，详见看板`);
    }
  }
  lines.push('');
  lines.push(panelUrl ? `看板：${panelUrl}` : '看板：未配置 PUBLIC_BASE_URL');
  return { text: lines.join('\n'), count: candidates.length, members: candidates };
}

/**
 * 向企业微信机器人发送文本。
 * @param {{ webhookUrl: string, text: string }} input
 */
export async function sendWecomText(input) {
  const webhookUrl = String(input.webhookUrl || '').trim();
  const text = String(input.text || '');
  if (!webhookUrl) throw new Error('未配置企微机器人地址');
  if (!text) throw new Error('推送内容为空');
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msgtype: 'text',
      text: { content: text },
    }),
  });
  const body = await res.json().catch(() => ({}));
  // 企微成功 errcode=0
  if (!res.ok || (body && body.errcode != null && Number(body.errcode) !== 0)) {
    const msg = body?.errmsg || `HTTP ${res.status}`;
    throw new Error(`企微推送失败：${msg}`);
  }
  return body;
}

/**
 * 按通道发送；目前仅 wecom。
 * @param {{ channel: string, botId: string, text: string }} input
 */
export async function sendNotify(input) {
  const channel = String(input.channel || '')
    .trim()
    .toLowerCase();
  if (channel !== 'wecom' && channel !== 'wechat_work' && channel !== 'qywx') {
    throw new Error(`暂不支持的通知通道：${channel || '（空）'}（目前仅 wecom）`);
  }
  const webhookUrl = resolveWecomWebhookUrl(input.botId);
  if (!webhookUrl) throw new Error('未配置 NOTIFY_BOT_ID（企微机器人 key）');
  return sendWecomText({ webhookUrl, text: input.text });
}

/**
 * 拉取名册并推送临期可切换摘要。
 * @param {{ force?: boolean }} [opts] force=true 时无候选也推送（测试按钮）
 */
export async function runExpiringNotify(opts = {}) {
  const cfg = getNotifyConfig();
  if (!cfg.enabled) {
    const err = new Error('未启用通知：请配置 NOTIFY_CHANNEL=wecom 与 NOTIFY_BOT_ID');
    err.status = 503;
    throw err;
  }
  const members = await enrichMembersWithPresence(await listMembers());
  const panelUrl = String(process.env.PUBLIC_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  const built = buildExpiringNotifyText({ members, panelUrl });
  if (!opts.force && built.count === 0) {
    await writeAppLog('企微推送', { 结果: '跳过', 原因: '无临期可切换账号' });
    return { ok: true, skipped: true, count: 0, text: built.text };
  }
  await sendNotify({ channel: cfg.channel, botId: cfg.botId, text: built.text });
  await writeAppLog('企微推送', {
    结果: '成功',
    账号数: built.count,
    强制: Boolean(opts.force) || undefined,
  });
  return { ok: true, skipped: false, count: built.count, text: built.text };
}

/** 启动每日定时推送（默认本地 09:30）。 */
export function setupExpiringNotifySchedule() {
  if (scheduleTimer) {
    clearTimeout(scheduleTimer);
    scheduleTimer = null;
  }
  if (scheduleInterval) {
    clearInterval(scheduleInterval);
    scheduleInterval = null;
  }
  const cfg = getNotifyConfig();
  if (!cfg.enabled) {
    console.log('企微推送：未配置（需 NOTIFY_CHANNEL + NOTIFY_BOT_ID）');
    return;
  }
  const delay = msUntilNextLocalTime(cfg.hour, cfg.minute);
  console.log(
    `企微推送：已启用通道=${cfg.channel}，下次 ${String(cfg.hour).padStart(2, '0')}:${String(cfg.minute).padStart(2, '0')}（约 ${Math.round(delay / 60000)} 分钟后）`,
  );
  scheduleTimer = setTimeout(() => {
    runExpiringNotify({ force: false }).catch((e) =>
      console.error('企微定时推送失败:', e?.message || e),
    );
    scheduleInterval = setInterval(
      () => {
        runExpiringNotify({ force: false }).catch((e) =>
          console.error('企微定时推送失败:', e?.message || e),
        );
      },
      24 * 3600 * 1000,
    );
  }, delay);
}
