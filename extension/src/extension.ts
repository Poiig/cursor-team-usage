import * as vscode from 'vscode';
import type { Server } from 'node:http';
import path from 'node:path';
import { resolveLocalCursorSession } from './authReader';
import { scheduleCursorRestart, writeLocalCursorAuth } from './authWriter';
import { readLocalBridgePort, startLocalBridge } from './localBridge';
import {
  claimSwitchTicket,
  readReporterConfig,
  reportSession,
  reportSwitchResult,
} from './reporter';

let statusBar: vscode.StatusBarItem | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
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
 * 处理看板一键切换：领票据 → 写本机 auth → 回报 → 重启 Cursor。
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
      `即将切换到「${label}」并重启 Cursor。未保存的编辑请先保存。`,
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

    await writeLocalCursorAuth(writerScriptPath(context), claimed.auth);
    await reportSwitchResult(config, { logId, ok: true });
    updateStatus(`已写入 ${label}，正在重启 Cursor…`);
    void vscode.window.showInformationMessage(
      `Cursor Team Usage：已切换到 ${label}，即将重启 Cursor`,
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
    const { server, port: bound } = await startLocalBridge(port, (ticketId) =>
      handleAccountSwitch(context, ticketId),
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
  void setupLocalBridge(context);
  // 启动后稍后自动报一次，避开扩展激活尖峰。
  setTimeout(() => void doReport(context, true), 8000);
}

export function deactivate() {
  if (timer) clearInterval(timer);
  if (bridgeServer) {
    bridgeServer.close();
    bridgeServer = undefined;
  }
}
