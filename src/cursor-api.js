/**
 * Cursor 用量客户端。
 * 用每人一份会话 cookie 调用 cursor.com 非官方 dashboard / Connect 接口，
 * 拉取计划、请求额度、花费上限与账单周期用量。
 */

import { jwtFromCookie, sessionFromCookie } from './auth.js';

const USER_AGENT = 'cursor-team-usage/0.1';
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

/** cursor.com 对状态变更请求做 Origin 校验，需模拟浏览器 dashboard 头。 */
const BROWSER_HEADERS = {
  Origin: 'https://cursor.com',
  Referer: 'https://cursor.com/dashboard',
  'User-Agent': USER_AGENT,
};

/**
 * 带超时的 JSON 请求；把非 2xx 收成可读错误，便于成员卡片展示失败原因。
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} [timeoutMs]
 */
async function fetchJson(url, options, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const msg = data?.message || data?.error || `HTTP ${res.status}`;
      const err = new Error(String(msg));
      err.status = res.status;
      throw err;
    }
    return data;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`请求超时: ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {unknown} v
 * @returns {number | null}
 */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 账单周期重置日：从周期起始日加一个月，并夹紧到目标月天数。
 * @param {string | undefined} startOfCycleIso
 */
export function computeResetIso(startOfCycleIso) {
  if (!startOfCycleIso) return undefined;
  const start = new Date(startOfCycleIso);
  if (Number.isNaN(start.getTime())) return undefined;
  const reset = new Date(start);
  const day = reset.getDate();
  reset.setDate(1);
  reset.setMonth(reset.getMonth() + 1);
  const daysInTargetMonth = new Date(reset.getFullYear(), reset.getMonth() + 1, 0).getDate();
  reset.setDate(Math.min(day, daysInTargetMonth));
  return reset.toISOString();
}

/**
 * 解析 /api/usage 的请求额度桶（形态未文档化，缺字段时返回 null）。
 * @param {any} data
 */
export function parseQuotaResponse(data) {
  if (!data || typeof data !== 'object') return null;
  let best = null;
  for (const [key, v] of Object.entries(data)) {
    if (!v || typeof v !== 'object') continue;
    if (!('numRequests' in v) && !('maxRequestUsage' in v)) continue;
    const quota = {
      used: num(v.numRequests) ?? num(v.numRequestsTotal) ?? 0,
      limit: num(v.maxRequestUsage),
    };
    if (key === 'gpt-4') {
      best = quota;
      break;
    }
    if (!best || (best.limit == null && quota.limit != null)) best = quota;
  }
  if (!best) return null;
  if (typeof data.startOfMonth === 'string') {
    best.startOfCycleIso = data.startOfMonth;
    best.resetIso = computeResetIso(data.startOfMonth);
  }
  return best;
}

/**
 * 当前账单周期窗口：有额度起始日则用之，否则回退到本月 1 号。
 * @param {{ startOfCycleIso?: string } | null | undefined} quota
 * @param {Date} [now]
 */
export function billingCycleWindow(quota, now = new Date()) {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  if (quota?.startOfCycleIso) {
    const start = new Date(quota.startOfCycleIso);
    if (!Number.isNaN(start.getTime())) {
      start.setHours(0, 0, 0, 0);
      return { start: start.getTime(), end: end.getTime() };
    }
  }

  const start = new Date(now);
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  return { start: start.getTime(), end: end.getTime() };
}

/**
 * 从事件行提取实际计费（分）。字符串按美元、数字按分处理。
 * @param {any} e
 */
function pickChargedCents(e) {
  if (e.chargedCents != null) return num(e.chargedCents);
  const asDollars = (v) => {
    if (v == null || v === '' || v === '-') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const m = String(v).match(/([\d.]+)/);
    if (!m) return null;
    const parsed = parseFloat(m[1]);
    return Number.isFinite(parsed) ? Math.round(parsed * 100 * 1000) / 1000 : null;
  };
  return asDollars(e.usageBasedCosts) ?? asDollars(e.requestsCosts);
}

/**
 * 把 Cursor 原始 kind 映射成官方用量页 Type 文案（Included / Free / On-Demand）。
 * @param {string | undefined} kind
 */
export function usageKindLabel(kind) {
  const k = String(kind || '');
  if (!k) return '—';
  if (/FREE/i.test(k)) return 'Free';
  if (/INCLUDED/i.test(k)) return 'Included';
  if (/USAGE_BASED|ON_?DEMAND|ERRORED/i.test(k)) return 'On-Demand';
  return k.replace(/^USAGE_EVENT_KIND_/, '').replaceAll('_', ' ');
}

/**
 * Cost 列：套餐内/免费显示文案；按量计费显示美元。
 * @param {{ kind?: string, chargedCents?: number | null }} e
 */
export function usageCostLabel(e) {
  const type = usageKindLabel(e.kind);
  if (type === 'Included' || type === 'Free') return type;
  if (e.chargedCents != null && Number(e.chargedCents) > 0) {
    return `$${(Number(e.chargedCents) / 100).toFixed(2)}`;
  }
  return type === '—' ? '—' : type;
}

/**
 * 单次请求总 token（input + output + cache read），对齐官方 Tokens 列口径。
 * @param {{ inputTokens?: number, outputTokens?: number, cacheReadTokens?: number }} e
 */
export function eventTotalTokens(e) {
  return (e.inputTokens || 0) + (e.outputTokens || 0) + (e.cacheReadTokens || 0);
}

/**
 * 校验会话并拿到账号邮箱/姓名，用于成员卡片身份展示。
 * @param {{ cookieValue: string }} session
 */
export async function fetchMe(session) {
  const data = await fetchJson('https://cursor.com/api/auth/me', {
    method: 'GET',
    headers: {
      ...BROWSER_HEADERS,
      Cookie: `WorkosCursorSessionToken=${session.cookieValue}`,
    },
  });
  return { email: data?.email, name: data?.name };
}

/**
 * 套餐类型（pro / free 等）。
 * @param {{ cookieValue: string }} session
 */
export async function fetchStripeProfile(session) {
  const data = await fetchJson('https://cursor.com/api/auth/stripe', {
    method: 'GET',
    headers: {
      ...BROWSER_HEADERS,
      Cookie: `WorkosCursorSessionToken=${session.cookieValue}`,
    },
  });
  return {
    membershipType: String(
      data?.membershipType ?? data?.individualMembershipType ?? 'unknown',
    ).toLowerCase(),
    daysRemainingOnTrial: num(data?.daysRemainingOnTrial),
    teamId: num(data?.teamId),
    isTeamMember: Boolean(data?.isTeamMember),
  };
}

/**
 * 当前周期 included/premium 请求额度。
 * @param {{ cookieValue: string, userId: string }} session
 */
export async function fetchPlanQuota(session) {
  const data = await fetchJson(
    `https://cursor.com/api/usage?user=${encodeURIComponent(session.userId)}`,
    {
      method: 'GET',
      headers: {
        ...BROWSER_HEADERS,
        Cookie: `WorkosCursorSessionToken=${session.cookieValue}`,
      },
    },
  );
  return parseQuotaResponse(data);
}

