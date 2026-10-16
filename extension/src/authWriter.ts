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

/** Windows 上 cursor 命令多是 cursor.cmd，直接找可执行文件才能在退出 IDE 后可靠重启。 */
function cursorExePath(): string | null {
  const local = process.env.LOCALAPPDATA || '';
  const programFiles = [process.env.ProgramW6432, process.env.ProgramFiles].filter(Boolean) as string[];
  const candidates = [
    path.join(local, 'Programs', 'cursor', 'Cursor.exe'),
    path.join(local, 'Programs', 'Cursor', 'Cursor.exe'),
    ...programFiles.flatMap((base) => [
      path.join(base, 'cursor', 'Cursor.exe'),
      path.join(base, 'Cursor', 'Cursor.exe'),
    ]),
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

/**
 * 后台拉起重启后退出当前 Cursor。
 * Windows 必须用 cmd start 跳出 Cursor 的 Job：wscript 子进程会在 IDE 退出时被带走，表现为 quit 成功但不唤起。
 * 必须等旧进程全部退出再启动：旧实例还在时新 Cursor 会把自己交给它然后退出。
 */
export async function scheduleCursorRestart(): Promise<void> {
  const delaySec = 2;
  const waitExitSec = 20;
  if (process.platform === 'win32') {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ctu-restart-'));
    const ps1 = path.join(dir, 'restart.ps1');
    const exe = (cursorExePath() || '').replace(/'/g, "''");
    const script = [
      '$ErrorActionPreference = "SilentlyContinue"',
      `$exe = '${exe}'`,
      "if (-not $exe -or -not (Test-Path -LiteralPath $exe)) {",
      "  $candidates = @(",
      "    (Join-Path $env:LOCALAPPDATA 'Programs\\cursor\\Cursor.exe'),",
      "    (Join-Path $env:LOCALAPPDATA 'Programs\\Cursor\\Cursor.exe'),",
      "    (Join-Path $env:ProgramW6432 'cursor\\Cursor.exe'),",
      "    (Join-Path $env:ProgramFiles 'cursor\\Cursor.exe')",
      "  )",
      "  $exe = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1",
      '}',
      `Start-Sleep -Seconds ${delaySec}`,
      // 先等软退出（扩展已发 quit）；用户点确认或卡对话框时再强杀，避免新实例撞上单实例锁
      `$deadline = (Get-Date).AddSeconds(${waitExitSec})`,
      'while ((Get-Process -Name Cursor -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }',
      'if (Get-Process -Name Cursor -ErrorAction SilentlyContinue) {',
      '  Get-Process -Name Cursor -ErrorAction SilentlyContinue | Stop-Process -Force',
      `  $deadline = (Get-Date).AddSeconds(${waitExitSec})`,
      '  while ((Get-Process -Name Cursor -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }',
      '}',
      'Start-Sleep -Seconds 1',
      'if (-not $exe) { exit 1 }',
      // 勿用 cmd start "" "带空格路径"：PowerShell 会吞掉空标题，路径被当成窗口标题，弹出一堆空 cmd
      'for ($i = 0; $i -lt 5; $i++) {',
      '  Start-Process -FilePath $exe',
      '  Start-Sleep -Seconds 1',
      '  if (Get-Process -Name Cursor -ErrorAction SilentlyContinue) { break }',
      '}',
    ].join('\r\n');
    await writeFile(ps1, '\uFEFF' + script, 'utf8');
    // start /min 且下一参数不带引号：跳出 Job，不弹乱码控制台（不要写空标题 ""）
    spawn(
      'cmd.exe',
      [
        '/c',
        'start',
        '/min',
        'powershell.exe',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        ps1,
      ],
      { detached: true, stdio: 'ignore', windowsHide: true },
    ).unref();
    for (const term of vscode.window.terminals) {
      if (/cmd\.exe/i.test(term.name)) term.dispose();
    }
  } else if (process.platform === 'darwin') {
    const waitExit = `for i in $(seq ${waitExitSec * 2}); do pgrep -x Cursor >/dev/null || break; sleep 0.5; done`;
    const bash = `sleep ${delaySec}; osascript -e 'quit app "Cursor"' >/dev/null 2>&1; ${waitExit}; open -a Cursor`;
    spawn('/bin/bash', ['-lc', bash], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const waitExit = `for i in $(seq ${waitExitSec * 2}); do pgrep -x cursor >/dev/null || pgrep -x Cursor >/dev/null || break; sleep 0.5; done`;
    const bash = `sleep ${delaySec}; pkill -x cursor || pkill -x Cursor || true; ${waitExit}; (command -v cursor >/dev/null && cursor) || true`;
    spawn('/bin/bash', ['-lc', bash], { detached: true, stdio: 'ignore' }).unref();
  }

  // 等 cmd start 把 PowerShell 拉起来，再退出 IDE，避免脚本还在 Job 里被带走
  await new Promise((r) => setTimeout(r, 800));
  await vscode.commands.executeCommand('workbench.action.quit');
}
