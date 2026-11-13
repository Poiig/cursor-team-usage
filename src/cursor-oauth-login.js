/**
 * Cursor 桌面 OAuth（PKCE + loginDeepControl + auth/poll）。
 * 与 @cursor/sdk login-flow 同口径：优先 POST 轮询（verifier 不进 URL），404 未完成再等；
 * 若后端无 POST 路由则回退 GET。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  buildCookieValue,
  decodeJwtPayload,
  sessionFromCookie,
  userIdFromSub,
} from './auth.js';

const LOGIN_URL = 'https://cursor.com/loginDeepControl';
const POLL_URL = 'https://api2.cursor.sh/auth/poll';
const PROFILE_URL = 'https://cursor.com/api/auth/me';
/** 与 SDK 默认约 20 分钟窗口对齐（150 次退避轮询量级）。 */
export const OAUTH_LOGIN_TTL_MS = 20 * 60 * 1000;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Cursor/2.0.0 Chrome/132.0.0.0 Electron/34.0.0 Safari/537.36';

/** 后端用该正文表示「尚未登录」；其它 404 正文视为「无 POST 路由」。 */
const PENDING_NOT_FOUND = 'Not found';

/** @type {Map<string, OAuthLoginSession>} */
const pendingLogins = new Map();

/** 测试可注入；生产用全局 fetch。 */
let fetchFn = globalThis.fetch.bind(globalThis);

/**
 * @param {typeof fetch | null} fn
 */
export function setOAuthFetchForTests(fn) {
  fetchFn = fn || globalThis.fetch.bind(globalThis);
}

/**
 * @typedef {{
 *   loginId: string,
 *   uuid: string,
 *   verifier: string,
 *   displayName: string,
 *   memberId: string | null,
 *   createdAt: number,
 *   expiresAt: number,
 *   stage: 'pending' | 'done',
 *   preferGet: boolean,
 *   claiming: boolean,
 *   result: null | {
 *     cookieValue: string,
 *     email: string | null,
 *     displayName: string,
 *     typedDisplayName: string,
 *     memberId: string | null,
 *   },
 * }} OAuthLoginSession
 */

/**
 * @param {Buffer | string} input
 */
function base64Url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/**
 * PKCE S256：32 字节随机 verifier → challenge。
 */