/**
 * 按量计费硬上限（美元）；未设置时返回 null。
 * @param {{ cookieValue: string }} session
 */
export async function fetchHardLimit(session) {
  const data = await fetchJson('https://cursor.com/api/dashboard/get-hard-limit', {
    method: 'POST',
    headers: {
      ...BROWSER_HEADERS,
      'Content-Type': 'application/json',
      Cookie: `WorkosCursorSessionToken=${session.cookieValue}`,
    },
    body: '{}',
  });
  const limit = num(data?.hardLimit);
  return limit != null && limit > 0 ? limit : null;
}

/**
 * 拉取账单窗口内的用量事件，用于汇总花费与请求数。
 * @param {{ cookieValue: string }} session
 * @param {number} startMs
 * @param {number} endMs
 */
export async function fetchDashboardUsage(session, startMs, endMs) {
  const events = [];
  const seenIds = new Set();
  let page = 1;

  for (; page <= MAX_PAGES; page++) {
    const data = await fetchJson('https://cursor.com/api/dashboard/get-filtered-usage-events', {
      method: 'POST',
      headers: {
        ...BROWSER_HEADERS,
        'Content-Type': 'application/json',
        Cookie: `WorkosCursorSessionToken=${session.cookieValue}`,
      },
      body: JSON.stringify({
        teamId: 0,
        startDate: String(startMs),
        endDate: String(endMs),
        page,
        pageSize: PAGE_SIZE,
      }),
    });

    const batch = data.usageEventsDisplay || data.usageEvents || data.events || [];
    let added = 0;
    for (const e of batch) {
      const rawId = e?.id ?? e?.eventId;
      if (rawId != null) {
        const key = String(rawId);
        if (seenIds.has(key)) continue;
        seenIds.add(key);
      }
      const tu = e.tokenUsage || null;
      const inputTokens = tu ? num(tu.inputTokens) ?? num(tu.input_tokens) ?? 0 : 0;
      const outputTokens = tu ? num(tu.outputTokens) ?? num(tu.output_tokens) ?? 0 : 0;
      const cacheReadTokens = tu
        ? num(tu.cacheReadTokens) ??
          num(tu.cache_read_tokens) ??
          num(tu.cacheReadInputTokens) ??
          0
        : 0;
      const cacheWriteTokens = tu
        ? num(tu.cacheWriteTokens) ??
          num(tu.cache_write_tokens) ??
          num(tu.cacheCreationInputTokens) ??
          0
        : 0;
      const kind = e.kind || e.usageEventKind || '';
      const row = {
        id: String(rawId ?? `${e.timestamp}-${e.model ?? 'unknown'}`),
        timestamp: e.timestamp ?? e.timestampEpoch ?? 0,
        model: e.model || e.modelIntent || 'unknown',
        kind,
        kindLabel: usageKindLabel(kind),
        isTokenBasedCall: Boolean(e.isTokenBasedCall),
        chargedCents: pickChargedCents(e),
        tokenCents: tu ? num(tu.totalCents) : null,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
      };
      row.totalTokens = eventTotalTokens(row);
      row.costLabel = usageCostLabel(row);
      events.push(row);
      added++;
    }

    // 分页参数未文档化：若整页都是已见 id，停止以免重复累计。
    if (batch.length && added === 0) break;

    const total = num(data.totalUsageEventsCount);
    const hasNext =
      data.pagination?.hasNextPage ??
      (total != null ? page * PAGE_SIZE < total : batch.length === PAGE_SIZE);
    if (!batch.length || !hasNext) break;
  }

  return events;
}

