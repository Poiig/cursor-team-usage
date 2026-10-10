/**
 * 本机 Cursor 登录态备份区：切换前落盘，支持「恢复上次账号」。
 * 只备份 cursorAuth/*，不碰聊天记录与整目录（与 cursor-switch 全量 zip 不同）。
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
  /** 切换目标账号标签（可选，便于辨认备份来源） */
  note?: string | null;
  auth: LocalAuthPayload;
};

const LAST_FILE = 'last.json';

/** 扩展 globalStorage 下的备份目录。 */
export function authBackupDir(storageRoot: string): string {
  return path.join(storageRoot, 'auth-backups');
}

/**
 * 把当前本机登录态写入 last.json（覆盖上一份「上次」）。
 * 无有效 Token 时跳过，不抛错（首次未登录仍允许切到看板账号）。
 */
export async function backupCurrentLocalAuth(
  readerPy: string,
  storageRoot: string,
  note?: string | null,
): Promise<AuthBackupRecord | null> {
  const snap = await readLocalAuthSnapshot(readerPy);
  if (!snap?.auth?.accessToken) return null;

  const record: AuthBackupRecord = {
    savedAt: new Date().toISOString(),
    hostname: os.hostname(),
    email: snap.auth.cachedEmail ?? null,
    userId: snap.auth.userId ?? null,
    note: note ?? null,
    auth: snap.auth,
  };

  const dir = authBackupDir(storageRoot);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, LAST_FILE), JSON.stringify(record, null, 2), 'utf8');
  return record;
}

/** 读取备份区中的「上次」记录。 */
export async function loadLastAuthBackup(storageRoot: string): Promise<AuthBackupRecord | null> {
  try {
    const raw = await readFile(path.join(authBackupDir(storageRoot), LAST_FILE), 'utf8');
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
