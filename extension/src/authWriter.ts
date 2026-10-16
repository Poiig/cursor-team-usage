/**
 * 把看板下发的会话写入本机 Cursor state.vscdb，并安排重启以加载新登录态。
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

/** 当前正在跑的 Cursor.exe，比猜安装目录更准。 */
function cursorExePath(): string | null {
  const fromAppRoot = path.join(vscode.env.appRoot, '..', '..', 'Cursor.exe');
  if (existsSync(fromAppRoot)) return path.normalize(fromAppRoot);
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

/** 固定 System32，避免 32 位进程 PATH 指到 WOW64 的 powershell。 */
function winPowerShellExe(): string {
  return path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

/** PowerShell 单引号字符串把 ' 写成 ''。 */
function psSingleQuote(s: string): string {
  return s.replace(/'/g, "''");
}

/** 扩展与重启脚本共用这一份日志，避免各写各的对不上。 */
function restartLogPath(): string {
  return path.join(os.tmpdir(), 'ctu-restart.log');
}

/** 扩展进程侧也写日志，用来区分「没安排上」和「安排了但子进程没跑」。 */
async function appendRestartLog(line: string): Promise<void> {
  await writeFile(restartLogPath(), `${new Date().toISOString()} ${line}\n`, {
    encoding: 'utf8',
    flag: 'a',
  });
}

/** 创建成功不代表脚本真在跑（Windows 的 -File、Mac 的 launchd 都有空成功）。 */
async function waitRestartChildLog(runId: string, ms: number): Promise<boolean> {
  const needle = `child-run=${runId}`;
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const text = await readFile(restartLogPath(), 'utf8');
      if (text.includes(needle)) return true;
    } catch {
      /* 日志尚未创建 */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/**
 * 经 WMI 创建进程（父进程是 WmiPrvSE，不在 Cursor Job 里）。
 * Node spawn 的 creationFlags 根本不会传给 CreateProcess；子进程会被 Quit 一起杀掉。
 * powershell -File 在无控制台时会静默退出，必须用 -Command "& 'script.ps1'"。
 */
function winSpawnOutsideJob(commandLine: string): void {
  const psExe = winPowerShellExe();
  const wmi = [
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${psSingleQuote(commandLine)}' }`,
    'if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create $($r.ReturnValue)" }',
  ].join('; ');
  execFileSync(psExe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wmi], {
    timeout: 15000,
    windowsHide: true,
  });
}

/** plist 路径含 & 时不转义会直接坏掉。 */
function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** bash 单引号字符串：把 ' 写成 '\''。 */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Contents/Resources/app 再上三级才是 Cursor.app。 */
function macCursorAppPath(): string | null {
  const fromAppRoot = path.normalize(path.join(vscode.env.appRoot, '..', '..', '..'));
  if (fromAppRoot.endsWith('.app') && existsSync(fromAppRoot)) return fromAppRoot;
  const home = os.homedir();
  return (
    ['/Applications/Cursor.app', path.join(home, 'Applications', 'Cursor.app')].find((p) =>
      existsSync(p),
    ) || null
  );
}

/**
 * launchd 拉起的进程不属于 Cursor，Quit 不会带走。
 * Node detached spawn 在部分 Electron/macOS 上仍会随父进程退出。
 */
function macSpawnViaLaunchd(plistPath: string, uid: number): void {
  const domain = `gui/${uid}`;
  try {
    execFileSync('launchctl', ['bootout', domain, plistPath], { timeout: 5000, stdio: 'ignore' });
  } catch {
    /* 首次没有旧任务 */
  }
  execFileSync('launchctl', ['bootstrap', domain, plistPath], { timeout: 10000 });
}

/** launchd 不可用时再赌 nohup+setsid 能活过 Quit。 */
function macSpawnDetached(scriptPath: string): void {
  spawn('/usr/bin/nohup', ['/bin/bash', scriptPath], { detached: true, stdio: 'ignore' }).unref();
}

/**
 * 与 Windows 同一套约定：进程外脚本等 Cursor 退干净再 open；用户点取消则放弃。
 */
async function scheduleMacRestart(delaySec: number, waitExitSec: number): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ctu-restart-'));
  const scriptPath = path.join(dir, 'restart.sh');
  const plistPath = path.join(dir, 'restart.plist');
  const log = restartLogPath();
  const app = macCursorAppPath() || '';
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const label = `com.poiig.ctu.restart.${runId}`;
  const uid = os.userInfo().uid;
  const script = [
    '#!/bin/bash',
    `LOG=${shSingleQuote(log)}`,
    'W() { printf "%s %s\\n" "$(date \'+%Y-%m-%d %H:%M:%S\')" "$*" >> "$LOG"; }',
    `W "restart script pid=$$ child-run=${runId}"`,
    `sleep ${delaySec}`,
    'n=0',
    'while /usr/bin/pgrep -x Cursor >/dev/null 2>&1; do',
    '  n=$((n+1))',
    `  if [ "$n" -ge ${waitExitSec} ]; then`,
    '    W "cursor still running, skip launch"',
    '    exit 0',
    '  fi',
    '  sleep 1',
    'done',
    'sleep 1',
    `APP=${shSingleQuote(app)}`,
    'if [ -n "$APP" ] && [ -d "$APP" ]; then',
    '  W "launch $APP"',
    '  /usr/bin/open "$APP"',
    'else',
    '  W "launch open -a Cursor"',
    '  /usr/bin/open -a Cursor',
    'fi',
    `/bin/launchctl bootout "gui/$(/usr/bin/id -u)/${label}" >/dev/null 2>&1 || true`,
  ].join('\n');
  await writeFile(scriptPath, script, 'utf8');
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '<key>Label</key><string>' + xmlEscape(label) + '</string>',
    '<key>ProgramArguments</key><array>',
    '<string>/bin/bash</string>',
    '<string>' + xmlEscape(scriptPath) + '</string>',
    '</array>',
    '<key>RunAtLoad</key><true/>',
    '<key>LaunchOnlyOnce</key><true/>',
    '<key>AbandonProcessGroup</key><true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
  await writeFile(plistPath, plist, 'utf8');
  await appendRestartLog(`schedule run=${runId} sh=${scriptPath} app=${app || '(empty)'}`);
  let launched = false;
  try {
    macSpawnViaLaunchd(plistPath, uid);
    await appendRestartLog(`launchd ok run=${runId}`);
    launched = await waitRestartChildLog(runId, 2500);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await appendRestartLog(`launchd fail ${msg}; try nohup`);
  }
  if (!launched) {
    macSpawnDetached(scriptPath);
    await appendRestartLog(`nohup spawned run=${runId}`);
    launched = await waitRestartChildLog(runId, 2500);
  }
  if (!launched) {
    throw new Error('重启脚本未能启动，请查看 $TMPDIR/ctu-restart.log');
  }
}

/** WMI 不可用时由任务计划程序拉起，同样不在 Cursor Job 里。 */
function winSpawnViaSchtasks(cmdPath: string): void {
  const tn = `CTU-Restart-${Date.now()}`;
  execFileSync(
    'schtasks.exe',
    ['/Create', '/F', '/TN', tn, '/SC', 'ONCE', '/ST', '23:59', '/IT', '/TR', cmdPath],
    { timeout: 15000, windowsHide: true },
  );
  try {
    execFileSync('schtasks.exe', ['/Run', '/TN', tn], { timeout: 15000, windowsHide: true });
  } finally {
    try {
      execFileSync('schtasks.exe', ['/Delete', '/F', '/TN', tn], { timeout: 10000, windowsHide: true });
    } catch {
      /* 下次同名 /F 覆盖 */
    }
  }
}

/**
 * 后台拉起重启后退出当前 Cursor。
 * Windows 走 WMI，Mac 走 launchd；都要等旧进程退干净再启动，否则新实例会把自己交给旧进程然后退出。
 */
export async function scheduleCursorRestart(): Promise<void> {
  const delaySec = 2;
  const waitExitSec = 60;
  if (process.platform === 'win32') {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ctu-restart-'));
    const cmdPath = path.join(dir, 'restart.cmd');
    const log = restartLogPath();
    const exe = cursorExePath() || '';
    const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // powershell -File 无控制台会静默退出；cmd + WMI 才能活过 Quit
    const cmd = [
      '@echo off',
      'setlocal',
      `set "LOG=${log}"`,
      `echo restart script child-run=${runId}>>"%LOG%"`,
      `timeout /t ${delaySec} /nobreak >nul`,
      'set WAITED=0',
      ':wait',
      'tasklist /FI "IMAGENAME eq Cursor.exe" | find /I "Cursor.exe" >nul',
      'if errorlevel 1 goto launch',
      'timeout /t 1 /nobreak >nul',
      'set /a WAITED+=1',
      `if %WAITED% LSS ${waitExitSec} goto wait`,
      'echo cursor still running, skip launch>>"%LOG%"',
      'goto :eof',
      ':launch',
      'timeout /t 1 /nobreak >nul',
      ...(exe
        ? [
            `if not exist "${exe}" (`,
            'echo no exe>>"%LOG%"',
            'goto :eof',
            ')',
            'echo launch>>"%LOG%"',
            `start "" "${exe}"`,
          ]
        : ['echo no exe>>"%LOG%"']),
    ].join('\r\n');
    await writeFile(cmdPath, cmd, 'ascii');
    // 隐藏窗口；CommandLine 里的单引号由 winSpawnOutsideJob 再转义给 CIM
    const commandLine =
      `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command ` +
      `"Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','${psSingleQuote(cmdPath)}' -WindowStyle Hidden"`;
    await appendRestartLog(`schedule run=${runId} cmd=${cmdPath} exe=${exe || '(empty)'}`);
    let launched = false;
    try {
      winSpawnOutsideJob(commandLine);
      await appendRestartLog(`wmi create ok run=${runId}`);
      launched = await waitRestartChildLog(runId, 2500);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await appendRestartLog(`wmi fail ${msg}; try schtasks`);
    }
    if (!launched) {
      try {
        winSpawnViaSchtasks(cmdPath);
        await appendRestartLog(`schtasks run ok run=${runId}`);
        launched = await waitRestartChildLog(runId, 2500);
      } catch (e2) {
        const msg2 = e2 instanceof Error ? e2.message : String(e2);
        await appendRestartLog(`schtasks fail ${msg2}`);
        throw new Error(`无法安排重启：${msg2}`);
      }
    }
    if (!launched) {
      throw new Error('重启脚本未能启动，请查看 %TEMP%\\ctu-restart.log');
    }
  } else if (process.platform === 'darwin') {
    await scheduleMacRestart(delaySec, waitExitSec);
  } else {
    const waitExit = `for i in $(seq ${waitExitSec * 2}); do pgrep -x cursor >/dev/null || pgrep -x Cursor >/dev/null || break; sleep 0.5; done`;
    const bash = `sleep ${delaySec}; pkill -x cursor || pkill -x Cursor || true; ${waitExit}; (command -v cursor >/dev/null && cursor) || true`;
    spawn('/bin/bash', ['-lc', bash], { detached: true, stdio: 'ignore' }).unref();
  }

  // 脚本已在 Job 外跑着；Quit 会出系统确认框，点 Cancel 则脚本超时后放弃拉起
  await vscode.commands.executeCommand('workbench.action.quit');
}