/**
 * 把事件汇总成周期指标：花费、请求数、token、模型分布。
 * @param {Array<{ chargedCents: number | null, tokenCents: number | null, model: string, isTokenBasedCall: boolean, inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number }>} events
 */
export function summarizeEvents(events) {
  let billedCents = 0;
  let tokenValueCents = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  /** @type {Record<string, number>} */
  const byModel = {};

  for (const e of events) {
    if (e.chargedCents != null) billedCents += e.chargedCents;
    if (e.tokenCents != null) tokenValueCents += e.tokenCents;
    inputTokens += e.inputTokens || 0;
    outputTokens += e.outputTokens || 0;
    cacheReadTokens += e.cacheReadTokens || 0;
    cacheWriteTokens += e.cacheWriteTokens || 0;
    byModel[e.model] = (byModel[e.model] || 0) + 1;
  }

  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const topModels = Object.entries(byModel)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([model, count]) => ({ model, count }));

  return {
    requestCount: events.length,
    billedDollars: Math.round((billedCents / 100) * 100) / 100,
    tokenValueDollars: Math.round((tokenValueCents / 100) * 100) / 100,
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    topModels,
  };
}

/**
 * 拉取个人/团队仪表盘的结构化用量百分比与账单周期。
 * 字段见 individualUsage.plan.totalPercentUsed / autoPercentUsed / apiPercentUsed。
 * @param {{ cookieValue: string }} session
 */
export async function fetchUsageSummary(session) {
  const data = await fetchJson('https://cursor.com/api/usage-summary', {
    method: 'GET',
    headers: {
      ...BROWSER_HEADERS,
      Cookie: `WorkosCursorSessionToken=${session.cookieValue}`,
    },
  });
  return parseUsageSummary(data);
}

