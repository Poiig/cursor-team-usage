/**
 * Cursor AuthKit 邮箱验证码登录：把 magic-code 流程换成 WorkosCursorSessionToken。
 * 供管理员代登入池；不存 Cursor 密码。Cloudflare / Turnstile 挡路时抛明确错误。
 */

import { randomUUID } from 'node:crypto';
import { normalizeManualToken, sessionFromCookie } from './auth.js';

const AUTH_ORIGIN = 'https://authenticator.cursor.sh';
const CURSOR_ORIGIN = 'https://cursor.com';
const CALLBACK_URI = `${CURSOR_ORIGIN}/api/auth/callback`;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 待校验登录会话 TTL：与 AuthKit magic code 过期时间对齐。 */
export const EMAIL_LOGIN_TTL_MS = 10 * 60 * 1000;

/** @type {Map<string, EmailLoginSession>} */
const pendingLogins = new Map();

/**
 * @typedef {{
 *   loginId: string,
 *   email: string,
 *   displayName: string,
 *   createdAt: number,
 *   expiresAt: number,
 *   jar: CookieJar,
 *   state: string,
 *   authorizationSessionId: string,
 *   redirectUri: string,
 *   pageUrl: string,
 *   verifyActionId: string | null,
 *   stage: 'awaiting_code' | 'done',
 * }} EmailLoginSession
 */

/**
 * 简易 Cookie 罐：AuthKit → cursor.com 跨域换 Token 时手工携带。
 */
export class CookieJar {
  constructor() {
    /** @type {Map<string, string>} */
    this.map = new Map();
  }

  /**
   * @param {Response} res
   */
  absorb(res) {
    const list =
      typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const raw of list) {
      const part = String(raw).split(';')[0];
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      this.map.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
  }

