import * as vscode from 'vscode';
import type { Server } from 'node:http';
import path from 'node:path';
import {
  backupCurrentLocalAuth,
  loadLastAuthBackup,
  summarizeBackup,
} from './authBackup';
import { resolveLocalCursorSession } from './authReader';
import { scheduleCursorRestart, writeLocalCursorAuth } from './authWriter';
import {
  downloadAndInstallVsix,
  fetchRemoteBuildMeta,
  installFromBoardWithAccessKey,
  maybePromptUpdate,
  readLocalBuildInfo,
} from './extensionInstall';
import { readLocalBridgePort, startLocalBridge } from './localBridge';
import {
  claimSwitchTicket,
  readReporterConfig,
  reportSession,
  reportSwitchResult,
  sendHeartbeat,
} from './reporter';

/** 与服务端 PLUGIN_ONLINE_MS=5min 对齐：约 2.5 个周期内无 ping 判离线。 */
const HEARTBEAT_MS = 2 * 60_000;

let statusBar: vscode.StatusBarItem | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let bridgeServer: Server | undefined;
let lastMessage = '尚未上报';
/** 避免同一 URI / 票据被并发处理两次。 */
let switching = false;

function readerScriptPath(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, 'dist', 'read_cursor_auth.py');
}

function writerScriptPath(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, 'dist', 'write_cursor_auth.py');
}

function storageRoot(context: vscode.ExtensionContext): string {
  return context.globalStorageUri.fsPath;
}

function updateStatus(text: string) {
  lastMessage = text;
  if (statusBar) {
    statusBar.text = `$(cloud-upload) CTU`;
    statusBar.tooltip = text;
  }
}