/**
 * Connect RPC GetCurrentPeriodUsage（Bearer JWT），用于周期内详细用量。
 * 与 usage-summary 互补；优先补全 totalPercentUsed。
 * @param {{ cookieValue: string }} session
 */
export async function fetchCurrentPeriodUsage(session) {
  const jwt = jwtFromCookie(session.cookieValue);
  if (!jwt) return null;
  try {
    const data = await fetchJson(
      'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'User-Agent': USER_AGENT,
        },
        body: '{}',
      },
    );
    return parsePeriodUsage(data);
  } catch {
    return null;
  }
}

/**
 * @param {any} data
 */
export function parseUsageSummary(data) {
  if (!data || typeof data !== 'object') return null;
  const individual = data.individualUsage || {};
  const plan = individual.plan || {};
  const onDemand = individual.onDemand || {};
  const totalPercentUsed = num(plan.totalPercentUsed);
  const autoPercentUsed = num(plan.autoPercentUsed);
  const apiPercentUsed = num(plan.apiPercentUsed);
  const planUsedCents = num(plan.used);
  const planLimitCents = num(plan.limit);
  const planRemainingCents = num(plan.remaining);

  return {
    membershipType: data.membershipType ? String(data.membershipType).toLowerCase() : undefined,
    billingCycleStart: typeof data.billingCycleStart === 'string' ? data.billingCycleStart : undefined,
    billingCycleEnd: typeof data.billingCycleEnd === 'string' ? data.billingCycleEnd : undefined,
    limitType: data.limitType ? String(data.limitType) : undefined,
    isUnlimited: Boolean(data.isUnlimited),
    displayMessage: data.autoModelSelectedDisplayMessage || data.namedModelSelectedDisplayMessage,
    totalPercentUsed,
    autoPercentUsed,
    apiPercentUsed,
    planUsedCents,
    planLimitCents,
    planRemainingCents,
    planBreakdown: plan.breakdown
      ? {
          included: num(plan.breakdown.included) ?? 0,
          bonus: num(plan.breakdown.bonus) ?? 0,
          total: num(plan.breakdown.total) ?? 0,
        }
      : null,
    onDemand: {
      enabled: Boolean(onDemand.enabled),
      usedCents: num(onDemand.used),
      limitCents: num(onDemand.limit),
      remainingCents: num(onDemand.remaining),
    },
  };
}

/**
 * @param {any} data
 */
export function parsePeriodUsage(data) {
  if (!data || typeof data !== 'object') return null;
  const planUsage = data.planUsage || {};
  return {
    totalPercentUsed: num(planUsage.totalPercentUsed),
    autoPercentUsed: num(planUsage.autoPercentUsed),
    apiPercentUsed: num(planUsage.apiPercentUsed),
    planUsedCents: num(planUsage.totalSpend),
    planLimitCents: num(planUsage.limit),
    includedSpendCents: num(planUsage.includedSpend),
    bonusSpendCents: num(planUsage.bonusSpend),
    displayMessage: data.displayMessage || data.autoModelSelectedDisplayMessage,
    billingCycleStartMs: num(data.billingCycleStart),
    billingCycleEndMs: num(data.billingCycleEnd),
    enabled: data.enabled !== false,
  };
}

/**
 * 合并 usage-summary 与 Connect RPC，得到看板主进度条用的百分比。
 * @param {ReturnType<typeof parseUsageSummary>} summary
 * @param {ReturnType<typeof parsePeriodUsage>} period
 */
