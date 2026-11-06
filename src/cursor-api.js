/**
 * Cursor 用量客户端。
 * 用每人一份会话 cookie 调用 cursor.com 非官方 dashboard / Connect 接口，
 * 拉取计划、请求额度、花费上限与账单周期用量。
 */

import { jwtFromCookie, sessionFromCookie } from './auth.js';
import { isSyntheticEventId as isSyntheticEventIdFromUsage } from './usage-events.js';

const USER_AGENT = 'cursor-team-usage/0.1';
const PAGE_SIZE = 100;
/** 单次拉取页数上限；过小会把重度账号周期截成 5000 条，tokens/模型严重偏低。 */
const MAX_PAGES = 500;

/** cursor.com 对状态变更请求做 Origin 校验，需模拟浏览器 dashboard 头。 */
const BROWSER_HEADERS = {
  Origin: 'https://cursor.com',
  Referer: 'https://cursor.com/dashboard',
  'User-Agent': USER_AGENT,
};

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TRANSIENT_ERROR_RE =
  /UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT|UND_ERR_SOCKET|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|EPIPE|ENOTFOUND|fetch failed|请求超时|terminated|other side closed|socket hang up/i;

/**
 * 短暂网络/限流失败：可重试，且有旧快照时不要写成看板上的红条。
 * 401/403 是会话问题，不算短暂。
 */
export function isTransientCursorError(error) {
  if (!error) return false;
  if (error.retryable === true) return true;
  const status = Number(error.status);
  if (status === 408 || status === 425 || status === 429 || status >= 500) return true;
  const code = String(error.code || error.cause?.code || '');
  const msg = String(error.message || error);
  return TRANSIENT_ERROR_RE.test(code) || TRANSIENT_ERROR_RE.test(msg);
}

/**
 * 会话被 Cursor 拒绝（登出/吊销/假 Token）。本机 JWT 未过期仍可能如此。
 * @param {any} error
 */
export function isCursorAuthFailure(error) {
  if (!error) return false;
  const status = Number(error.status);
  if (status === 401 || status === 403) return true;
  const msg = String(error.message || error);
  return /not_authenticated|HTTP 40[13]|会话鉴权失效/i.test(msg);
}

/**
 * 看板对外的 HTTP 状态。Cursor 上游 401 若原样返回，详情页会把人踢回登录页。
 * @param {any} e
 */
export function caughtHttpStatus(e) {
  const msg = String(e?.message || e || '');
  const status = Number(e?.status) || (/不存在/.test(msg) ? 404 : 400);
  if (status !== 401 && status !== 403) return status;
  const code = e?.code;
  if (code === 'UNAUTHORIZED' || code === 'OPERATOR_PROOF' || code === 'INSTALL_TOKEN') return status;
  if (status === 403 && /管理员/.test(msg)) return status;
  if (status === 401 && /用户名或密码错误|未登录/.test(msg)) return status;
  if (/not_authenticated|cursor\.com|api2\.cursor|HTTP 40[13]|会话鉴权/.test(msg)) return 400;
  return status;
}

/**
 * 换 Token 或新号必须探活成功才入库。同一份已失效 Token 静默丢掉。
 * 探活未知也不许覆盖：吊销会话在 /api/auth/me 上是 204，当未知放行会再次盖掉好 Token。
 * @param {{ hasExisting: boolean, sameCookie: boolean, knownDead: boolean, probe: boolean | null }} input
 * @returns {'same-dead' | 'unauth' | 'unverified' | null}
 */
export function uselessReportReason({ hasExisting, sameCookie, knownDead, probe }) {
  if (hasExisting && sameCookie && knownDead) return 'same-dead';
  if (hasExisting && sameCookie) return null;
  if (probe === true) return null;
  if (probe === false) return 'unauth';
  return 'unverified';
}

/**
 * 上报前向用量接口确认会话。true=可用，false=未认证或空响应，null=网络未知。
 * 不用 /api/auth/me：吊销 Token 那里返回 204 空体，会被当成已登录。
 * @param {string} cookieValue
 * @returns {Promise<boolean | null>}
 */
export async function probeCursorSessionAuth(cookieValue) {
  const session = sessionFromCookie(cookieValue);
  if (!session) return false;
  const url = 'https://cursor.com/api/usage-summary';
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        ...BROWSER_HEADERS,
        Cookie: `WorkosCursorSessionToken=${session.cookieValue}`,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401 || res.status === 403 || res.status === 204) return false;
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.trim()) return false;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return false;
    }
    if (!data || typeof data !== 'object') return false;
    if (data.membershipType || data.billingCycleStart || data.individualUsage) return true;
    return false;
  } catch (error) {
    if (isCursorAuthFailure(error)) return false;
    return null;
  }
}

/** 网络抖动、限流和服务端错误可重试；401/403 没有刷新 Token 时重试无意义。 */
function isRetryableError(error) {
  return isTransientCursorError(error);
}

/** 连接超时要多等一会儿，250ms 时对端往往还没恢复。 */
function retryDelayMs(error, attempt) {
  if (error?.retryAfterMs) return error.retryAfterMs;
  const slow = /TIMEOUT|ETIMEDOUT|ENETUNREACH|UND_ERR_CONNECT/i.test(
    String(error?.code || error?.cause?.code || error?.message || ''),
  );
  if (attempt === 0) return slow ? 1000 : 250;
  return slow ? 3000 : 750;
}

