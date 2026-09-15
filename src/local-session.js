/**
 * 从本机 Cursor 的 state.vscdb 读取已登录会话。
 * 读 Cursor 本地 state.vscdb 的 ItemTable（cursorAuth/*），免去手动粘贴 Cookie。
 * 大库（数 GB）不能整文件进内存，因此优先 sqlite3 CLI，其次用系统 Python 的 sqlite3。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCookieValue,
  decodeJwtPayload,
  userIdFromSub,
} from './auth.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const READER_PY = path.join(__dirname, '..', 'scripts', 'read_cursor_auth.py');

/**
 * 各平台 Cursor 全局状态库候选路径。
 * @returns {string[]}
 */
export function candidateStateDbPaths() {
  const home = os.homedir();
  const candidates = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    candidates.push(path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
  } else if (process.platform === 'darwin') {
    candidates.push(
      path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    );
  } else {
    candidates.push(path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
  }
  return candidates.filter((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

/**
 * @param {string} dbPath
 * @param {string[]} keys
 * @returns {Promise<Map<string, string>>}
 */
async function readKeysViaSqliteCli(dbPath, keys) {
  const inList = keys.map((k) => `'${k.replaceAll("'", "''")}'`).join(',');
  const query = `SELECT key, value FROM ItemTable WHERE key IN (${inList});`;
  const { stdout } = await execFileAsync(
    'sqlite3',
    ['-readonly', '-bail', '-cmd', '.headers off', '-cmd', '.mode list', '-cmd', '.separator "\t" "\n"', dbPath, query],
    { timeout: 15000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
  );
  const out = new Map();
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    out.set(line.slice(0, tab), line.slice(tab + 1));
  }
  return out;
}

/**
 * Windows 上常无 sqlite3 CLI，用同目录旁路脚本经 Python 只读查询。
 * @param {string} dbPath
 * @returns {Promise<Map<string, string>>}
 */
async function readKeysViaPython(dbPath) {
  const attempts =
    process.platform === 'win32'
      ? [
          ['py', ['-3', READER_PY, dbPath]],
          ['python', [READER_PY, dbPath]],
        ]
      : [
          ['python3', [READER_PY, dbPath]],
          ['python', [READER_PY, dbPath]],
        ];

  let lastError;
  for (const [bin, args] of attempts) {
    try {
      const { stdout } = await execFileAsync(bin, args, {
        timeout: 20000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      });
      const data = JSON.parse(stdout.trim() || '{}');
      if (data.error) throw new Error(data.error);
      const out = new Map();
      for (const [k, v] of Object.entries(data.values || {})) {
        if (typeof v === 'string') out.set(k, v);
      }
      return out;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('Python 读取失败');
}

/**
 * @param {string} dbPath
 * @param {string[]} keys
 */
async function readItemTableValues(dbPath, keys) {
  try {
    return await readKeysViaSqliteCli(dbPath, keys);
  } catch {
    // CLI 不可用时走 Python；两者都失败再抛给调用方。
  }
  try {
    return await readKeysViaPython(dbPath);
  } catch (e) {
    const msg = e?.message || String(e);
    throw new Error(
      `无法读取 Cursor 本地状态库。请安装 sqlite3 CLI，或确保本机有 Python 3。详情：${msg}`,
    );
  }
}

/**
 * 解析本机 Cursor 登录态；过期 token 直接丢弃。
 * @returns {Promise<{ cookieValue: string, userId: string, email?: string, exp?: number, source: 'ide', dbPath: string } | null>}
 */
export async function resolveLocalCursorSession() {
  const keys = ['cursorAuth/accessToken', 'cursorAuth/cachedEmail'];
  for (const dbPath of candidateStateDbPaths()) {
    const values = await readItemTableValues(dbPath, keys);
    const token = values.get('cursorAuth/accessToken');
    if (!token) continue;
    const payload = decodeJwtPayload(token);
    if (!payload?.sub) continue;
    if (payload.exp && payload.exp * 1000 < Date.now()) continue;
    const userId = userIdFromSub(String(payload.sub));
    return {
      cookieValue: buildCookieValue(userId, token),
      userId,
      email: values.get('cursorAuth/cachedEmail'),
      exp: typeof payload.exp === 'number' ? payload.exp : undefined,
      source: 'ide',
      dbPath,
    };
  }
  return null;
}

/**
 * 对外探测：不返回完整 token，只说明能否导入。
 */
export async function probeLocalCursorSession() {
  try {
    const session = await resolveLocalCursorSession();
    if (!session) {
      return { available: false, reason: '未找到有效的 Cursor 登录态，请先在本机登录 Cursor' };
    }
    return {
      available: true,
      userId: session.userId,
      email: session.email,
      expiresAt: session.exp ? new Date(session.exp * 1000).toISOString() : null,
    };
  } catch (e) {
    return { available: false, reason: e?.message || String(e) };
  }
}