export function mergePlanMeters(summary, period) {
  const totalPercentUsed = summary?.totalPercentUsed ?? period?.totalPercentUsed ?? null;
  const autoPercentUsed = summary?.autoPercentUsed ?? period?.autoPercentUsed ?? null;
  const apiPercentUsed = summary?.apiPercentUsed ?? period?.apiPercentUsed ?? null;
  const planUsedCents = summary?.planUsedCents ?? period?.planUsedCents ?? null;
  const planLimitCents = summary?.planLimitCents ?? period?.planLimitCents ?? null;

  let planSpendPercent = null;
  if (planLimitCents != null && planLimitCents > 0 && planUsedCents != null) {
    planSpendPercent = Math.min(100, Math.round((planUsedCents / planLimitCents) * 1000) / 10);
  }

  return {
    membershipType: summary?.membershipType,
    totalPercentUsed:
      totalPercentUsed != null ? Math.round(totalPercentUsed * 10) / 10 : null,
    autoPercentUsed: autoPercentUsed != null ? Math.round(autoPercentUsed * 10) / 10 : null,
    apiPercentUsed: apiPercentUsed != null ? Math.round(apiPercentUsed * 10) / 10 : null,
    planUsedDollars: planUsedCents != null ? Math.round((planUsedCents / 100) * 100) / 100 : null,
    planLimitDollars: planLimitCents != null ? Math.round((planLimitCents / 100) * 100) / 100 : null,
    planSpendPercent,
    displayMessage: summary?.displayMessage || period?.displayMessage || null,
    billingCycleStart: summary?.billingCycleStart,
    billingCycleEnd: summary?.billingCycleEnd,
    onDemand: summary?.onDemand || null,
    planBreakdown: summary?.planBreakdown || null,
  };
}

/**
 * 事件时间戳统一成毫秒。
 * @param {unknown} timestamp
 */
export function eventTimestampMs(timestamp) {
  const n = Number(timestamp);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}

/**
 * 本地日历日 yyyy-MM-dd。
 * @param {number} ms
 */
export function localDayKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * @param {number} [nowMs]
 */
function localDayBounds(nowMs = Date.now()) {
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  const todayStart = start.getTime();
  const yesterdayStart = todayStart - 86400000;
  const last30Start = todayStart - 29 * 86400000;
  return { todayStart, yesterdayStart, last30Start, todayKey: localDayKey(todayStart), yesterdayKey: localDayKey(yesterdayStart) };
}

/**
 * 按本地日汇总花费与 token，供 Today / Yesterday / Last 30 Days。
 * 有实际计费用 charged；Included/$0 时回退 token 估值，避免 Included 请求显示为 $0。
 * @param {Array<{ timestamp?: unknown, chargedCents: number | null, tokenCents: number | null, inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number }>} events
 * @param {number} [nowMs]
 */
export function aggregateSpendPeriods(events, nowMs = Date.now()) {
  const { todayKey, yesterdayKey, last30Start } = localDayBounds(nowMs);
  /** @type {Record<string, { dollars: number, tokens: number, requests: number }>} */
  const byDay = {};

  for (const e of events) {
    const ts = eventTimestampMs(e.timestamp);
    if (!ts || ts < last30Start) continue;
    const key = localDayKey(ts);
    const tokens =
      (e.inputTokens || 0) +
      (e.outputTokens || 0) +
      (e.cacheReadTokens || 0) +
      (e.cacheWriteTokens || 0);
    let dollars = 0;
    if (e.chargedCents != null && e.chargedCents > 0) dollars = e.chargedCents / 100;
    else if (e.tokenCents != null && e.tokenCents > 0) dollars = e.tokenCents / 100;

    if (!byDay[key]) byDay[key] = { dollars: 0, tokens: 0, requests: 0 };
    byDay[key].dollars += dollars;
    byDay[key].tokens += tokens;
    byDay[key].requests += 1;
  }

  const round = (n) => Math.round(n * 100) / 100;
  const pick = (key) => {
    const row = byDay[key];
    if (!row || (row.tokens <= 0 && row.dollars <= 0)) return null;
    return {
      dollars: round(row.dollars),
      tokens: row.tokens,
      requests: row.requests,
      estimated: true,
    };
  };

  let last30Dollars = 0;
  let last30Tokens = 0;
  let last30Requests = 0;
  for (const row of Object.values(byDay)) {
    last30Dollars += row.dollars;
    last30Tokens += row.tokens;
    last30Requests += row.requests;
  }

  // 近 30 个本地日完整序列（含 0），详情页柱状图用，避免断档。
  const daily = [];
  for (let i = 29; i >= 0; i--) {
    const ms = localDayBounds(nowMs).todayStart - i * 86400000;
    const key = localDayKey(ms);
    const row = byDay[key];
    daily.push({
      date: key,
      dollars: round(row?.dollars || 0),
      tokens: row?.tokens || 0,
      requests: row?.requests || 0,
    });
  }

  return {
    today: pick(todayKey),
    yesterday: pick(yesterdayKey),
    last30:
      last30Tokens > 0 || last30Dollars > 0
        ? {
            dollars: round(last30Dollars),
            tokens: last30Tokens,
            requests: last30Requests,
            estimated: true,
          }
        : null,
    daily,
  };
}