/**
 * 单次带超时请求。
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} timeoutMs
 */
async function fetchJsonOnce(url, options, timeoutMs) {
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
      const detail = data?.message || data?.error;
      // 部分接口把错误包成对象返回，String() 会变成 [object Object]；展开后截断，避免整段响应体进日志
      const reason =
        typeof detail === 'string' ? detail : detail ? JSON.stringify(detail).slice(0, 300) : '';
      const err = new Error(
        reason ? `${reason} (HTTP ${res.status}): ${url}` : `HTTP ${res.status}: ${url}`,
      );
      err.status = res.status;
      const retryAfter = Number(res.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        err.retryAfterMs = Math.min(retryAfter * 1000, 5000);
      }
      throw err;
    }
    return data;
  } catch (e) {
    if (e?.name === 'AbortError') {
      const err = new Error(`请求超时: ${url}`);
      err.retryable = true;
      throw err;
    }
    // fetch 的网络层异常只报笼统的 fetch failed / terminated，真实原因（ECONNRESET、连接超时等）在 cause 里
    if (e instanceof TypeError && e.cause) {
      const cause = e.cause;
      const err = new Error(`${e.message} (${cause.code || cause.message || cause.name}): ${url}`, {
        cause,
      });
      err.retryable = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cursor 接口统一重试：首次失败后 250ms、750ms 退避。参考 OpenUsage：
 * 认证失败只在能刷新 Token 时才重试；本服务没有 refresh 流程，因此 401/403 直接返回。
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} [timeoutMs]
 */
async function fetchJson(url, options, timeoutMs = 20000) {
  const maxRetries = 2;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchJsonOnce(url, options, timeoutMs);
    } catch (error) {
      if (attempt >= maxRetries || !isRetryableError(error)) throw error;
      await sleep(retryDelayMs(error, attempt));
    }
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

/** 毫秒时间戳 → ISO；非法则 null。 */
function msToIso(v) {
  const n = num(v);
  if (n == null || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The X Subscription：included 额度按周重置。 */
export function isWeeklyIncludedUsage(period) {
  return String(period || '') === 'INCLUDED_USAGE_PERIOD_WEEKLY';
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
  // The X Subscription 周池内调用
  if (/INCLUDED|CUSTOM_SUBSCRIPTION/i.test(k)) return 'Included';
  if (/USAGE_BASED|ON_?DEMAND|ERRORED/i.test(k)) return 'On-Demand';
  return k.replace(/^USAGE_EVENT_KIND_/, '').replaceAll('_', ' ');
}

/** 官方事件 id：新字段 usageEventId，旧字段 id / eventId。 */
function eventIdFromRaw(e) {
  const raw = e?.usageEventId ?? e?.id ?? e?.eventId;
  if (raw != null && String(raw) !== '' && String(raw) !== 'null') return String(raw);
  return `${e?.timestamp ?? 0}-${e?.model ?? e?.modelIntent ?? 'unknown'}`;
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
      const key = eventIdFromRaw(e);
      if (seenIds.has(key)) continue;
      seenIds.add(key);
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
        id: key,
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
    const modelTokens =
      (e.inputTokens || 0) +
      (e.outputTokens || 0) +
      (e.cacheReadTokens || 0) +
      (e.cacheWriteTokens || 0) ||
      Number(e.totalTokens) ||
      0;
    if (modelTokens > 0) {
      const model = String(e.model || 'unknown');
      byModel[model] = (byModel[model] || 0) + modelTokens;
    }
  }

  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  // 当前周期模型全部保留，前端滚动展示；截断会导致 Claude/GPT 等被挤掉。
  const topModels = Object.entries(byModel)
    .sort((a, b) => b[1] - a[1])
    .map(([model, tokens]) => ({ model, tokens }));

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
 * 周订阅（The X Subscription）优先 period：usage-summary 常仍给月窗与 0%。
 * @param {ReturnType<typeof parseUsageSummary>} summary
 * @param {ReturnType<typeof parsePeriodUsage>} period
 * @param {{ weekly?: boolean, includedUsageResetsAt?: string | null }} [opts]
 */
export function mergePlanMeters(summary, period, opts = {}) {
  const weekly = opts.weekly === true;
  const pick = (sVal, pVal) => (weekly ? (pVal ?? sVal) : (sVal ?? pVal));

  const totalPercentUsed = pick(summary?.totalPercentUsed, period?.totalPercentUsed) ?? null;
  const autoPercentUsed = pick(summary?.autoPercentUsed, period?.autoPercentUsed) ?? null;
  const apiPercentUsed = pick(summary?.apiPercentUsed, period?.apiPercentUsed) ?? null;
  const planUsedCents = summary?.planUsedCents ?? period?.planUsedCents ?? null;
  const planLimitCents = summary?.planLimitCents ?? period?.planLimitCents ?? null;

  let planSpendPercent = null;
  if (planLimitCents != null && planLimitCents > 0 && planUsedCents != null) {
    planSpendPercent = Math.min(100, Math.round((planUsedCents / planLimitCents) * 1000) / 10);
  }

  let billingCycleStart = summary?.billingCycleStart;
  let billingCycleEnd = summary?.billingCycleEnd;
  if (weekly) {
    const periodStart = msToIso(period?.billingCycleStartMs);
    const periodEnd = msToIso(period?.billingCycleEndMs);
    if (periodStart && periodEnd) {
      billingCycleStart = periodStart;
      billingCycleEnd = periodEnd;
    } else if (opts.includedUsageResetsAt) {
      const endMs = Date.parse(opts.includedUsageResetsAt);
      if (Number.isFinite(endMs)) {
        billingCycleEnd = opts.includedUsageResetsAt;
        billingCycleStart = new Date(endMs - 7 * 86400000).toISOString();
      }
    }
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
    billingCycleStart,
    billingCycleEnd,
    onDemand: summary?.onDemand || null,
    planBreakdown: summary?.planBreakdown || null,
    includedUsagePeriod: weekly ? 'INCLUDED_USAGE_PERIOD_WEEKLY' : null,
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
 * 指定本地日按模型汇总 tokens（与日花费同一口径，含 cache write）。
 * @param {Array<{ timestamp?: unknown, model?: string, inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number }>} events
 * @param {string} dayKey yyyy-MM-dd
 * @param {number} [limit] 保留前 N 名；≤0 表示不截断
 * @returns {Array<{ model: string, tokens: number }>}
 */
export function topModelsByTokens(events, dayKey, limit = 8) {
  /** @type {Record<string, number>} */
  const byModel = {};
  const filterDay = dayKey ? String(dayKey) : '';
  for (const e of events) {
    const ts = eventTimestampMs(e.timestamp);
    if (!ts) continue;
    if (filterDay && localDayKey(ts) !== filterDay) continue;
    const tokens =
      (e.inputTokens || 0) +
      (e.outputTokens || 0) +
      (e.cacheReadTokens || 0) +
      (e.cacheWriteTokens || 0) ||
      Number(e.totalTokens) ||
      0;
    if (tokens <= 0) continue;
    const model = String(e.model || 'unknown');
    byModel[model] = (byModel[model] || 0) + tokens;
  }
  const ranked = Object.entries(byModel).sort((a, b) => b[1] - a[1]);
  // 看板要把各账号加总，截断会漏掉单账号用量靠后的模型。
  const picked = limit > 0 ? ranked.slice(0, limit) : ranked;
  return picked.map(([model, tokens]) => ({ model, tokens }));
}

/**
 * 按本地日汇总花费与 token，供 Today / Yesterday / Last 30 Days。
 * 有实际计费用 charged；Included/$0 时回退 token 估值，避免 Included 请求显示为 $0。
 * @param {Array<{ timestamp?: unknown, model?: string, chargedCents: number | null, tokenCents: number | null, inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number }>} events
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
    if (!row || (row.tokens <= 0 && row.dollars <= 0 && row.requests <= 0)) return null;
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
    // 当日按模型 tokens。不截断，否则团队按模型加总会漏掉单账号第 9 名以后的模型。
    todayModels: topModelsByTokens(events, todayKey, 0),
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
      // The X Subscription 与 Cursor 周池合一，勿再单独画 Grok Bot 行
      isUnified: data?.isUnified === true,
      cursorPlanName: data?.cursorPlanName ? String(data.cursorPlanName) : null,
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
      includedUsagePeriod: info.includedUsagePeriod ? String(info.includedUsagePeriod) : null,
      includedUsageResetsAt: msToIso(info.includedUsageResetsAt),
    };
  } catch {
    return null;
  }
}

/**
 * 账号在 Cursor 云端的 User Rules。后端把用户规则存在 Knowledge Base 里，接口名看不出是规则；
 * 与其他接口不同，这里失败直接抛错，让下载按钮能提示真实原因。
 * @param {string} cookieValue
 * @returns {Promise<Array<{ id: string, title: string, content: string, createdAt: string | null }>>}
 */
export async function fetchUserRules(cookieValue) {
  const jwt = jwtFromCookie(cookieValue);
  if (!jwt) throw new Error('会话 Token 格式无效');
  const data = await fetchJson('https://api2.cursor.sh/aiserver.v1.AiService/KnowledgeBaseList', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      'User-Agent': USER_AGENT,
    },
    body: '{}',
  });
  return (data?.allResults || []).map((r) => ({
    id: String(r.id ?? ''),
    title: String(r.title ?? ''),
    content: String(r.knowledge ?? ''),
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : null,
  }));
}

/**
 * 组装面板 metric lines，供前端逐行渲染。
 * @param {{
 *   planMeters: ReturnType<typeof mergePlanMeters>,
 *   meters: Record<string, number | null | undefined>,
 *   quota?: { used: number, limit: number | null } | null,
 *   grokBot?: { usagePercent: number, resetsAt?: string | null, isUnified?: boolean } | null,
 *   spend?: (ReturnType<typeof aggregateSpendPeriods> & {
 *     last30Label?: string,
 *     cycle?: { dollars?: number, tokens?: number, requests?: number } | null,
 *     cycleLabel?: string,
 *   }) | null,
 *   window?: { resetIso?: string },
 * }} input
 */
export function buildOpenUsagePanelLines(input) {
  /** @type {Array<Record<string, unknown>>} */
  const lines = [];
  const pm = input.planMeters || {};
  const resetsAt = input.window?.resetIso || pm.billingCycleEnd || null;
  const weekly = pm.includedUsagePeriod === 'INCLUDED_USAGE_PERIOD_WEEKLY';

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

  // The X Subscription：单一周池，只画 Weekly usage
  if (weekly) {
    pushPercent('Weekly usage', pm.totalPercentUsed);
  } else {
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

    // 统一周池账号的 Grok Bot 与主用量同池，不再单独一行
    if (input.grokBot?.usagePercent != null && !input.grokBot.isUnified) {
      lines.push({
        type: 'progress',
        label: 'Grok Bot usage',
        used: input.grokBot.usagePercent,
        limit: 100,
        format: 'percent',
        resetsAt: input.grokBot.resetsAt || null,
      });
    }
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
    if (!row) return { text: 'No data', dollars: null, tokens: null, requests: null };
    const tokens = row.tokens ?? 0;
    const requests = row.requests ?? 0;
    // 与前端 formatTokens 一致：万 / 亿
    let tokenLabel;
    if (tokens >= 1e8) {
      const v = tokens / 1e8;
      tokenLabel = `${v >= 100 ? v.toFixed(0) : v.toFixed(2).replace(/\.?0+$/, '')}亿`;
    } else if (tokens >= 1e4) {
      const v = tokens / 1e4;
      tokenLabel = `${v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '')}万`;
    } else {
      tokenLabel = String(Math.round(tokens));
    }
    const parts = [`$${Number(row.dollars || 0).toFixed(2)}`, tokenLabel];
    return {
      text: parts.join(' · '),
      dollars: row.dollars,
      tokens: row.tokens,
      requests,
    };
  };

  lines.push({
    type: 'spend-row',
    label: 'Spend',
    today: fmtCell(input.spend?.today),
    yesterday: fmtCell(input.spend?.yesterday),
    last30: fmtCell(input.spend?.last30),
    // Last 30 Days 固定近 30 自然日；当前周期单独一格（周订=有效周窗，非日历周）
    last30Label: input.spend?.last30Label || 'Last 30 Days',
    cycle: fmtCell(input.spend?.cycle),
    cycleLabel: input.spend?.cycleLabel || currentCycleSpendLabel(weekly),
    estimated: true,
  });

  return lines;
}

/**
 * Connect RPC 聚合用量（按模型 token / 花费），事件列表为空时补周期 token。
 * @param {{ cookieValue: string }} session
 * @param {number} startMs
 * @param {number} endMs
 */
export async function fetchAggregatedUsageEvents(session, startMs, endMs) {
  const jwt = jwtFromCookie(session.cookieValue);
  if (!jwt) return null;
  try {
    const data = await fetchJson(
      'https://api2.cursor.sh/aiserver.v1.DashboardService/GetAggregatedUsageEvents',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify({
          startDate: String(startMs),
          endDate: String(endMs),
        }),
      },
    );
    const aggregations = Array.isArray(data?.aggregations) ? data.aggregations : [];
    if (!aggregations.length && num(data?.totalInputTokens) == null) return null;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    /** @type {Array<{ model: string, tokens: number, costCents: number }>} */
    const topModels = [];
    for (const row of aggregations) {
      const input = num(row.inputTokens) ?? 0;
      const output = num(row.outputTokens) ?? 0;
      const cacheRead = num(row.cacheReadTokens) ?? 0;
      const costCents = num(row.totalCents) ?? 0;
      inputTokens += input;
      outputTokens += output;
      cacheReadTokens += cacheRead;
      topModels.push({
        model: String(row.modelIntent || row.model || 'unknown'),
        tokens: input + output + cacheRead,
        costCents,
      });
    }
    if (!aggregations.length) {
      inputTokens = num(data.totalInputTokens) ?? 0;
      outputTokens = num(data.totalOutputTokens) ?? 0;
      cacheReadTokens = num(data.totalCacheReadTokens) ?? 0;
    }
    const totalTokens = inputTokens + outputTokens + cacheReadTokens;
    const billedCents = num(data.totalCostCents) ?? topModels.reduce((s, m) => s + m.costCents, 0);
    topModels.sort((a, b) => b.tokens - a.tokens);
    return {
      requestCount: aggregations.length,
      billedDollars: Math.round((billedCents / 100) * 100) / 100,
      tokenValueDollars: Math.round((billedCents / 100) * 100) / 100,
      totalTokens,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens: 0,
      topModels: topModels.map(({ model, tokens }) => ({ model, tokens })),
    };
  } catch {
    return null;
  }
}

/**
 * The X Subscription：周池状态（grok.com Usage 同源，走 cursor.com v2）。
 * @param {{ cookieValue: string }} session
 */
export async function fetchV2UsageStatus(session) {
  const data = await fetchJson(
    'https://cursor.com/api/dashboard/v2/usage-status?scope=user',
    {
      method: 'GET',
      headers: {
        ...BROWSER_HEADERS,
        Cookie: `WorkosCursorSessionToken=${session.cookieValue}`,
      },
    },
  );
  const weekly = data?.weeklyIncludedUsage || null;
  if (!weekly) return null;
  const usedCents = num(weekly.usedCents) ?? 0;
  const budgetCents = num(weekly.budgetCents) ?? 0;
  const percent =
    budgetCents > 0 ? Math.round((usedCents / budgetCents) * 1000) / 10 : null;
  return {
    usedCents,
    budgetCents,
    percent,
    periodStart: typeof weekly.periodStart === 'string' ? weekly.periodStart : null,
    resetsAt: typeof weekly.resetsAt === 'string' ? weekly.resetsAt : null,
    additionalUsageOff: Boolean(data?.monthlyUsage?.additionalUsageOff),
  };
}

/**
 * v2 billing item → 看板事件行（含 token 明细）。
 * @param {any} item
 */
export function billingItemToEvent(item) {
  if (!item || typeof item !== 'object') return null;
  const usage = item.usage || {};
  const inputTokens = num(usage['prompt-text-tokens']) ?? 0;
  const outputTokens = num(usage['completion-text-tokens']) ?? 0;
  const cacheReadTokens = num(usage['cached-prompt-text-tokens']) ?? 0;
  const cacheWriteTokens = num(usage['cache-write-text-tokens']) ?? 0;
  const totalFromFields = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const totalTokens = num(item.totalTokens) ?? totalFromFields;
  const usageType = String(item.usageType || '').toLowerCase();
  const kind =
    usageType === 'included'
      ? 'USAGE_EVENT_KIND_INCLUDED'
      : usageType === 'credit' || usageType === 'on_demand' || usageType === 'ondemand'
        ? 'USAGE_EVENT_KIND_USAGE_BASED'
        : `USAGE_EVENT_KIND_${String(item.usageType || 'CUSTOM').toUpperCase()}`;
  const contracted = num(item?.pricing?.contracted) ?? 0;
  const chargedCents = contracted > 0 ? Math.round(contracted * 10000) / 100 : 0;
  const model = String(item?.displayExtras?.model || item?.model || 'unknown');
  const ts = Date.parse(item.eventTime || '');
  const row = {
    id: String(item.billingItemId || `${item.eventTime}-${model}`),
    timestamp: Number.isFinite(ts) ? ts : 0,
    model,
    kind,
    kindLabel: usageKindLabel(kind),
    isTokenBasedCall: item.hasTokenMeters !== false,
    chargedCents: chargedCents > 0 ? chargedCents : 0,
    tokenCents: null,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    product: item.product ? String(item.product) : null,
  };
  row.totalTokens = totalTokens || eventTotalTokens(row);
  row.costLabel = usageCostLabel(row);
  return row;
}

/**
 * The X 账单明细（grok.com Usage events 同源）。
 * @param {{ cookieValue: string }} session
 * @param {string} startIso
 * @param {string} endIso
 * @param {{ pageSize?: number, maxPages?: number }} [opts]
 */
export async function fetchV2BillingItems(session, startIso, endIso, opts = {}) {
  const pageSize = Math.min(100, Math.max(1, Number(opts.pageSize) || 100));
  const maxPages = Math.min(MAX_PAGES, Math.max(1, Number(opts.maxPages) || MAX_PAGES));
  /** @type {ReturnType<typeof billingItemToEvent>[]} */
  const events = [];
  let cursor = '';
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({
      scope: 'user',
      startTime: startIso,
      endTime: endIso,
      pageSize: String(pageSize),
    });
    if (cursor) qs.set('cursor', cursor);
    const data = await fetchJson(
      `https://cursor.com/api/dashboard/v2/query-billing-items?${qs}`,
      {
        method: 'GET',
        headers: {
          ...BROWSER_HEADERS,
          Cookie: `WorkosCursorSessionToken=${session.cookieValue}`,
        },
      },
    );
    const batch = Array.isArray(data?.data) ? data.data : [];
    for (const item of batch) {
      const row = billingItemToEvent(item);
      if (row) events.push(row);
    }
    if (!data?.pagination?.hasMore || !data?.pagination?.nextCursor) break;
    cursor = String(data.pagination.nextCursor);
    if (!batch.length) break;
  }
  return events;
}

/**
 * 按日 / 按模型 token（Tokens per day 图同源）。
 * @param {{ cookieValue: string }} session
 * @param {string} startIso
 * @param {string} endIso
 * @param {string[]} [groupBy]
 */
export async function fetchV2DailyUsage(session, startIso, endIso, groupBy = ['model']) {
  const data = await fetchJson('https://cursor.com/api/dashboard/v2/query-daily-usage', {
    method: 'POST',
    headers: {
      ...BROWSER_HEADERS,
      'Content-Type': 'application/json',
      Cookie: `WorkosCursorSessionToken=${session.cookieValue}`,
    },
    body: JSON.stringify({
      scope: 'user',
      startTime: startIso,
      endTime: endIso,
      groupBy,
    }),
  });
  const series = Array.isArray(data?.series) ? data.series : [];
  /** @type {Array<{ model: string, tokens: number }>} */
  const topModels = series
    .map((s) => ({
      model: String(s?.dimensions?.model || 'unknown'),
      tokens: num(s?.totalTokens) ?? 0,
    }))
    .filter((m) => m.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
  /** @type {Map<string, { date: string, tokens: number, dollars: number, requests: number }>} */
  const dailyMap = new Map();
  /** @type {Map<string, Map<string, number>>} */
  const modelsByDayMap = new Map();
  for (const s of series) {
    const model = String(s?.dimensions?.model || 'unknown');
    for (const p of s?.points || []) {
      const day = String(p.dayStartTime || '').slice(0, 10);
      if (!day) continue;
      const tokens = num(p.tokens) ?? 0;
      const prev = dailyMap.get(day) || { date: day, tokens: 0, dollars: 0, requests: 0 };
      prev.tokens += tokens;
      dailyMap.set(day, prev);
      if (tokens > 0) {
        const dayModels = modelsByDayMap.get(day) || new Map();
        dayModels.set(model, (dayModels.get(model) || 0) + tokens);
        modelsByDayMap.set(day, dayModels);
      }
    }
  }
  /** @type {Record<string, Array<{ model: string, tokens: number }>>} */
  const modelsByDay = {};
  for (const [day, byModel] of modelsByDayMap) {
    modelsByDay[day] = [...byModel.entries()]
      .map(([model, tokens]) => ({ model, tokens }))
      .sort((a, b) => b.tokens - a.tokens);
  }
  return {
    totalTokens: num(data?.totalTokens) ?? topModels.reduce((s, m) => s + m.tokens, 0),
    totalIncludedTokens: num(data?.totalIncludedTokens) ?? null,
    topModels,
    daily: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    modelsByDay,
  };
}

/**
 * 从 v2 日用量里取某一本地日的模型 tokens 排行。
 * @param {{ modelsByDay?: Record<string, Array<{ model: string, tokens: number }>> } | null | undefined} dailyUsage
 * @param {string} dayKey
 * @param {number} [limit]
 */
export function topModelsForLocalDay(dailyUsage, dayKey, limit = 8) {
  const rows = dailyUsage?.modelsByDay?.[String(dayKey || '')] || [];
  if (!rows.length) return [];
  return limit > 0 ? rows.slice(0, limit) : rows;
}

/**
 * 把 v2 日用量按账单有效窗（订阅起点→min(现在, 重置日)）聚合成模型排行。
 * 避免用近 30 天全窗 topModels 冒充当前周期（周订尤其容易串）。
 * @param {{ modelsByDay?: Record<string, Array<{ model: string, tokens: number }>> } | null | undefined} dailyUsage
 * @param {number} startMs
 * @param {number} endMs
 * @param {number} [limit]
 * @returns {{ topModels: Array<{ model: string, tokens: number }>, totalTokens: number }}
 */
export function topModelsFromDailyUsageInRange(dailyUsage, startMs, endMs, limit = 8) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return { topModels: [], totalTokens: 0 };
  }
  const startKey = localDayKey(startMs);
  const endKey = localDayKey(endMs);
  /** @type {Record<string, number>} */
  const byModel = {};
  let totalTokens = 0;
  for (const [day, rows] of Object.entries(dailyUsage?.modelsByDay || {})) {
    if (day < startKey || day > endKey) continue;
    for (const r of rows || []) {
      const tokens = Number(r.tokens) || 0;
      if (tokens <= 0) continue;
      const model = String(r.model || 'unknown');
      byModel[model] = (byModel[model] || 0) + tokens;
      totalTokens += tokens;
    }
  }
  const ranked = Object.entries(byModel).sort((a, b) => b[1] - a[1]);
  const picked = limit > 0 ? ranked.slice(0, limit) : ranked;
  return {
    topModels: picked.map(([model, tokens]) => ({ model, tokens })),
    totalTokens,
  };
}