  /** @returns {string} */
  header() {
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** @param {string} name */
  get(name) {
    return this.map.get(name) || null;
  }
}

/**
 * @param {string} text
 */
export function isCloudflareChallenge(text) {
  const s = String(text || '');
  return (
    s.includes('Just a moment') ||
    s.includes('cf-mitigated') ||
    s.includes('challenge-platform') ||
    s.includes('Enable JavaScript and cookies to continue')
  );
}

/**
 * 从 Location / 响应体抽出 OAuth authorization code。
 * @param {string} text
 * @returns {string | null}
 */
export function extractAuthCode(text) {
  const s = String(text || '');
  const m =
    s.match(/[?&]code=([A-Za-z0-9_-]+)/) ||
    s.match(/"code"\s*:\s*"([A-Za-z0-9_-]+)"/) ||
    s.match(/code=([A-Za-z0-9_-]{8,})/);
  return m ? m[1] : null;
}

/**
 * 从 Set-Cookie 列表或 Cookie 头里抽出 WorkosCursorSessionToken。
 * @param {string | string[]} setCookie
 * @returns {string | null}
 */
export function extractSessionTokenFromSetCookie(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [String(setCookie || '')];
  for (const raw of list) {
    const m = String(raw).match(/(?:^|;\s*)WorkosCursorSessionToken=([^;]+)/i);
    if (!m) continue;
    const rawVal = m[1].trim();
    try {
      return decodeURIComponent(rawVal);
    } catch {
      return rawVal;
    }
  }
  return null;
}

/**
 * RSC 飞行数据：`$h20` → 真实 next-action id；兼收表单隐藏域。
 * @param {string} html
 */
export function parseAuthKitPage(html) {
  const text = String(html || '');
  /** @type {Map<string, string>} */
  const refToId = new Map();
  for (const m of text.matchAll(/([a-z0-9]+):\{"id":"([a-f0-9]{40,64})","bound":null\}/g)) {
    refToId.set(m[1], m[2]);
  }
  // 转义形态（嵌在 JSON 字符串里）
  for (const m of text.matchAll(/([a-z0-9]+):\{\\"id\\":\\"([a-f0-9]{40,64})\\",\\"bound\\":null\}/g)) {
    refToId.set(m[1], m[2]);
  }

  /**
   * Flight 引用：`$h20` 指向节点 `20`（h=server handle）；也兼容直接 `$20`。
   * @param {string} ref
   */
  const resolveActionId = (ref) => {
    const key = String(ref || '');
    return (
      refToId.get(key) ||
      (key.startsWith('h') ? refToId.get(key.slice(1)) : null) ||
      null
    );
  };

  /** @type {Record<string, string>} */
  const namedActions = {};
  for (const m of text.matchAll(
    /\\?"(signInAction|sendMagicCodeAction|verifyMagicCodeAction|magicCodeAction|[A-Za-z]+Action)\\?"\s*:\s*\\?"\$([a-z0-9]+)\\?"/g,
  )) {
    const id = resolveActionId(m[2]);
    if (id) namedActions[m[1]] = id;
  }
  // RSC 常见写法：signInAction\":\"$h20\"（无前导引号变体）
  for (const m of text.matchAll(
    /(signInAction|sendMagicCodeAction|verifyMagicCodeAction|magicCodeAction)\\?":\\?"\$([a-z0-9]+)\\?"/g,
  )) {
    const id = resolveActionId(m[2]);
    if (id) namedActions[m[1]] = id;
  }

  const pickInput = (name) => {
    const re = new RegExp(`name="${name}"\\s+value="([^"]*)"`, 'i');
    const m = text.match(re);
    return m ? m[1] : null;
  };

  return {
    authorizationSessionId: pickInput('authorization_session_id'),
    redirectUri: pickInput('redirect_uri') || CALLBACK_URI,
    state: pickInput('state'),
    signInActionId: namedActions.signInAction || null,
    verifyActionId:
      namedActions.verifyMagicCodeAction ||
      namedActions.magicCodeAction ||
      namedActions.sendMagicCodeAction ||
      null,
    namedActions,
    allActionIds: [...new Set(refToId.values())],
    hasMagicCodes: /"magic_codes"\s*:\s*true/.test(text) || /magic_codes\\":true/.test(text),
    isPasswordStep: /name="password"/i.test(text) || /data-hak-field="password"/i.test(text),
    isMagicCodeStep:
      /\/magic-code/i.test(text) ||
      /data-index="0"/i.test(text) ||
      /name="code"/i.test(text) ||
      /name="otp"/i.test(text),
  };
}

/**
 * @param {Record<string, string>} fields
 * @param {string} boundary
 */
export function buildMultipartBody(fields, boundary) {
  let body = '';
  for (const [name, value] of Object.entries(fields)) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }
  body += `--${boundary}--\r\n`;
  return body;
}

/**
 * @param {string} email
 */
function assertEmail(email) {
  const v = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    const err = new Error('邮箱格式无效');
    err.status = 400;
    throw err;
  }
  return v;
}

/**
 * @param {string} code
 */
function assertOtp(code) {
  const v = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(v)) {
    const err = new Error('验证码须为 6 位数字');
    err.status = 400;
    throw err;
  }
  return v;
}

function pruneExpiredLogins(now = Date.now()) {
  for (const [id, row] of pendingLogins) {
    if (row.expiresAt <= now) pendingLogins.delete(id);
  }
}

/**
 * @param {string} loginId
 * @returns {EmailLoginSession}
 */
export function getEmailLoginSession(loginId) {
  pruneExpiredLogins();
  const row = pendingLogins.get(String(loginId || ''));
  if (!row) {
    const err = new Error('验证码会话不存在或已过期，请重新发送');
    err.status = 404;
    throw err;
  }
  return row;
}

/** 测试用：清空内存会话。 */
export function clearEmailLoginSessions() {
  pendingLogins.clear();
}

/**
 * @param {CookieJar} jar
 * @param {string} url
 * @param {RequestInit & { rawBody?: string }} [init]
 */
async function authFetch(jar, url, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has('user-agent')) headers.set('user-agent', UA);
  const cookie = jar.header();
  if (cookie) headers.set('cookie', cookie);

  const res = await fetch(url, {
    ...init,
    headers,
    redirect: 'manual',
    body: init.rawBody ?? init.body,
  });
  jar.absorb(res);
  return res;
}

