import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type LocalSession = {
  cookieValue: string;
  userId: string;
  email?: string;
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
 * 用打包进扩展的 Python 脚本只读 Cursor state.vscdb。
 */
async function readAuthViaPython(dbPath: string, readerPy: string): Promise<Map<string, string>> {
  const attempts: Array<[string, string[]]> =
    process.platform === 'win32'
      ? [
          ['py', ['-3', readerPy, dbPath]],
          ['python', [readerPy, dbPath]],
        ]
      : [
          ['python3', [readerPy, dbPath]],
          ['python', [readerPy, dbPath]],
        ];

  let lastError: unknown;
  for (const [bin, args] of attempts) {
    try {
      const { stdout } = await execFileAsync(bin, args, {
        timeout: 20000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      });
      const data = JSON.parse(stdout.trim() || '{}') as {
        error?: string;
        values?: Record<string, string>;
      };
      if (data.error) throw new Error(data.error);
      const out = new Map<string, string>();
      for (const [k, v] of Object.entries(data.values || {})) {
        if (typeof v === 'string') out.set(k, v);
      }
      return out;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * 解析本机 Cursor 登录态；过期 JWT 丢弃。
 */
export async function resolveLocalCursorSession(readerPy: string): Promise<LocalSession | null> {
  for (const dbPath of candidateDbPaths()) {
    const values = await readAuthViaPython(dbPath, readerPy);
    const token = values.get('cursorAuth/accessToken');
    if (!token) continue;
    const payload = decodeJwtPayload(token);
    if (!payload?.sub) continue;
    if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) continue;
    const userId = userIdFromSub(String(payload.sub));
    return {
      cookieValue: buildCookieValue(userId, token),
      userId,
      email: values.get('cursorAuth/cachedEmail'),
      exp: typeof payload.exp === 'number' ? payload.exp : undefined,
    };
  }
  return null;
}