/**
 * 当前周期 spend 格标签：周订（xAI / The X）用「本周」，否则「当前周期」。
 * @param {boolean} weekly
 */
export function currentCycleSpendLabel(weekly) {
  return weekly ? '本周' : '当前周期';
}

/** @param {unknown} id */
export function isSyntheticEventId(id) {
  return isSyntheticEventIdFromUsage(id);
}

/**
 * 同笔调用指纹（多面板 / legacy+v2 去重用）。
 * @param {any} e
 */
export function eventFingerprint(e) {
  const ts = eventTimestampMs(e?.timestamp);
  const model = String(e?.model || 'unknown');
  const tokens =
    (e?.inputTokens || 0) +
      (e?.outputTokens || 0) +
      (e?.cacheReadTokens || 0) +
      (e?.cacheWriteTokens || 0) ||
    Number(e?.totalTokens) ||
    0;
  return `${ts}|${model}|${Math.round(tokens)}`;
}

/**
 * 多源事件按 id 合并，再按指纹去重（优先保留真实 UUID、token 更全的行）。
 * @param {...Array<any | null | undefined>} lists
 */
export function mergeUsageEventsById(...lists) {
  /** @type {Map<string, any>} */
  const byId = new Map();
  const score = (e) =>
    (e?.inputTokens || 0) +
    (e?.outputTokens || 0) +
    (e?.cacheReadTokens || 0) +
    (e?.cacheWriteTokens || 0) +
    (e?.totalTokens || 0);
  const prefer = (a, b) => {
    const aSyn = isSyntheticEventId(a?.id);
    const bSyn = isSyntheticEventId(b?.id);
    if (aSyn !== bSyn) return aSyn ? b : a;
    return score(a) >= score(b) ? a : b;
  };
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (!e) continue;
      const id = String(e.id || '');
      if (!id) continue;
      const prev = byId.get(id);
      byId.set(id, prev ? prefer(prev, e) : e);
    }
  }
  const rows = [...byId.values()];
  const realFingerprints = new Set(
    rows.filter((e) => !isSyntheticEventId(e?.id)).map((e) => eventFingerprint(e)),
  );
  // 仅清理与真实 UUID 对应的旧版伪 ID。两个真实 UUID 即使时间、模型、token 相同也不能合并。
  return rows
    .filter(
      (e) =>
        !isSyntheticEventId(e?.id) || !realFingerprints.has(eventFingerprint(e)),
    )
    .sort(
    (a, b) => eventTimestampMs(b.timestamp) - eventTimestampMs(a.timestamp),
  );
}