export function generatePkce() {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/**
 * @param {{ challenge: string, uuid: string }} input
 */
export function buildCursorAuthorizeUrl(input) {
  const url = new URL(LOGIN_URL);
  url.searchParams.set('challenge', input.challenge);
  url.searchParams.set('uuid', input.uuid);
  url.searchParams.set('mode', 'login');
  url.searchParams.set('redirectTarget', 'cli');
  return url.toString();
}

function pruneExpired() {
  const now = Date.now();
  for (const [id, session] of pendingLogins) {
    if (session.expiresAt <= now) pendingLogins.delete(id);
  }
}

/** 测试用：清空内存中的登录会话。 */
export function resetOAuthLoginsForTests() {
  pendingLogins.clear();
}

/**
 * 开启一轮浏览器登录；返回授权 URL 供前端打开。
 * @param {{ displayName?: string, memberId?: string }} [input]
 */
export function startCursorOAuthLogin(input = {}) {
  pruneExpired();
  const pkce = generatePkce();
  const uuid = randomUUID();
  const loginId = randomUUID();
  const now = Date.now();
  /** @type {OAuthLoginSession} */
  const session = {
    loginId,
    uuid,
    verifier: pkce.verifier,
    displayName: String(input.displayName || '').trim(),
    memberId: String(input.memberId || '').trim() || null,
    createdAt: now,
    expiresAt: now + OAUTH_LOGIN_TTL_MS,
    stage: 'pending',
    preferGet: false,
    claiming: false,
    result: null,
  };
  pendingLogins.set(loginId, session);
  return {
    loginId,
    authorizeUrl: buildCursorAuthorizeUrl({
      challenge: pkce.challenge,
      uuid,
    }),
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

/**
 * 解析 poll 响应里的 access / refresh（兼容 camelCase 与 snake_case）。
 * @param {any} data
 */
export function parseCursorPollTokens(data) {
  if (!data || typeof data !== 'object') return null;
  const accessToken = data.accessToken || data.access_token;
  if (!accessToken || typeof accessToken !== 'string') return null;
  const refreshToken = data.refreshToken || data.refresh_token || accessToken;
  return {
    accessToken,
    refreshToken: typeof refreshToken === 'string' ? refreshToken : accessToken,
  };
}

/**
 * @param {string} accessToken
 */
function cookieFromAccessToken(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  const sub = payload?.sub ? String(payload.sub) : '';
  if (!sub) return null;
  const cookieValue = buildCookieValue(userIdFromSub(sub), accessToken);
  return sessionFromCookie(cookieValue) ? cookieValue : null;
}

/**
 * @param {string} cookieValue
 */
async function fetchProfileEmail(cookieValue) {
  try {
    const res = await fetchFn(PROFILE_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': UA,
        Origin: 'https://cursor.com',
        Referer: 'https://cursor.com/dashboard',
        Cookie: `WorkosCursorSessionToken=${cookieValue}`,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { email: null, name: null };
    const data = await res.json();
    return {
      email: typeof data?.email === 'string' ? data.email : null,
      name: typeof data?.name === 'string' ? data.name : null,
    };
  } catch {
    return { email: null, name: null };
  }
}

/**
 * 向 Cursor 打一次 auth/poll：优先 POST，无路由时粘性回退 GET。
 * @param {OAuthLoginSession} session
 * @returns {Promise<{ kind: 'pending' } | { kind: 'tokens', tokens: { accessToken: string, refreshToken: string } } | { kind: 'error', error: string, fatal?: boolean }>}
 */
export async function fetchCursorAuthPollOnce(session) {
  const headersBase = {
    Accept: 'application/json',
    'User-Agent': UA,
  };

  /** @type {Response} */
  let res;
  try {
    if (session.preferGet) {
      const pollUrl = `${POLL_URL}?uuid=${encodeURIComponent(session.uuid)}&verifier=${encodeURIComponent(session.verifier)}`;
      res = await fetchFn(pollUrl, {
        method: 'GET',
        headers: headersBase,
        signal: AbortSignal.timeout(15000),
      });
    } else {
      res = await fetchFn(POLL_URL, {
        method: 'POST',
        headers: {
          ...headersBase,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ uuid: session.uuid, verifier: session.verifier }),
        signal: AbortSignal.timeout(15000),
      });
    }
  } catch (error) {
    return {
      kind: 'error',
      error: error?.message || String(error),
      fatal: false,
    };
  }

  if (res.status === 404) {
    const text = (await res.text().catch(() => '')).trim();
    // POST 且正文不是「尚未登录」→ 后端无此路由，改 GET（与 SDK 一致）
    if (!session.preferGet && text !== PENDING_NOT_FOUND) {
      session.preferGet = true;
      return fetchCursorAuthPollOnce(session);
    }
    return { kind: 'pending' };
  }
  if (res.status === 202) return { kind: 'pending' };

  if (!res.ok) {
    if (res.status >= 500) return { kind: 'pending' };
    const text = await res.text().catch(() => '');
    return {
      kind: 'error',
      fatal: true,
      error: text
        ? `登录轮询失败（HTTP ${res.status}）：${text.slice(0, 120)}`
        : `登录轮询失败（HTTP ${res.status}）`,
    };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { kind: 'pending' };
  }
  const tokens = parseCursorPollTokens(data);
  if (!tokens) return { kind: 'pending' };
  return { kind: 'tokens', tokens };
}

/**
 * 轮询一次；未完成返回 pending，成功返回 cookie 供入池。
 * @param {string} loginId
 */
export async function pollCursorOAuthLogin(loginId) {
  pruneExpired();
  const id = String(loginId || '').trim();
  const session = pendingLogins.get(id);
  if (!session) {
    return { status: 'expired', error: '登录会话不存在或已过期，请重新开始' };
  }
  if (Date.now() > session.expiresAt) {
    pendingLogins.delete(id);
    return { status: 'expired', error: '登录已超时，请重新开始' };
  }
  // 入池中：其它并发 poll 继续等，避免「会话不存在」误报
  if (session.claiming) {
    return { status: 'pending' };
  }
  if (session.stage === 'done' && session.result) {
    return { status: 'done', ...session.result };
  }

  const polled = await fetchCursorAuthPollOnce(session);
  if (polled.kind === 'pending') return { status: 'pending' };
  if (polled.kind === 'error') {
    if (polled.fatal) {
      pendingLogins.delete(id);
      return { status: 'error', error: polled.error };
    }
    return { status: 'pending', error: polled.error };
  }

  const cookieValue = cookieFromAccessToken(polled.tokens.accessToken);
  if (!cookieValue) {
    pendingLogins.delete(id);
    return { status: 'error', error: '登录成功但会话 Token 无效' };
  }

  const profile = await fetchProfileEmail(cookieValue);
  const typedDisplayName = session.displayName;
  const displayName = typedDisplayName || profile.email || profile.name || session.uuid;
  const result = {
    cookieValue,
    email: profile.email,
    displayName,
    typedDisplayName,
    memberId: session.memberId,
  };
  session.stage = 'done';
  session.result = result;
  return { status: 'done', ...result };
}

/**
 * 认领已完成的登录结果并加锁，防止并发 poll 重复入池；失败可 release。
 * @param {string} loginId
 * @returns {null | { status: 'busy' } | { status: 'ok', result: NonNullable<OAuthLoginSession['result']>, release: () => void, consume: () => void }}
 */
export function beginClaimCursorOAuthLogin(loginId) {
  const id = String(loginId || '').trim();
  const session = pendingLogins.get(id);
  if (!session || session.stage !== 'done' || !session.result) return null;
  if (session.claiming) return { status: 'busy' };
  session.claiming = true;
  const result = session.result;
  return {
    status: 'ok',
    result,
    release: () => {
      const cur = pendingLogins.get(id);
      if (cur) cur.claiming = false;
    },
    consume: () => {
      pendingLogins.delete(id);
    },
  };
}

/**
 * 入池或更新完成后清掉 pending，避免重复消费。
 * @param {string} loginId
 */
export function consumeCursorOAuthLogin(loginId) {
  pendingLogins.delete(String(loginId || '').trim());
}