/**
 * 跟随重定向并收集 Cookie；返回最终非 3xx 响应。
 * @param {CookieJar} jar
 * @param {string} startUrl
 * @param {RequestInit & { rawBody?: string }} [init]
 * @param {number} [maxHops]
 */
async function fetchFollow(jar, startUrl, init = {}, maxHops = 12) {
  let url = startUrl;
  let opts = { ...init };
  for (let i = 0; i < maxHops; i++) {
    const res = await authFetch(jar, url, opts);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { res, url, body: await res.text() };
      url = new URL(loc, url).href;
      opts = {
        method: 'GET',
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml',
        },
      };
      continue;
    }
    const body = await res.text();
    return { res, url, body };
  }
  const err = new Error('登录跳转次数过多');
  err.status = 502;
  throw err;
}

/**
 * @param {string} message
 * @param {number} [status]
 */
function fail(message, status = 502) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

/**
 * @param {string} body
 * @param {Response} res
 */
function assertNotBlocked(body, res) {
  if (res.status === 403 || isCloudflareChallenge(body)) {
    fail(
      'Cursor 登录页被 Cloudflare 拦截，服务端无法代登。请改用「粘贴 Token」或本机导入',
      502,
    );
  }
}

/**
 * 构造带 returnTo 的 AuthKit state（与官方前端一致：双重 encode）。
 */
export function buildAuthKitState(nonce = randomUUID()) {
  const raw = JSON.stringify({
    returnTo: `${CURSOR_ORIGIN}/dashboard`,
    nonce,
  });
  return encodeURIComponent(encodeURIComponent(raw));
}

/**
 * POST Next.js server action（multipart + next-action）。
 * @param {CookieJar} jar
 * @param {string} pageUrl
 * @param {string} actionId
 * @param {Record<string, string>} fields
 */