/**
 * Grok Bot 周额度（GetSandUsageStatus）。
 * @param {{ cookieValue: string }} session
 */
export async function fetchGrokBotUsage(session) {
  const jwt = jwtFromCookie(session.cookieValue);
  if (!jwt) return null;
  try {
    const data = await fetchJson(
      'https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'User-Agent': USER_AGENT,
        },
        body: '{}',
      },
    );
    if (data?.usesPooledEnterpriseAllowance === true) return null;
    if (data?.hasNonZeroIncludedLimit === false || data?.includedLimitZero === true) return null;
    const usagePercent = num(data?.usagePercent);
    if (usagePercent == null || usagePercent < 0) return null;
    return {
      usagePercent: Math.round(usagePercent * 10) / 10,
      resetsAt: typeof data.nextResetTimestampUtc === 'string' ? data.nextResetTimestampUtc : null,
      periodStart: typeof data.currentPeriodStart === 'string' ? data.currentPeriodStart : null,
    };
  } catch {
    return null;
  }
}

/**
 * 计划展示名（如 Pro+）。
 * @param {{ cookieValue: string }} session
 */
export async function fetchPlanInfo(session) {
  const jwt = jwtFromCookie(session.cookieValue);
  if (!jwt) return null;
  try {
    const data = await fetchJson(
      'https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'User-Agent': USER_AGENT,
        },
        body: '{}',
      },
    );
    const info = data?.planInfo || {};
    return {
      planName: info.planName ? String(info.planName) : null,
      includedAmountCents: num(info.includedAmountCents),
      price: info.price ? String(info.price) : null,
    };
  } catch {
    return null;
  }
}

/**
 * 组装面板 metric lines，供前端逐行渲染。
 * @param {{
 *   planMeters: ReturnType<typeof mergePlanMeters>,
 *   meters: Record<string, number | null | undefined>,
 *   quota?: { used: number, limit: number | null } | null,
 *   grokBot?: { usagePercent: number, resetsAt?: string | null } | null,
 *   spend?: ReturnType<typeof aggregateSpendPeriods> | null,
 *   window?: { resetIso?: string },
 * }} input
 */
