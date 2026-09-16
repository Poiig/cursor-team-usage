/**
 * 控制台 Cookie 会话：HMAC 签名，避免明文存密码态。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { getSessionSecret } from './config.js';

const COOKIE_NAME = 'ctu_session';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @param {string} username
 */
export function issueSessionToken(username) {
  const exp = Date.now() + TTL_MS;
  const payload = Buffer.from(JSON.stringify({ u: username, exp }), 'utf8').toString('base64url');
  const sig = createHmac('sha256', getSessionSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/**
 * @param {string} token
 * @returns {{ username: string } | null}
 */
export function verifySessionToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expect = createHmac('sha256', getSessionSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data?.u || !data?.exp || Number(data.exp) < Date.now()) return null;
    return { username: String(data.u) };
  } catch {
    return null;
  }
}

/**
 * @param {import('node:http').IncomingMessage} req
 */
export function readSessionFromRequest(req) {
  const raw = req.headers.cookie || '';
  const parts = String(raw).split(';');
  for (const part of parts) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE_NAME) {
      return verifySessionToken(decodeURIComponent(rest.join('=')));
    }
  }
  return null;
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} token
 */
export function setSessionCookie(res, token) {
  const maxAge = Math.floor(TTL_MS / 1000);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
  );
}

/**
 * @param {import('node:http').ServerResponse} res
 */
export function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}

export { COOKIE_NAME };