/**
 * legacy 明细 + v2 billing-items 合并拉取，避免周池/部分账号漏事件。
 * @param {{ cookieValue: string }} session
 * @param {number} startMs
 * @param {number} endMs
 */
export async function fetchUsageEventsMerged(session, startMs, endMs) {
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(Math.max(endMs, startMs)).toISOString();
  /** @type {Error | null} */
  let legacyErr = null;
  /** @type {Error | null} */
  let billingErr = null;
  const [legacy, billing] = await Promise.all([
    fetchDashboardUsage(session, startMs, endMs).catch((e) => {
      legacyErr = e instanceof Error ? e : new Error(String(e));
      return [];
    }),
    fetchV2BillingItems(session, startIso, endIso, { maxPages: MAX_PAGES }).catch((e) => {
      billingErr = e instanceof Error ? e : new Error(String(e));
      return [];
    }),
  ]);
  const merged = mergeUsageEventsById(legacy, billing);
  if (!merged.length && (legacyErr || billingErr)) {
    throw legacyErr || billingErr;
  }
  return merged;
}

/**
 * 事件列表 → spend 单元格（本周 / 周期汇总）。
 * @param {Array<{ chargedCents?: number | null, tokenCents?: number | null, inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number }>} events
 */
export function spendCellFromEvents(events) {
  if (!Array.isArray(events) || !events.length) return null;
  let dollars = 0;
  let tokens = 0;
  for (const e of events) {
    const t =
      (e.inputTokens || 0) +
      (e.outputTokens || 0) +
      (e.cacheReadTokens || 0) +
      (e.cacheWriteTokens || 0);
    tokens += t;
    if (e.chargedCents != null && e.chargedCents > 0) dollars += e.chargedCents / 100;
    else if (e.tokenCents != null && e.tokenCents > 0) dollars += e.tokenCents / 100;
  }
  return {
    dollars: Math.round(dollars * 100) / 100,
    tokens,
    requests: events.length,
    estimated: true,
  };
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
    const row = {
      id: eventIdFromRaw(e),
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
 * 整次快照再补一轮：单接口已重试仍可能整组 Promise.all 一起失败。
 * @param {string} cookieValue
 */
export async function fetchMemberSnapshotWithRetry(cookieValue) {
  try {
    return await fetchMemberSnapshot(cookieValue);
  } catch (e) {
    if (!isTransientCursorError(e)) throw e;
    await sleep(2000);
    return await fetchMemberSnapshot(cookieValue);
  }
}

/**
 * 对单个成员做完整刷新：面板指标 + 周期事件。
 * @param {string} cookieValue
 */
export async function fetchMemberSnapshot(cookieValue) {
  const session = sessionFromCookie(cookieValue);
  if (!session) throw new Error('会话 Token 格式无效');

  const warnings = [];
  const optional = async (label, promise, fallback) => {
    try {
      return await promise;
    } catch (error) {
      warnings.push(`${label}: ${error?.message || String(error)}`);
      return fallback;
    }
  };

  const [me, plan, quota, hardLimit, usageSummary, periodUsage, grokBot, planInfo] =
    await Promise.all([
      fetchMe(session),
      optional('套餐', fetchStripeProfile(session), {
        membershipType: 'unknown',
        daysRemainingOnTrial: null,
        teamId: null,
        isTeamMember: false,
      }),
      optional('请求额度', fetchPlanQuota(session), null),
      optional('按量上限', fetchHardLimit(session), null),
      optional('用量摘要', fetchUsageSummary(session), null),
      fetchCurrentPeriodUsage(session),
      fetchGrokBotUsage(session),
      fetchPlanInfo(session),
    ]);

  const weekly = isWeeklyIncludedUsage(planInfo?.includedUsagePeriod);
  let planMeters = mergePlanMeters(usageSummary, periodUsage, {
    weekly,
    includedUsageResetsAt: planInfo?.includedUsageResetsAt,
  });

  // grok.com Usage 同源：周池 used/budget 比 period 百分比更准
  const v2Status = weekly
    ? await optional('周池状态', fetchV2UsageStatus(session), null)
    : null;
  if (weekly && v2Status?.percent != null) {
    planMeters = {
      ...planMeters,
      totalPercentUsed: v2Status.percent,
      autoPercentUsed: v2Status.percent,
      billingCycleStart: v2Status.periodStart || planMeters.billingCycleStart,
      billingCycleEnd: v2Status.resetsAt || planMeters.billingCycleEnd,
      weeklyUsedCents: v2Status.usedCents,
      weeklyBudgetCents: v2Status.budgetCents,
    };
  }

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

  const { last30Start } = localDayBounds();
  const fetchStart = Math.min(window.start, last30Start);
  const fetchEnd = Math.max(Date.now(), Math.min(window.end, Date.now()));
  /** @type {any[]} */
  const allEvents = await optional(
    '用量事件',
    fetchUsageEventsMerged(session, fetchStart, fetchEnd),
    [],
  );

  const authFailures = warnings.filter((warning) =>
    /not_authenticated|HTTP 40[13]/i.test(warning),
  );
  if (authFailures.length >= 3) {
    throw new Error(
      `会话鉴权失效：${authFailures
        .map((warning) => warning.split(': ')[0])
        .join('、')}返回未认证，请更新 Token`,
    );
  }

  const cycleEvents = allEvents.filter((e) => {
    const ts = eventTimestampMs(e.timestamp);
    return ts === 0 || (ts >= window.start && ts <= window.end);
  });
  let usage = summarizeEvents(cycleEvents);
  // 有效窗：订阅起点 → min(现在, 重置/到期)；周订不得按日历周外推。
  const cycleEndMs = Math.min(window.end, Date.now());

  const dailyStartIso = new Date(fetchStart).toISOString();
  const dailyEndIso = new Date(fetchEnd + 86400000).toISOString();
  const dailyUsage = await optional(
    '日用量',
    fetchV2DailyUsage(session, dailyStartIso, dailyEndIso, ['model']),
    null,
  );
  // 官方按日聚合无分页截断；事件列表再全也可能漏。周期模型/tokens 取二者更大者。
  if (dailyUsage?.modelsByDay) {
    const fromDaily = topModelsFromDailyUsageInRange(dailyUsage, window.start, cycleEndMs, 0);
    if (
      fromDaily.topModels.length &&
      (fromDaily.totalTokens > usage.totalTokens || !usage.topModels.length)
    ) {
      usage = {
        ...usage,
        topModels: fromDaily.topModels,
        totalTokens: fromDaily.totalTokens,
      };
    }
  }
  if (usage.totalTokens === 0 && usage.requestCount === 0) {
    const agg = await optional(
      '聚合用量',
      fetchAggregatedUsageEvents(session, window.start, cycleEndMs),
      null,
    );
    if (agg && (agg.totalTokens > 0 || agg.requestCount > 0)) usage = agg;
  }

  const spend = aggregateSpendPeriods(allEvents);
  if (dailyUsage?.daily?.length) {
    // 用 v2 日 token 补 spend.daily 里缺 token 的日期
    const byDate = new Map((spend.daily || []).map((d) => [d.date, { ...d }]));
    for (const d of dailyUsage.daily) {
      const prev = byDate.get(d.date) || { date: d.date, dollars: 0, tokens: 0, requests: 0 };
      if (!prev.tokens && d.tokens) prev.tokens = d.tokens;
      byDate.set(d.date, prev);
    }
    spend.daily = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }
  const { todayKey } = localDayBounds();
  // 今日排行只认「今天」；禁止用整窗 / 周期 topModels 冒充今日。
  let todayModels = topModelsByTokens(allEvents, todayKey, 8);
  if (!todayModels.length) {
    todayModels = topModelsForLocalDay(dailyUsage, todayKey, 8);
  }
  spend.todayModels = todayModels;
  spend.todayModelsFallback = false;

  // Last 30 Days 始终近 30 日；当前周期另格（周订=本周有效窗内用量）。
  spend.last30Label = 'Last 30 Days';
  let cycleCell = spendCellFromEvents(cycleEvents);
  if (cycleCell && usage.totalTokens > (cycleCell.tokens || 0)) {
    cycleCell = { ...cycleCell, tokens: usage.totalTokens };
  } else if (!cycleCell && usage.totalTokens > 0) {
    cycleCell = {
      dollars: usage.billedDollars || 0,
      tokens: usage.totalTokens,
      requests: usage.requestCount || cycleEvents.length || 0,
      estimated: true,
    };
  }
  spend.cycle = cycleCell;
  spend.cycleLabel = currentCycleSpendLabel(weekly);

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
      includedUsagePeriod: planInfo?.includedUsagePeriod || null,
    },
    quota,
    hardLimit,
    planMeters,
    grokBot,
    spend,
    panelLines,
    window: windowMeta,
    usage,
    warnings,
    meters: {
      primaryPercent,
      totalPercentUsed: planMeters.totalPercentUsed,
      autoPercentUsed: planMeters.autoPercentUsed,
      apiPercentUsed: planMeters.apiPercentUsed,
      planSpendPercent: planMeters.planSpendPercent,
      quotaPercent,
      spendPercent,
      weeklyUsedCents: planMeters.weeklyUsedCents ?? null,
      weeklyBudgetCents: planMeters.weeklyBudgetCents ?? null,
    },
    syncedAt: new Date().toISOString(),
    // 仅刷新路径落库用，勿写入 last_snapshot（体量大）。
    _usageEvents: allEvents,
  };
}