export function buildOpenUsagePanelLines(input) {
  /** @type {Array<Record<string, unknown>>} */
  const lines = [];
  const pm = input.planMeters || {};
  const resetsAt = input.window?.resetIso || pm.billingCycleEnd || null;

  const pushPercent = (label, used) => {
    if (used == null || !Number.isFinite(used)) return;
    lines.push({
      type: 'progress',
      label,
      used,
      limit: 100,
      format: 'percent',
      resetsAt,
    });
  };

  // 展示顺序：Total → Cursor Models → Other Models → Grok → On-demand → spend tiles
  if (pm.totalPercentUsed != null) {
    pushPercent('Total usage', pm.totalPercentUsed);
  } else if (input.quota?.limit != null && input.quota.limit > 0) {
    lines.push({
      type: 'progress',
      label: 'Total usage',
      used: input.quota.used,
      limit: input.quota.limit,
      format: 'count',
      suffix: 'requests',
      resetsAt,
    });
  }

  pushPercent('Cursor Models', pm.autoPercentUsed);
  pushPercent('Other Models', pm.apiPercentUsed);

  if (input.grokBot?.usagePercent != null) {
    lines.push({
      type: 'progress',
      label: 'Grok Bot usage',
      used: input.grokBot.usagePercent,
      limit: 100,
      format: 'percent',
      resetsAt: input.grokBot.resetsAt || null,
    });
  }

  const od = pm.onDemand;
  if (od?.enabled && od.limitCents != null && od.limitCents > 0) {
    const used = (od.usedCents ?? 0) / 100;
    const limit = od.limitCents / 100;
    lines.push({
      type: 'progress',
      label: 'On-demand',
      used: Math.round(used * 100) / 100,
      limit: Math.round(limit * 100) / 100,
      format: 'dollars',
      resetsAt,
    });
  } else if (od?.enabled && (od.usedCents ?? 0) > 0) {
    lines.push({
      type: 'values',
      label: 'On-demand',
      dollars: Math.round(((od.usedCents || 0) / 100) * 100) / 100,
      tokens: null,
      text: `$${((od.usedCents || 0) / 100).toFixed(2)}`,
    });
  }

  const fmtCell = (row) => {
    if (!row) return { text: 'No data', dollars: null, tokens: null };
    const tokens = row.tokens ?? 0;
    const tokenLabel =
      tokens >= 1e6 ? `${(tokens / 1e6).toFixed(1)}M` : tokens >= 1e3 ? `${(tokens / 1e3).toFixed(1)}K` : String(tokens);
    return {
      text: `$${Number(row.dollars || 0).toFixed(2)} · ${tokenLabel}`,
      dollars: row.dollars,
      tokens: row.tokens,
    };
  };

  lines.push({
    type: 'spend-row',
    label: 'Spend',
    today: fmtCell(input.spend?.today),
    yesterday: fmtCell(input.spend?.yesterday),
    last30: fmtCell(input.spend?.last30),
    estimated: true,
  });

  return lines;
}

/**
 * 按本地近 N 天拉取官方同款用量事件；支持 page/pageSize，详情表首屏可快速出数。
 * @param {string} cookieValue
 * @param {{ days?: number, page?: number, pageSize?: number }} [opts]
 */
export async function fetchMemberUsageEvents(cookieValue, opts = {}) {
  const session = sessionFromCookie(cookieValue);
  if (!session) throw new Error('会话 Token 格式无效');
  const days = Math.min(90, Math.max(1, Number(opts.days) || 30));
  const page = Math.max(1, Number(opts.page) || 1);
  const pageSize = Math.min(100, Math.max(10, Number(opts.pageSize) || 50));
  const end = Date.now();
  const start = end - days * 86400000;

  const data = await fetchJson('https://cursor.com/api/dashboard/get-filtered-usage-events', {
    method: 'POST',
    headers: {
      ...BROWSER_HEADERS,
      'Content-Type': 'application/json',
      Cookie: `WorkosCursorSessionToken=${session.cookieValue}`,
    },
    body: JSON.stringify({
      teamId: 0,
      startDate: String(start),
      endDate: String(end),
      page,
      pageSize,
    }),
  });

  const batch = data.usageEventsDisplay || data.usageEvents || data.events || [];
  const events = batch.map((e) => {
    const tu = e.tokenUsage || null;
    const inputTokens = tu ? num(tu.inputTokens) ?? num(tu.input_tokens) ?? 0 : 0;
    const outputTokens = tu ? num(tu.outputTokens) ?? num(tu.output_tokens) ?? 0 : 0;
    const cacheReadTokens = tu
      ? num(tu.cacheReadTokens) ??
        num(tu.cache_read_tokens) ??
        num(tu.cacheReadInputTokens) ??
        0
      : 0;
    const cacheWriteTokens = tu
      ? num(tu.cacheWriteTokens) ??
        num(tu.cache_write_tokens) ??
        num(tu.cacheCreationInputTokens) ??
        0
      : 0;
    const kind = e.kind || e.usageEventKind || '';
    const rawId = e?.id ?? e?.eventId;
    const row = {
      id: String(rawId ?? `${e.timestamp}-${e.model ?? 'unknown'}`),
      timestamp: e.timestamp ?? e.timestampEpoch ?? 0,
      model: e.model || e.modelIntent || 'unknown',
      kind,
      kindLabel: usageKindLabel(kind),
      isTokenBasedCall: Boolean(e.isTokenBasedCall),
      chargedCents: pickChargedCents(e),
      tokenCents: tu ? num(tu.totalCents) : null,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    };
    row.totalTokens = eventTotalTokens(row);
    row.costLabel = usageCostLabel(row);
    return row;
  });

  const total = num(data.totalUsageEventsCount);
  const hasNext =
    data.pagination?.hasNextPage ??
    (total != null ? page * pageSize < total : batch.length === pageSize);

  return {
    days,
    start,
    end,
    page,
    pageSize,
    total: total ?? events.length,
    hasNext: Boolean(hasNext && batch.length > 0),
    events,
  };
}

