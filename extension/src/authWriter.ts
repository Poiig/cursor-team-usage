/**
 * 把看板下发的会话写入本机 Cursor state.vscdb，并安排重启以加载新登录态。
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

export type LocalAuthPayload = {
  accessToken: string;
  refreshToken?: string;
  cachedEmail?: string | null;
  stripeMembershipAuthId?: string | null;
  cachedSignUpType?: string | null;
  userId?: string;
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

/**
 * 调用打包进扩展的 Python 脚本写入 auth 键。
 */
export async function writeLocalCursorAuth(
  writerPy: string,
  auth: LocalAuthPayload,
): Promise<{ dbPath: string; written: string[] }> {
  const dbPath = candidateDbPaths()[0];
  if (!dbPath) throw new Error('未找到本机 Cursor state.vscdb，请确认已安装并启动过 Cursor');

  const dir = await mkdtemp(path.join(os.tmpdir(), 'ctu-auth-'));
  const payloadPath = path.join(dir, 'auth.json');
  await writeFile(payloadPath, JSON.stringify(auth), 'utf8');

  const attempts: Array<[string, string[]]> =
    process.platform === 'win32'
      ? [
          ['py', ['-3', writerPy, dbPath, payloadPath]],
          ['python', [writerPy, dbPath, payloadPath]],
        ]
      : [
          ['python3', [writerPy, dbPath, payloadPath]],
          ['python', [writerPy, dbPath, payloadPath]],
        ];

  let lastError: unknown;
  for (const [bin, args] of attempts) {
    try {
      const { stdout } = await execFileAsync(bin, args, {
        timeout: 20000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      });
      const data = JSON.parse(stdout.trim() || '{}') as {
        error?: string;
        written?: string[];
      };
      if (data.error) throw new Error(data.error);
      return { dbPath, written: data.written || [] };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * 后台拉起重启脚本后退出当前 Cursor，使新登录态生效。
 * Windows 用 start 脱离 Job；macOS / Linux 用 sleep + 重新 open。
 */
export async function scheduleCursorRestart(): Promise<void> {
  const delaySec = 2;
  if (process.platform === 'win32') {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ctu-restart-'));
    const ps1 = path.join(dir, 'restart.ps1');
    const localApp = process.env.LOCALAPPDATA || '';
    const fallbackExe = path.join(localApp, 'Programs', 'cursor', 'Cursor.exe').replace(/'/g, "''");
    const script = [
      '$ErrorActionPreference = "SilentlyContinue"',
      `Start-Sleep -Seconds ${delaySec}`,
      'Get-Process -Name Cursor -ErrorAction SilentlyContinue | Stop-Process -Force',
      'Start-Sleep -Seconds 1',
      '$cmd = Get-Command cursor -ErrorAction SilentlyContinue',
      'if ($cmd) { Start-Process $cmd.Source }',
      `elseif (Test-Path '${fallbackExe}') { Start-Process '${fallbackExe}' }`,
    ].join('\r\n');
    await writeFile(ps1, script, 'utf8');
    // cmd start 脱离当前 Job，避免父进程退出带走重启脚本
    spawn(
      'cmd.exe',
      ['/c', 'start', '', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1],
      { detached: true, stdio: 'ignore', windowsHide: true },
    ).unref();
  } else if (process.platform === 'darwin') {
    const bash = `sleep ${delaySec}; osascript -e 'quit app "Cursor"' >/dev/null 2>&1; sleep 1; open -a Cursor`;
    spawn('/bin/bash', ['-lc', bash], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const bash = `sleep ${delaySec}; pkill -x cursor || pkill -x Cursor || true; sleep 1; (command -v cursor >/dev/null && cursor) || true`;
    spawn('/bin/bash', ['-lc', bash], { detached: true, stdio: 'ignore' }).unref();
  }

  // 给 detached 进程一点时间落地，再退出 IDE
  await new Promise((r) => setTimeout(r, 400));
  await vscode.commands.executeCommand('workbench.action.quit');
}
