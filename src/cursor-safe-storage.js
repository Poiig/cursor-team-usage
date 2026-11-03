/**
 * 解开 Cursor 3.27+ state.vscdb 里的 cursor-safe-storage:v1 密文。
 * 与 extension/src/cursorSafeStorage.ts 同口径；供服务端本机导入会话使用。
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

/** @type {Buffer | null | undefined} */
let cachedOsCryptKey;

/**
 * @returns {string[]}
 */
function candidateLocalStatePaths() {
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

function winPowerShellExe() {
  return path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

/**
 * @param {Buffer} blob
 * @returns {Buffer}
 */
function windowsDpapiUnprotect(blob) {
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

function loadWindowsOsCryptKey() {
  const localStatePath = candidateLocalStatePaths().find((p) => existsSync(p));
  if (!localStatePath) throw new Error('未找到 Cursor Local State');
  const parsed = JSON.parse(readFileSync(localStatePath, 'utf8'));
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

/**
 * @param {Buffer} payload
 * @param {Buffer} key32
 */
export function decryptWindowsV10(payload, key32) {
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

/**
 * @param {Buffer} payload
 * @param {string} password
 */
export function decryptMacV10(payload, password) {
  if (payload.subarray(0, 3).toString('latin1') !== WIN_VERSION) {
    throw new Error(`非 v10 信封：${payload.subarray(0, 3).toString('latin1')}`);
  }
  const key = crypto.pbkdf2Sync(password, MAC_SALT, MAC_ITERATIONS, MAC_KEY_LEN, 'sha1');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, MAC_IV);
  const body = payload.subarray(3);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/**
 * @param {Buffer} payload
 */
export function decryptLinuxPeanutsV10(payload) {
  if (payload.subarray(0, 3).toString('latin1') !== WIN_VERSION) {
    throw new Error(`非 v10 信封：${payload.subarray(0, 3).toString('latin1')}`);
  }
  const key = crypto.pbkdf2Sync('peanuts', MAC_SALT, 1, MAC_KEY_LEN, 'sha1');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, MAC_IV);
  const body = payload.subarray(3);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

function resolveOsCryptKey() {
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
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
export function unwrapCursorAuthToken(raw) {
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
      const r = spawnSync(
        'security',
        ['find-generic-password', '-w', '-s', 'Cursor Safe Storage', '-a', 'Cursor Key'],
        { encoding: 'utf8', timeout: 10000 },
      );
      if (r.error || r.status !== 0) return null;
      const password = String(r.stdout || '').replace(/\r?\n$/, '');
      if (!password) return null;
      return decryptMacV10(payload, password);
    }
    return decryptLinuxPeanutsV10(payload);
  } catch {
    return null;
  }
}

export function resetCursorSafeStorageCacheForTests() {
  cachedOsCryptKey = undefined;
}
