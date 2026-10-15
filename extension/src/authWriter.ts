/**
 * 把看板下发的会话写入本机 Cursor state.vscdb，并安排重启以加载新登录态。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { LocalAuthPayload } from './authReader';
import { writeCursorAuthPairs } from './cursorAuthDb';

export type { LocalAuthPayload };

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
 * 用扩展内 Node 写入 auth 键，不再调用本机 Python。
 */
export async function writeLocalCursorAuth(
  auth: LocalAuthPayload,
): Promise<{ dbPath: string; written: string[] }> {
  const dbPath = candidateDbPaths()[0];
  if (!dbPath) throw new Error('未找到本机 Cursor state.vscdb，请确认已安装并启动过 Cursor');

  const allowed: Array<[string, string | null | undefined]> = [
    ['cursorAuth/accessToken', auth.accessToken],
    ['cursorAuth/refreshToken', auth.refreshToken || auth.accessToken],
    ['cursorAuth/cachedEmail', auth.cachedEmail],
    ['cursorAuth/stripeMembershipAuthId', auth.stripeMembershipAuthId],
    ['cursorAuth/cachedSignUpType', auth.cachedSignUpType],
  ];
  const pairs = allowed.filter(
    (pair): pair is [string, string] => typeof pair[1] === 'string' && Boolean(pair[1]),
  );
  if (!pairs.some(([k]) => k.endsWith('accessToken'))) {
    throw new Error('missing accessToken');
  }

  const written = await writeCursorAuthPairs(dbPath, pairs);
  return { dbPath, written };
}

/** Windows 上 cursor 命令多是 cursor.cmd，Start-Process 会留下乱码 cmd 窗口。 */
function cursorExePath(): string | null {
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.join(local, 'Programs', 'cursor', 'Cursor.exe'),
    path.join(local, 'Programs', 'Cursor', 'Cursor.exe'),
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

/**
 * 后台拉起重启后退出当前 Cursor。
 * Windows 用 wscript 隐藏启动，避免 cmd/cursor.cmd 占住终端且中文乱码。
 */
export async function scheduleCursorRestart(): Promise<void> {
  const delaySec = 2;
  if (process.platform === 'win32') {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ctu-restart-'));
    const ps1 = path.join(dir, 'restart.ps1');
    const vbs = path.join(dir, 'restart.vbs');
    const exe = (cursorExePath() || '').replace(/'/g, "''");
    const script = [
      '$ErrorActionPreference = "SilentlyContinue"',
      `Start-Sleep -Seconds ${delaySec}`,
      'Get-Process -Name Cursor -ErrorAction SilentlyContinue | Stop-Process -Force',
      'Start-Sleep -Seconds 1',
      exe
        ? `Start-Process -FilePath '${exe}'`
        : "Start-Process -FilePath (Join-Path $env:LOCALAPPDATA 'Programs\\cursor\\Cursor.exe')",
    ].join('\r\n');
    await writeFile(ps1, '\uFEFF' + script, 'utf8');
    const ps1Quoted = ps1.replace(/"/g, '""');
    const vbsBody = `CreateObject("Wscript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${ps1Quoted}""", 0, False\r\n`;
    await writeFile(vbs, vbsBody, 'utf8');
    // wscript //B 无窗口，且 Run 脱离 Cursor 的 Job，退出 IDE 不会杀掉重启脚本
    spawn('wscript.exe', ['//B', '//Nologo', vbs], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
    for (const term of vscode.window.terminals) {
      if (/cmd\.exe/i.test(term.name)) term.dispose();
    }
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