async function doReport(context: vscode.ExtensionContext, silent: boolean) {
  const config = readReporterConfig();
  try {
    const session = await resolveLocalCursorSession(readerScriptPath(context));
    if (!session) {
      throw new Error('未找到有效的 Cursor 登录态，请先在本机登录 Cursor');
    }
    const result = await reportSession(config, session);
    const exp = session.exp
      ? new Date(session.exp * 1000).toLocaleString('zh-CN')
      : '未知';
    const msg = `${result.created ? '已注册' : '已更新'} ${session.email || session.userId} · Token 至 ${exp}`;
    updateStatus(`${msg} · ${new Date().toLocaleString('zh-CN')}`);
    if (!silent) {
      void vscode.window.showInformationMessage(`Cursor Team Usage：${msg}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    updateStatus(`失败：${msg}`);
    if (!silent) {
      void vscode.window.showErrorMessage(`Cursor Team Usage 上报失败：${msg}`);
    }
  }
}

/**
 * 处理看板一键切换：备份当前 → 领票据 → 写本机 auth → 回报 → 重启 Cursor。
 */
async function handleAccountSwitch(context: vscode.ExtensionContext, ticketId: string) {
  if (switching) {
    void vscode.window.showWarningMessage('Cursor Team Usage：已有切换正在进行');
    return;
  }
  switching = true;
  const config = readReporterConfig();
  let logId: string | undefined;
  try {
    updateStatus('正在切换账号…');
    const claimed = await claimSwitchTicket(config, ticketId);
    logId = claimed.logId;
    const label = claimed.displayName || claimed.auth.cachedEmail || claimed.memberId;
    const confirm = await vscode.window.showInformationMessage(
      `即将切换到「${label}」并重启 Cursor。\n切换前会备份当前本机登录态，之后可用「恢复上次账号」还原。\n未保存的编辑请先保存。`,
      { modal: true },
      '继续切换',
    );
    if (confirm !== '继续切换') {
      await reportSwitchResult(config, {
        logId,
        ok: false,
        error: '用户在本机取消了切换',
      });
      updateStatus('已取消切换');
      return;
    }

    // 先备份当前本机账号，再写入目标；无当前登录态时跳过备份
    const backup = await backupCurrentLocalAuth(
      readerScriptPath(context),
      storageRoot(context),
      `切换前备份 → ${label}`,
    );
    if (backup) {
      updateStatus(`已备份 ${backup.email || backup.userId || '当前账号'}，正在写入…`);
    }

    await writeLocalCursorAuth(writerScriptPath(context), claimed.auth);
    await reportSwitchResult(config, { logId, ok: true });
    updateStatus(`已写入 ${label}，正在重启 Cursor…`);
    void vscode.window.showInformationMessage(
      `Cursor Team Usage：已切换到 ${label}${backup ? '（当前账号已备份）' : ''}，即将重启 Cursor`,
    );
    await scheduleCursorRestart();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (logId) {
      try {
        await reportSwitchResult(config, { logId, ok: false, error: msg });
      } catch {
        /* 回报失败不影响本地提示 */
      }
    }
    updateStatus(`切换失败：${msg}`);
    void vscode.window.showErrorMessage(`Cursor Team Usage 切换失败：${msg}`);
  } finally {
    switching = false;
  }
}

/**
 * 从备份区恢复「上次」本机账号：先备份当前，再写回 last.json，然后重启。
 */
async function handleRestoreLastAccount(context: vscode.ExtensionContext) {
  if (switching) {
    void vscode.window.showWarningMessage('Cursor Team Usage：已有切换正在进行');
    return;
  }
  const last = await loadLastAuthBackup(storageRoot(context));
  if (!last) {
    void vscode.window.showWarningMessage(
      'Cursor Team Usage：备份区没有上次账号。请先通过看板「切换」一次，才会生成备份。',
    );
    return;
  }

  switching = true;
  try {
    const label = last.email || last.userId || '上次账号';
    const when = last.savedAt
      ? new Date(last.savedAt).toLocaleString('zh-CN')
      : '未知时间';
    const confirm = await vscode.window.showInformationMessage(
      `即将从备份区恢复「${label}」（备份于 ${when}）并重启 Cursor。\n恢复前会先备份当前本机登录态。`,
      { modal: true },
      '恢复上次账号',
    );
    if (confirm !== '恢复上次账号') {
      updateStatus('已取消恢复');
      return;
    }

    // 恢复前备份当前，便于再次「恢复」回到此刻
    await backupCurrentLocalAuth(
      readerScriptPath(context),
      storageRoot(context),
      `恢复前备份 ← ${label}`,
    );
    await writeLocalCursorAuth(writerScriptPath(context), last.auth);
    updateStatus(`已恢复 ${label}，正在重启 Cursor…`);
    void vscode.window.showInformationMessage(
      `Cursor Team Usage：已恢复 ${label}，即将重启 Cursor`,
    );
    await scheduleCursorRestart();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    updateStatus(`恢复失败：${msg}`);
    void vscode.window.showErrorMessage(`Cursor Team Usage 恢复失败：${msg}`);
  } finally {
    switching = false;
  }
}

function setupAutoReport(context: vscode.ExtensionContext) {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  const mins = readReporterConfig().autoReportIntervalMinutes;
  if (!mins || mins <= 0) {
    updateStatus(lastMessage.includes('失败') ? lastMessage : '自动上报已关闭（仅手动）');
    return;
  }
  const ms = Math.max(1, mins) * 60_000;
  timer = setInterval(() => {
    void doReport(context, true);
  }, ms);
}

/**
 * IDE 打开即周期心跳，看板用此判在线；失败静默，避免打扰。
 */
function setupHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
  const tick = () => {
    void sendHeartbeat(readReporterConfig()).catch(() => {
      /* 网络/签名失败不弹窗；状态栏仍以上报结果为主 */
    });
  };
  tick();
  heartbeatTimer = setInterval(tick, HEARTBEAT_MS);
}

async function setupLocalBridge(context: vscode.ExtensionContext) {
  if (bridgeServer) {
    bridgeServer.close();
    bridgeServer = undefined;
  }
  const port = readLocalBridgePort();
  if (port <= 0) {
    updateStatus(lastMessage.includes('桥') ? lastMessage : `${lastMessage} · 本地桥已关闭`);
    return;
  }
  try {
    const { server, port: bound } = await startLocalBridge(
      port,
      (ticketId) => handleAccountSwitch(context, ticketId),
      () => handleRestoreLastAccount(context),
      async () => {
        const last = await loadLastAuthBackup(storageRoot(context));
        return summarizeBackup(last);
      },
      async (body) => {
        const vsixUrl = String(body?.vsixUrl || '').trim();
        if (vsixUrl) {
          await downloadAndInstallVsix(vsixUrl);
        } else {
          await installFromBoardWithAccessKey();
        }
        // 让 HTTP 响应先返回给页面，再自动重载；否则运行中的旧扩展仍会报告旧版本。
        setTimeout(() => {
          void vscode.commands.executeCommand('workbench.action.reloadWindow');
        }, 800);
        return { ok: true, message: 'installed', reloadScheduled: true };
      },
      async () => {
        const session = await resolveLocalCursorSession(readerScriptPath(context));
        if (!session) return { available: false };
        return {
          available: true,
          userId: session.userId,
          email: session.email || null,
          expiresAt: session.exp ? new Date(session.exp * 1000).toISOString() : null,
        };
      },
      async () => {
        const build = await readLocalBuildInfo(context.extensionPath);
        const config = readReporterConfig();
        return {
          version: build.version,
          build: build.build,
          operatorUsername: config.operatorUsername,
        };
      },
    );
    bridgeServer = server;
    context.subscriptions.push({
      dispose: () => {
        server.close();
        if (bridgeServer === server) bridgeServer = undefined;
      },
    });
    updateStatus(`就绪 · 本地桥 :${bound}（Agent 模式可用）`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    updateStatus(`本地桥启动失败：${msg}`);
    void vscode.window.showWarningMessage(
      `Cursor Team Usage：本机切换桥 :${port} 启动失败（${msg}）。Agent 模式下可能无法自动切换，可改 localBridgePort 或用命令「粘贴切换票据」。`,
    );
  }
}

export function activate(context: vscode.ExtensionContext) {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 80);
  statusBar.command = 'cursorTeamUsage.showStatus';
  statusBar.show();
  updateStatus('就绪 · 点击查看状态');

  // 确保 globalStorage 目录存在，备份可写入
  void vscode.workspace.fs.createDirectory(context.globalStorageUri);

  context.subscriptions.push(
    statusBar,
    vscode.commands.registerCommand('cursorTeamUsage.reportNow', () => doReport(context, false)),
    vscode.commands.registerCommand('cursorTeamUsage.showStatus', () => {
      void vscode.window.showInformationMessage(`Cursor Team Usage：${lastMessage}`);
    }),
    vscode.commands.registerCommand('cursorTeamUsage.claimSwitchTicket', async () => {
      const ticketId = await vscode.window.showInputBox({
        title: '粘贴看板切换票据',
        prompt: '看板点「切换」后若未自动唤起，把提示里的 ticket 粘贴到这里',
        placeHolder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
        ignoreFocusOut: true,
      });
      if (!ticketId?.trim()) return;
      await handleAccountSwitch(context, ticketId.trim());
    }),
    vscode.commands.registerCommand('cursorTeamUsage.restoreLastAccount', () =>
      handleRestoreLastAccount(context),
    ),
    vscode.commands.registerCommand('cursorTeamUsage.checkUpdate', async () => {
      try {
        const config = readReporterConfig();
        const local = await readLocalBuildInfo(context.extensionPath);
        const remote = await fetchRemoteBuildMeta(config.apiBaseUrl);
        if (!remote.build || remote.available === false) {
          void vscode.window.showWarningMessage('看板未附带可安装的插件资产');
          return;
        }
        const same = remote.version === local.version && remote.build === local.build;
        const choice = await vscode.window.showInformationMessage(
          same
            ? `已是最新构建 ${local.build}。仍要重装以刷新密钥/地址？`
            : `发现新构建 ${remote.version} (${remote.build})，当前 ${local.build}`,
          same ? '重装' : '立即更新',
          '取消',
        );
        if (choice !== '重装' && choice !== '立即更新') return;
        const meta = await installFromBoardWithAccessKey();
        const reload = await vscode.window.showInformationMessage(
          `已安装 ${meta.version} (${meta.build})，需重载窗口`,
          '重载窗口',
        );
        if (reload === '重载窗口') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        void vscode.window.showErrorMessage(`Cursor Team Usage 更新失败：${msg}`);
      }
    }),
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        // cursor://poiig.cursor-team-usage-reporter/switch?ticket=...（IDE 模式）
        const ticket = new URLSearchParams(uri.query).get('ticket') || '';
        if (!ticket) {
          void vscode.window.showErrorMessage('Cursor Team Usage：切换链接缺少 ticket');
          return;
        }
        void handleAccountSwitch(context, ticket);
      },
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cursorTeamUsage')) {
        setupAutoReport(context);
        if (e.affectsConfiguration('cursorTeamUsage.localBridgePort')) {
          void setupLocalBridge(context);
        }
      }
    }),
  );

  setupAutoReport(context);
  setupHeartbeat();
  void setupLocalBridge(context);
  // 启动后稍后自动报一次，避开扩展激活尖峰。
  setTimeout(() => void doReport(context, true), 8000);
  setTimeout(() => void maybePromptUpdate(context.extensionPath), 12_000);
}

export function deactivate() {
  if (timer) clearInterval(timer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (bridgeServer) {
    bridgeServer.close();
    bridgeServer = undefined;
  }
}
