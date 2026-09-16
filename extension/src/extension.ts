import * as vscode from 'vscode';
import path from 'node:path';
import { resolveLocalCursorSession } from './authReader';
import { readReporterConfig, reportSession } from './reporter';

let statusBar: vscode.StatusBarItem | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let lastMessage = '尚未上报';

function readerScriptPath(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, 'dist', 'read_cursor_auth.py');
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
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cursorTeamUsage')) {
        setupAutoReport(context);
      }
    }),
  );

  setupAutoReport(context);
  // 启动后稍后自动报一次，避开扩展激活尖峰。
  setTimeout(() => void doReport(context, true), 8000);
}

export function deactivate() {
  if (timer) clearInterval(timer);
}