async function postServerAction(jar, pageUrl, actionId, fields) {
  const boundary = `----WebKitFormBoundary${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const rawBody = buildMultipartBody(fields, boundary);
  const res = await authFetch(jar, pageUrl, {
    method: 'POST',
    rawBody,
    headers: {
      accept: 'text/x-component',
      'content-type': `multipart/form-data; boundary=${boundary}`,
      origin: AUTH_ORIGIN,
      referer: pageUrl,
      'next-action': actionId,
    },
  });
  const body = await res.text();
  assertNotBlocked(body, res);
  return { res, body };
}

/**
 * 从 action 响应头 / 体推断下一步路径。
 * @param {Response} res
 * @param {string} body
 * @param {string} baseUrl
 */
function nextUrlFromAction(res, body, baseUrl) {
  const hdr =
    res.headers.get('x-action-redirect') || res.headers.get('location') || '';
  if (hdr) return new URL(hdr, baseUrl).href;

  const redirectJson = body.match(/"redirect"\s*:\s*"([^"]+)"/);
  if (redirectJson?.[1]) return new URL(redirectJson[1], baseUrl).href;

  const pathHit =
    body.match(/\/magic-code\/[a-zA-Z0-9_-]+/) || body.match(/\/password(?:\?[^"'\s]*)?/);
  if (pathHit?.[0]) return new URL(pathHit[0], baseUrl).href;
  return null;
}

/**
 * 打开登录页并请求向该邮箱发送验证码。
 * @param {{ email: string, displayName?: string }} input
 */
export async function startEmailLogin(input) {
  const email = assertEmail(input.email);
  const displayName = String(input.displayName || '').trim();
  pruneExpiredLogins();

  const jar = new CookieJar();
  const stateParam = buildAuthKitState();
  const startUrl = `${AUTH_ORIGIN}/?state=${stateParam}`;

  const page = await fetchFollow(jar, startUrl, {
    method: 'GET',
    headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': UA },
  });
  assertNotBlocked(page.body, page.res);
  if (page.res.status >= 400) {
    fail(`打开 Cursor 登录页失败（HTTP ${page.res.status}）`);
  }

  const parsed = parseAuthKitPage(page.body);
  if (!parsed.authorizationSessionId || !parsed.state) {
    fail('未能解析 Cursor 登录会话，页面结构可能已变更，请改用粘贴 Token');
  }
  if (!parsed.signInActionId) {
    fail('未能解析登录动作 ID，请改用粘贴 Token');
  }

  const signIn = await postServerAction(jar, page.url, parsed.signInActionId, {
    email,
    redirect_uri: parsed.redirectUri,
    authorization_session_id: parsed.authorizationSessionId,
    state: parsed.state,
    signals: '',
  });

  // 策略拒绝 / 业务错误会出现在 RSC 文本里
  if (/policy_denied|action_denied|account_not_found|invalid_email/i.test(signIn.body)) {
    fail('Cursor 拒绝该邮箱登录请求，请确认账号可用或改用粘贴 Token', 400);
  }

  let stepUrl =
    nextUrlFromAction(signIn.res, signIn.body, page.url) ||
    `${AUTH_ORIGIN}/password?${new URL(page.url).searchParams.toString()}`;

  // 有密码步时改走 magic-code 发送页
  let step = await fetchFollow(jar, stepUrl, {
    method: 'GET',
    headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': UA },
  });
  assertNotBlocked(step.body, step.res);
  let stepParsed = parseAuthKitPage(step.body);

  if (stepParsed.isPasswordStep || (!stepParsed.isMagicCodeStep && parsed.hasMagicCodes)) {
    const magicSendUrl = `${AUTH_ORIGIN}/magic-code/send?${keepAuthQuery(page.url, step.url)}`;
    const sendPage = await fetchFollow(jar, magicSendUrl, {
      method: 'GET',
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': UA },
    });
    assertNotBlocked(sendPage.body, sendPage.res);
    step = sendPage;
    stepParsed = parseAuthKitPage(sendPage.body);

    // 若发送页仍有独立 action，再点一次「发送验证码」
    const sendAction =
      stepParsed.namedActions.sendMagicCodeAction ||
      stepParsed.verifyActionId ||
      stepParsed.allActionIds.find((id) => id !== parsed.signInActionId) ||
      null;
    if (sendAction && !stepParsed.isMagicCodeStep) {
      const sent = await postServerAction(jar, sendPage.url, sendAction, {
        email,
        redirect_uri: parsed.redirectUri,
        authorization_session_id: parsed.authorizationSessionId,
        state: parsed.state,
        signals: '',
      });
      const after =
        nextUrlFromAction(sent.res, sent.body, sendPage.url) ||
        `${AUTH_ORIGIN}/magic-code?${keepAuthQuery(page.url, sendPage.url)}`;
      const codePage = await fetchFollow(jar, after, {
        method: 'GET',
        headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': UA },
      });
      assertNotBlocked(codePage.body, codePage.res);
      step = codePage;
      stepParsed = parseAuthKitPage(codePage.body);
    }
  }

  const verifyActionId =
    stepParsed.verifyActionId ||
    stepParsed.namedActions.verifyMagicCodeAction ||
    stepParsed.allActionIds.find((id) => id !== parsed.signInActionId) ||
    null;

  const loginId = randomUUID();
  const now = Date.now();
  /** @type {EmailLoginSession} */
  const session = {
    loginId,
    email,
    displayName,
    createdAt: now,
    expiresAt: now + EMAIL_LOGIN_TTL_MS,
    jar,
    state: parsed.state,
    authorizationSessionId: parsed.authorizationSessionId,
    redirectUri: parsed.redirectUri,
    pageUrl: step.url,
    verifyActionId,
    stage: 'awaiting_code',
  };
  pendingLogins.set(loginId, session);

  return {
    loginId,
    email,
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

/**
 * 保留 AuthKit 查询串里对会话有用的键。
 * @param {string} a
 * @param {string} b
 */
function keepAuthQuery(a, b) {
  const params = new URLSearchParams();
  for (const src of [a, b]) {
    try {
      const u = new URL(src);
      for (const key of [
        'state',
        'authorization_session_id',
        'redirect_uri',
        'client_id',
        'source',
      ]) {
        if (u.searchParams.get(key) && !params.has(key)) {
          params.set(key, u.searchParams.get(key));
        }
      }
    } catch {
      /* ignore */
    }
  }
  return params.toString();
}

/**
 * 提交邮箱验证码，换出规范化会话 Token。
 * @param {{ loginId: string, code: string }} input
 * @returns {Promise<{ cookieValue: string, email: string, displayName: string }>}
 */
export async function verifyEmailLogin(input) {
  const session = getEmailLoginSession(input.loginId);
  const code = assertOtp(input.code);

  if (!session.verifyActionId) {
    // 验证页可能晚到：再拉一次当前页解析 action
    const again = await fetchFollow(session.jar, session.pageUrl, {
      method: 'GET',
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': UA },
    });
    assertNotBlocked(again.body, again.res);
    const parsed = parseAuthKitPage(again.body);
    session.verifyActionId =
      parsed.verifyActionId ||
      parsed.namedActions.verifyMagicCodeAction ||
      parsed.allActionIds[0] ||
      null;
    session.pageUrl = again.url;
  }
  if (!session.verifyActionId) {
    fail('未能解析验证码提交动作，请改用粘贴 Token');
  }

  const fields = {
    email: session.email,
    code,
    otp: code,
    redirect_uri: session.redirectUri,
    authorization_session_id: session.authorizationSessionId,
    state: session.state,
    signals: '',
  };
  // AuthKit 有时用 code_0..code_5
  for (let i = 0; i < 6; i++) fields[`code_${i}`] = code[i];

  const submitted = await postServerAction(
    session.jar,
    session.pageUrl,
    session.verifyActionId,
    fields,
  );

  if (/invalid_code|invalid_one_time_code|code_expired|expired/i.test(submitted.body)) {
    fail('验证码无效或已过期', 400);
  }

  let authCode =
    extractAuthCode(submitted.res.headers.get('location') || '') ||
    extractAuthCode(submitted.res.headers.get('x-action-redirect') || '') ||
    extractAuthCode(submitted.body);

  let cookieValue =
    extractSessionTokenFromSetCookie(
      typeof submitted.res.headers.getSetCookie === 'function'
        ? submitted.res.headers.getSetCookie()
        : [],
    ) || session.jar.get('WorkosCursorSessionToken');

  if (!cookieValue && authCode) {
    const cb = `${CALLBACK_URI}?code=${encodeURIComponent(authCode)}&state=${encodeURIComponent(session.state)}`;
    const done = await fetchFollow(session.jar, cb, {
      method: 'GET',
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': UA },
    });
    cookieValue =
      extractSessionTokenFromSetCookie(
        typeof done.res.headers.getSetCookie === 'function' ? done.res.headers.getSetCookie() : [],
      ) ||
      session.jar.get('WorkosCursorSessionToken') ||
      extractSessionTokenFromSetCookie(session.jar.header());
  }

  // 若仍无 code，尝试跟随 action 重定向整条链
  if (!cookieValue) {
    const next = nextUrlFromAction(submitted.res, submitted.body, session.pageUrl);
    if (next) {
      const hop = await fetchFollow(session.jar, next, {
        method: 'GET',
        headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': UA },
      });
      authCode = authCode || extractAuthCode(hop.url) || extractAuthCode(hop.body);
      cookieValue =
        session.jar.get('WorkosCursorSessionToken') ||
        extractSessionTokenFromSetCookie(
          typeof hop.res.headers.getSetCookie === 'function' ? hop.res.headers.getSetCookie() : [],
        );
      if (!cookieValue && authCode) {
        const cb = `${CALLBACK_URI}?code=${encodeURIComponent(authCode)}&state=${encodeURIComponent(session.state)}`;
        await fetchFollow(session.jar, cb, {
          method: 'GET',
          headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': UA },
        });
        cookieValue = session.jar.get('WorkosCursorSessionToken');
      }
    }
  }

  if (!cookieValue) {
    fail(
      '验证码已提交，但未拿到会话 Token（可能触发人机验证）。请改用粘贴 Token',
      502,
    );
  }

  const normalized = normalizeManualToken(cookieValue);
  if (!normalized || !sessionFromCookie(normalized)) {
    fail('拿到的会话 Token 无效');
  }

  pendingLogins.delete(session.loginId);
  return {
    cookieValue: normalized,
    email: session.email,
    displayName: session.displayName || session.email,
  };
}
