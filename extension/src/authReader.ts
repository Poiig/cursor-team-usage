import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CURSOR_AUTH_KEYS, readCursorAuthKeys } from './cursorAuthDb';

export type LocalSession = {
  cookieValue: string;
  userId: string;
  email?: string;
  exp?: number;
};

/** 与 writeLocalCursorAuth 字段对齐，供备份 / 恢复复用。 */
export type LocalAuthPayload = {
  accessToken: string;
  refreshToken?: string;
  cachedEmail?: string | null;
  stripeMembershipAuthId?: string | null;
  cachedSignUpType?: string | null;
  userId?: string;
};

/** 含完整 auth 字段的本机快照；备份时即使 Token 已过期也保留。 */
export type LocalAuthSnapshot = {
  dbPath: string;
  auth: LocalAuthPayload;
  exp?: number;
};

function candidateDbPaths(): string[] {
  const home = os.homedir();
  const list: string[] = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    list.push(path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
  } else if (process.platform === 'darwin') {
    list.push(
      path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    );
  } else {
    list.push(path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
  }
  return list.filter((p) => existsSync(p));
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function userIdFromSub(sub: string): string {
  const idx = sub.indexOf('|');
  return idx >= 0 ? sub.slice(idx + 1) : sub;
}

function buildCookieValue(userId: string, token: string): string {
  return `${userId}%3A%3A${token}`;
}

/**
 * 读本机 cursorAuth 全量（不过滤过期），供切换前备份。
 */
export async function readLocalAuthSnapshot(): Promise<LocalAuthSnapshot | null> {
  for (const dbPath of candidateDbPaths()) {
    const values = await readCursorAuthKeys(dbPath, CURSOR_AUTH_KEYS);
    const token = values.get('cursorAuth/accessToken');
    if (!token) continue;
    const payload = decodeJwtPayload(token);
    const sub = payload?.sub ? String(payload.sub) : '';
    const userId = sub ? userIdFromSub(sub) : undefined;
    const provider = sub.includes('|') ? sub.split('|')[0] : '';
    return {
      dbPath,
      exp: typeof payload?.exp === 'number' ? payload.exp : undefined,
      auth: {
        accessToken: token,
        refreshToken: values.get('cursorAuth/refreshToken') || token,
        cachedEmail: values.get('cursorAuth/cachedEmail') || null,
        stripeMembershipAuthId:
          values.get('cursorAuth/stripeMembershipAuthId') || (sub || null),
        cachedSignUpType: values.get('cursorAuth/cachedSignUpType') || provider || null,
        userId,
      },
    };
  }
  return null;
}

/**
 * 解析本机 Cursor 登录态；过期 JWT 丢弃。
 */
export async function resolveLocalCursorSession(): Promise<LocalSession | null> {
  const snap = await readLocalAuthSnapshot();
  if (!snap?.auth.accessToken || !snap.auth.userId) return null;
  if (typeof snap.exp === 'number' && snap.exp * 1000 < Date.now()) return null;
  return {
    cookieValue: buildCookieValue(snap.auth.userId, snap.auth.accessToken),
    userId: snap.auth.userId,
    email: snap.auth.cachedEmail || undefined,
    exp: snap.exp,
  };
}

/**
 * 向 Cursor 探一下本机会话是否仍被接受。
 * 登出后 JWT 常仍留在 state.vscdb 且未到 exp，直接上报会盖掉看板里朋友正在用的 Token。
 * 网络失败返回 null，由服务端再判，避免因抖动漏报真续期。
 */
export async function probeLocalSessionAuth(
  session: LocalSession,
): Promise<boolean | null> {
  try {
    const res = await fetch('https://cursor.com/api/auth/me', {
      signal: AbortSignal.timeout(15_000),
      headers: {
        Cookie: `WorkosCursorSessionToken=${session.cookieValue}`,
        Origin: 'https://cursor.com',
        Referer: 'https://cursor.com/dashboard',
      },
    });
    if (res.ok) return true;
    if (res.status === 401 || res.status === 403) return false;
    return null;
  } catch {
    return null;
  }
}