/**
 * 对单个成员做完整刷新：面板指标 + 周期事件。
 * @param {string} cookieValue
 */
export async function fetchMemberSnapshot(cookieValue) {
  const session = sessionFromCookie(cookieValue);
  if (!session) throw new Error('会话 Token 格式无效');

  const [me, plan, quota, hardLimit, usageSummary, periodUsage, grokBot, planInfo] =
    await Promise.all([
      fetchMe(session),
      fetchStripeProfile(session),
      fetchPlanQuota(session),
      fetchHardLimit(session),
      fetchUsageSummary(session).catch(() => null),
      fetchCurrentPeriodUsage(session),
      fetchGrokBotUsage(session),
      fetchPlanInfo(session),
    ]);

  const planMeters = mergePlanMeters(usageSummary, periodUsage);

  let window;
  if (planMeters.billingCycleStart && planMeters.billingCycleEnd) {
    const start = new Date(planMeters.billingCycleStart).getTime();
    const end = new Date(planMeters.billingCycleEnd).getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      window = { start, end };
    }
  }
  if (!window) {
    window = billingCycleWindow(
      quota ||
        (planMeters.billingCycleStart
          ? { startOfCycleIso: planMeters.billingCycleStart }
          : null),
    );
  }

  // 一次拉齐：账单周期 ∪ 近 30 本地日，供周期汇总与 Today/Yesterday/Last30。
  const { last30Start } = localDayBounds();
  const fetchStart = Math.min(window.start, last30Start);
  const fetchEnd = Math.max(Date.now(), Math.min(window.end, Date.now()));
  const allEvents = await fetchDashboardUsage(session, fetchStart, fetchEnd);

  const cycleEvents = allEvents.filter((e) => {
    const ts = eventTimestampMs(e.timestamp);
    return ts === 0 || (ts >= window.start && ts <= window.end);
  });
  const usage = summarizeEvents(cycleEvents);
  const spend = aggregateSpendPeriods(allEvents);

  const quotaPercent =
    quota?.limit != null && quota.limit > 0
      ? Math.min(100, Math.round((quota.used / quota.limit) * 1000) / 10)
      : null;
  const spendPercent =
    hardLimit != null && hardLimit > 0
      ? Math.min(100, Math.round((usage.billedDollars / hardLimit) * 1000) / 10)
      : null;
  const primaryPercent = planMeters.totalPercentUsed ?? quotaPercent ?? spendPercent;

  const windowMeta = {
    startIso: new Date(window.start).toISOString(),
    endIso: new Date(window.end).toISOString(),
    resetIso: planMeters.billingCycleEnd || quota?.resetIso,
  };

  const panelLines = buildOpenUsagePanelLines({
    planMeters,
    meters: { primaryPercent, quotaPercent, spendPercent },
    quota,
    grokBot,
    spend,
    window: windowMeta,
  });

  return {
    userId: session.userId,
    email: me.email,
    name: me.name,
    plan: {
      ...plan,
      membershipType: planMeters.membershipType || plan.membershipType,
      planName: planInfo?.planName || null,
      price: planInfo?.price || null,
    },
    quota,
    hardLimit,
    planMeters,
    grokBot,
    spend,
    panelLines,
    window: windowMeta,
    usage,
    meters: {
      primaryPercent,
      totalPercentUsed: planMeters.totalPercentUsed,
      autoPercentUsed: planMeters.autoPercentUsed,
      apiPercentUsed: planMeters.apiPercentUsed,
      planSpendPercent: planMeters.planSpendPercent,
      quotaPercent,
      spendPercent,
    },
    syncedAt: new Date().toISOString(),
  };
}
