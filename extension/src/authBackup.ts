/**
 * 本机 Cursor 登录态备份区：记下「本机账号」，之后只还原它，不被多次切换覆盖。
 * 优先来源：本地 home.json → 看板号池（成员首次上报 hostname）→ 当前本机登录态。
 * 只备份 cursorAuth/*，不碰聊天记录与整目录。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readLocalAuthSnapshot, type LocalAuthPayload } from './authReader';

export type AuthBackupRecord = {
  savedAt: string;
  hostname: string;
  email?: string | null;
  userId?: string | null;
  /** 备份来源说明，便于辨认 */
  note?: string | null;
  auth: LocalAuthPayload;
};

/** 本机账号快照：只写一次，恢复也不覆盖。 */
const HOME_FILE = 'home.json';

/** 扩展 globalStorage 下的备份目录。 */
export function authBackupDir(storageRoot: string): string {
  return path.join(storageRoot, 'auth-backups');
}

function homePath(storageRoot: string): string {
  return path.join(authBackupDir(storageRoot), HOME_FILE);
}

/**
 * 把已解析的本机账号写入 home.json（已存在则不改，返回现有）。
 */
export async function writeHomeAuthBackup(
  storageRoot: string,
  record: AuthBackupRecord,
): Promise<AuthBackupRecord> {
  const existing = await loadHomeAuthBackup(storageRoot);
  if (existing) return existing;

  const dir = authBackupDir(storageRoot);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(homePath(storageRoot), JSON.stringify(record, null, 2), {
      encoding: 'utf8',
      flag: 'wx',
    });
    return record;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === 'EEXIST') {
      const again = await loadHomeAuthBackup(storageRoot);
      if (again) return again;
    }
    throw e;
  }
}

/**
 * 若尚无本机账号备份：可选用看板解析结果，否则抓当前登录态。
 * @param boardHome 看板按 hostname 找回的本机号；没有则传 null
 */
export async function ensureHomeAuthBackup(
  storageRoot: string,
  note?: string | null,
  boardHome?: AuthBackupRecord | null,
): Promise<AuthBackupRecord | null> {
  const existing = await loadHomeAuthBackup(storageRoot);
  if (existing) return existing;

  if (boardHome?.auth?.accessToken) {
    return writeHomeAuthBackup(storageRoot, boardHome);
  }

  const snap = await readLocalAuthSnapshot();
  if (!snap?.auth?.accessToken) return null;

  return writeHomeAuthBackup(storageRoot, {
    savedAt: new Date().toISOString(),
    hostname: os.hostname(),
    email: snap.auth.cachedEmail ?? null,
    userId: snap.auth.userId ?? null,
    note: note ?? null,
    auth: snap.auth,
  });
}

/** 读取本机账号备份。 */
export async function loadHomeAuthBackup(storageRoot: string): Promise<AuthBackupRecord | null> {
  try {
    const raw = await readFile(homePath(storageRoot), 'utf8');
    const parsed = JSON.parse(raw) as AuthBackupRecord;
    if (!parsed?.auth?.accessToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 供状态栏 / 网页展示的摘要。 */
export function summarizeBackup(record: AuthBackupRecord | null): {
  exists: boolean;
  email?: string | null;
  userId?: string | null;
  savedAt?: string | null;
  hostname?: string | null;
} {
  if (!record) return { exists: false };
  return {
    exists: true,
    email: record.email ?? null,
    userId: record.userId ?? null,
    savedAt: record.savedAt ?? null,
    hostname: record.hostname ?? null,
  };
}
