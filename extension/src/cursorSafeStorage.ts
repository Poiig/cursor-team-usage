/**
 * 解开 Cursor 3.27+ 写入 state.vscdb 的 cursor-safe-storage:v1 密文。
 * 明文 JWT 原样返回。Windows 走 Local State os_crypt + DPAPI + AES-256-GCM；
 * macOS 走 Keychain「Cursor Safe Storage」+ AES-128-CBC；Linux 先试 peanuts。
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CURSOR_SAFE_STORAGE_PREFIX = 'cursor-safe-storage:v1:';

const WIN_VERSION = 'v10';
const WIN_NONCE_LEN = 12;
const WIN_TAG_LEN = 16;
const WIN_KEY_LEN = 32;
const DPAPI_PREFIX = 'DPAPI';

const MAC_SALT = 'saltysalt';
const MAC_ITERATIONS = 1003;
const MAC_KEY_LEN = 16;
const MAC_IV = Buffer.alloc(16, 0x20);

/** 进程内缓存 OSCrypt 主密钥，避免每次读 Token 都走 DPAPI / Keychain。 */
let cachedOsCryptKey: Buffer | null | undefined;

function candidateLocalStatePaths(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return [path.join(appData, 'Cursor', 'Local State')];
  }
  if (process.platform === 'darwin') {
    return [path.join(home, 'Library', 'Application Support', 'Cursor', 'Local State')];
  }
  return [path.join(home, '.config', 'Cursor', 'Local State')];
}

function winPowerShellExe(): string {
  return path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

/** Windows DPAPI CurrentUser 解包。 */
function windowsDpapiUnprotect(blob: Buffer): Buffer {
  const b64 = blob.toString('base64');
  const ps = [
    'Add-Type -AssemblyName System.Security',
    `$bytes = [Convert]::FromBase64String('${b64}')`,
    '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($plain)',
  ].join('; ');
  const r = spawnSync(
    winPowerShellExe(),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
  );
  if (r.error || r.status !== 0) {
    throw new Error(`DPAPI 解包失败：${r.stderr || r.stdout || r.error?.message || 'unknown'}`);
  }
  return Buffer.from(String(r.stdout || '').trim(), 'base64');
}

function loadWindowsOsCryptKey(): Buffer {
  const localStatePath = candidateLocalStatePaths().find((p) => existsSync(p));
  if (!localStatePath) throw new Error('未找到 Cursor Local State');
  const parsed = JSON.parse(readFileSync(localStatePath, 'utf8')) as {
    os_crypt?: { encrypted_key?: string };
  };
  const encKeyB64 = parsed?.os_crypt?.encrypted_key;
  if (!encKeyB64) throw new Error('Local State 无 os_crypt.encrypted_key');
  const encKey = Buffer.from(encKeyB64, 'base64');
  if (encKey.subarray(0, DPAPI_PREFIX.length).toString('latin1') !== DPAPI_PREFIX) {
    throw new Error(`os_crypt 前缀异常：${encKey.subarray(0, 5).toString('latin1')}`);
  }
  const key = windowsDpapiUnprotect(encKey.subarray(DPAPI_PREFIX.length));
  if (key.length !== WIN_KEY_LEN) {
    throw new Error(`os_crypt 密钥长度 ${key.length}，期望 ${WIN_KEY_LEN}`);
  }
  return key;
}

/** Windows：v10 + nonce(12) + ciphertext + tag(16) → AES-256-GCM。 */
export function decryptWindowsV10(payload: Buffer, key32: Buffer): string {
  if (payload.subarray(0, 3).toString('latin1') !== WIN_VERSION) {
    throw new Error(`非 v10 信封：${payload.subarray(0, 3).toString('latin1')}`);
  }
  if (payload.length < 3 + WIN_NONCE_LEN + WIN_TAG_LEN) {
    throw new Error('v10 密文过短');
  }
  const nonce = payload.subarray(3, 3 + WIN_NONCE_LEN);
  const tag = payload.subarray(payload.length - WIN_TAG_LEN);
  const ciphertext = payload.subarray(3 + WIN_NONCE_LEN, payload.length - WIN_TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key32, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function loadMacOsCryptPassword(): string {
  const r = spawnSync(
    'security',
    ['find-generic-password', '-w', '-s', 'Cursor Safe Storage', '-a', 'Cursor Key'],
    { encoding: 'utf8', timeout: 10000 },
  );
  if (r.error || r.status !== 0) {
    throw new Error(`读取 Keychain 失败：${r.stderr || r.stdout || r.error?.message || 'unknown'}`);
  }
  const pw = String(r.stdout || '').replace(/\r?\n$/, '');
  if (!pw) throw new Error('Keychain 口令为空');
  return pw;
}

/** macOS：v10 + AES-128-CBC，口令经 PBKDF2-HMAC-SHA1。 */
export function decryptMacV10(payload: Buffer, password: string): string {
  if (payload.subarray(0, 3).toString('latin1') !== WIN_VERSION) {
    throw new Error(`非 v10 信封：${payload.subarray(0, 3).toString('latin1')}`);
  }
  const key = crypto.pbkdf2Sync(password, MAC_SALT, MAC_ITERATIONS, MAC_KEY_LEN, 'sha1');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, MAC_IV);
  const body = payload.subarray(3);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/** Linux basic_text：peanuts + 1 次 PBKDF2 + AES-128-CBC。 */
export function decryptLinuxPeanutsV10(payload: Buffer): string {
  if (payload.subarray(0, 3).toString('latin1') !== WIN_VERSION) {
    throw new Error(`非 v10 信封：${payload.subarray(0, 3).toString('latin1')}`);
  }
  const key = crypto.pbkdf2Sync('peanuts', MAC_SALT, 1, MAC_KEY_LEN, 'sha1');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, MAC_IV);
  const body = payload.subarray(3);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

function resolveOsCryptKey(): Buffer | null {
  if (cachedOsCryptKey !== undefined) return cachedOsCryptKey;
  try {
    if (process.platform === 'win32') {
      cachedOsCryptKey = loadWindowsOsCryptKey();
      return cachedOsCryptKey;
    }
  } catch {
    cachedOsCryptKey = null;
    return null;
  }
  cachedOsCryptKey = null;
  return null;
}

/**
 * 把 state.vscdb 里的 accessToken / refreshToken 还原成可用 JWT。
 * 已是明文则原样返回；密文解不开时返回 null。
 */
export function unwrapCursorAuthToken(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith(CURSOR_SAFE_STORAGE_PREFIX)) return raw;

  const payload = Buffer.from(raw.slice(CURSOR_SAFE_STORAGE_PREFIX.length), 'base64');
  try {
    if (process.platform === 'win32') {
      const key = resolveOsCryptKey();
      if (!key) return null;
      return decryptWindowsV10(payload, key);
    }
    if (process.platform === 'darwin') {
      const password = loadMacOsCryptPassword();
      return decryptMacV10(payload, password);
    }
    return decryptLinuxPeanutsV10(payload);
  } catch {
    return null;
  }
}

/** 测试或密钥轮换后清缓存。 */
export function resetCursorSafeStorageCacheForTests(): void {
  cachedOsCryptKey = undefined;
}
