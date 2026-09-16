/**
 * 会话 Token 规范化：把用户粘贴的多种形态统一成 cookie 值。
 * 多账号场景下每个账号各自一份 WorkosCursorSessionToken。
 */

/**
 * @typedef {{ cookieValue: string, userId: string }} CursorSession
 */

/**
 * 从 JWT payload 解出 claims；损坏的 token 返回 null 而不是抛错。
 * @param {string} token
 * @returns {Record<string, unknown> | null}
 */
export function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Auth0 sub（如 auth0|user_xxx）收敛成 Cursor userId。
 * @param {string} sub
 */
export function userIdFromSub(sub) {
  const idx = sub.indexOf('|');
  return idx >= 0 ? sub.slice(idx + 1) : sub;
}

/**
 * 组装 cursor.com 期望的 cookie 值：userId%3A%3Ajwt。
 * @param {string} userId
 * @param {string} token
 */
export function buildCookieValue(userId, token) {
  return `${userId}%3A%3A${token}`;
}

/**
 * 接受粘贴的 cookie / name=value / 裸 JWT，输出标准 cookie 值。
 * @param {string} input
 * @returns {string | null}
 */
export function normalizeManualToken(input) {
  let v = input.trim();
  if (!v) return null;
  const eq = v.indexOf('=');
  if (v.toLowerCase().startsWith('workoscursorsessiontoken=')) {
    v = v.slice(eq + 1).trim();
  }
  v = v.replace(/::/g, '%3A%3A');
  if (v.includes('%3A%3A')) return v;
  const payload = decodeJwtPayload(v);
  if (payload?.sub) return buildCookieValue(userIdFromSub(String(payload.sub)), v);
  return null;
}

/**
 * 从 cookie 值解析出 session 结构，供后续 API 调用使用。
 * @param {string} cookieValue
 * @returns {CursorSession | null}
 */
export function sessionFromCookie(cookieValue) {
  const normalized = normalizeManualToken(cookieValue);
  if (!normalized) return null;
  const [userId] = normalized.split('%3A%3A');
  if (!userId) return null;
  return { cookieValue: normalized, userId };
}

/**
 * 对外展示时遮蔽 token，避免完整会话凭证进前端。
 * @param {string} cookieValue
 */
export function maskToken(cookieValue) {
  if (!cookieValue || cookieValue.length < 12) return '••••';
  return `••••${cookieValue.slice(-8)}`;
}

/**
 * 从 cookie 值拆出 JWT，供 api2.cursor.sh Bearer（Connect RPC）调用。
 * @param {string} cookieValue
 * @returns {string | null}
 */
export function jwtFromCookie(cookieValue) {
  const session = sessionFromCookie(cookieValue);
  if (!session) return null;
  const parts = session.cookieValue.split('%3A%3A');
  return parts[1] || null;
}

/**
 * 解析会话 JWT 的 exp，返回 ISO；无 exp 或已损坏则 null。
 * @param {string} cookieValue
 * @returns {string | null}
 */
export function tokenExpiresAtIso(cookieValue) {
  const jwt = jwtFromCookie(cookieValue);
  if (!jwt) return null;
  const payload = decodeJwtPayload(jwt);
  const exp = Number(payload?.exp);
  if (!Number.isFinite(exp) || exp <= 0) return null;
  return new Date(exp * 1000).toISOString();
}
