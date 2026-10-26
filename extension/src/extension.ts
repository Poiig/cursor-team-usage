import * as vscode from 'vscode';
import type { Server } from 'node:http';
import {
  ensureHomeAuthBackup,
  loadHomeAuthBackup,
  summarizeBackup,
  writeHomeAuthBackup,
  type AuthBackupRecord,
} from './authBackup';
import { resolveLocalCursorSession } from './authReader';
import { scheduleCursorRestart, writeLocalCursorAuth } from './authWriter';
import {
  fetchRemoteBuildMeta,
  installAndOfferReload,
  installFromBoardWithAccessKey,
  maybePromptUpdate,
  promptReinstallFromBoard,
  readLocalBuildInfo,
} from './extensionInstall';
import { readLocalBridgePort, startLocalBridge } from './localBridge';
import {
  claimSwitchTicket,
  fetchHomeAccountFromBoard,
  OperatorProofError,
  readReporterConfig,
  reportSession,
  reportSwitchResult,
  sendHeartbeat,
} from './reporter';

/** 与服务端 PLUGIN_ONLINE_MS=5min 对齐：约 2.5 个周期内无 ping 判离线。 */
const HEARTBEAT_MS = 2 * 60_000;
/** 固定行为，不开放配置。 */
const AUTO_REPORT_MS = 10 * 60_000;

let statusBar: vscode.StatusBarItem | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let bridgeServer: Server | undefined;
let lastMessage = '尚未上报';
let operatorWarned = false;
/** 避免同一 URI / 票据被并发处理两次。 */
let switching = false;
/** 切换 / 恢复确认最多等 2 分钟，避免没人点时 switching 一直占着、后续切换全被拒。 */
const CONFIRM_TIMEOUT_MS = 2 * 60_000;
/** 成功回报最多等这么久就重启，看板慢不能拖住切换。 */
const REPORT_BEFORE_RESTART_MS = 3_000;

/**
 * 用右下角非模态通知确认，不用 modal：Cursor 默认原生对话框，从浏览器触发时常被压在后面，
 * 原生模态又会锁住主窗口，用户看到的就是 Cursor 卡死。超时视为取消。
 * @returns 用户点的按钮；超时为 'timeout'
 */
async function confirmNonModal(message: string, action: string): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), CONFIRM_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      vscode.window.showInformationMessage(message, action, '取消'),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
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

/** 签名问题每个窗口只弹一次，之后仅在状态栏体现。 */
function warnOperatorProof(reason: string) {
  if (statusBar) statusBar.text = '$(warning) CTU';
  if (operatorWarned) return;
  operatorWarned = true;
  void promptReinstallFromBoard(reason);
}

async function doReport(context: vscode.ExtensionContext, silent: boolean) {
  const config = readReporterConfig();
  try {
    const session = await resolveLocalCursorSession();
    if (!session) {
      throw new Error('未找到有效的 Cursor 登录态，请先在本机登录 Cursor');
    }
    const result = await reportSession(config, session);
    const exp = session.exp
      ? new Date(session.exp * 1000).toLocaleString('zh-CN')
      : '未知';
    const msg = `${result.created ? '已注册' : '已更新'} ${session.email || session.userId} · Token 至 ${exp}`;
    if (result.operatorError) {
      updateStatus(`${msg}，但未关联到看板用户（${result.operatorError}）`);
      warnOperatorProof(`上报未关联到你的看板用户（${result.operatorError}）`);
      return;
    }
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
    updateStatus(`等待确认切换到 ${label}…`);
    const confirm = await confirmNonModal(
      `Cursor Team Usage：即将切换到「${label}」并重启 Cursor。首次切换会记下当前本机账号，之后可用「恢复本机账号」还原；未保存的编辑请先保存。`,
      '继续切换',
    );
    if (confirm !== '继续切换') {
      const timedOut = confirm === 'timeout';
      await reportSwitchResult(config, {
        logId,
        ok: false,
        error: timedOut ? '本机 2 分钟内未确认，已自动取消' : '用户在本机取消了切换',
      });
      updateStatus(timedOut ? '切换确认超时，已取消' : '已取消切换');
      return;
    }

    // 无本地备份时先按 hostname 查号池原注册账号，再退回抓当前登录态
    const home = await resolveOrCaptureHomeAccount(
      context,
      `本机账号（首次切换 → ${label}）`,
    );
    if (home) {
      updateStatus(`本机账号 ${home.email || home.userId || '已备份'}，正在写入…`);
    }

    await writeLocalCursorAuth(claimed.auth);
    // 本机已写入即算成功；回报失败只影响看板日志，不能因此不重启
    await Promise.race([
      reportSwitchResult(config, { logId, ok: true }).catch(() => {}),
      new Promise((r) => setTimeout(r, REPORT_BEFORE_RESTART_MS)),
    ]);
    updateStatus(`已写入 ${label}，正在重启 Cursor…`);
    void vscode.window.showInformationMessage(
      `Cursor Team Usage：已切换到 ${label}${home ? '（本机账号已保留）' : ''}，即将重启 Cursor`,
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
 * 本地无 home 时向看板按 hostname 找回号池原账号并落盘。
 */
async function resolveOrCaptureHomeAccount(
  context: vscode.ExtensionContext,
  note?: string | null,
): Promise<AuthBackupRecord | null> {
  const existing = await loadHomeAuthBackup(storageRoot(context));
  if (existing) return existing;
  let boardHome: AuthBackupRecord | null = null;
  try {
    boardHome = await fetchHomeAccountFromBoard(readReporterConfig());
  } catch (e) {
    console.warn('[ctu] home-account from board:', e);
  }
  return ensureHomeAuthBackup(storageRoot(context), note, boardHome);
}

/**
 * 写回本机账号；无本地备份时先按号池 hostname 找回。
 */
async function handleRestoreHomeAccount(context: vscode.ExtensionContext) {
  if (switching) {
    void vscode.window.showWarningMessage('Cursor Team Usage：已有切换正在进行');
    return;
  }
  let home = await loadHomeAuthBackup(storageRoot(context));
  if (!home) {
    try {
      const fromBoard = await fetchHomeAccountFromBoard(readReporterConfig());
      if (fromBoard) home = await writeHomeAuthBackup(storageRoot(context), fromBoard);
    } catch (e) {
      console.warn('[ctu] home-account from board:', e);
    }
  }
  if (!home) {
    void vscode.window.showWarningMessage(
      'Cursor Team Usage：找不到本机账号。请确认号池里有本机首次上报的账号，或先在原账号下切换一次以生成备份。',
    );
    return;
  }

  switching = true;
  try {
    const label = home.email || home.userId || '本机账号';
    const when = home.savedAt
      ? new Date(home.savedAt).toLocaleString('zh-CN')
      : '未知时间';
    const confirm = await confirmNonModal(
      `Cursor Team Usage：即将恢复本机账号「${label}」（备份于 ${when}）并重启 Cursor。`,
      '恢复本机账号',
    );
    if (confirm !== '恢复本机账号') {
      updateStatus(confirm === 'timeout' ? '恢复确认超时，已取消' : '已取消恢复');
      return;
    }

    await writeLocalCursorAuth(home.auth);
    updateStatus(`已恢复本机账号 ${label}，正在重启 Cursor…`);
    void vscode.window.showInformationMessage(
      `Cursor Team Usage：已恢复本机账号 ${label}，即将重启 Cursor`,
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
  timer = setInterval(() => {
    void doReport(context, true);
  }, AUTO_REPORT_MS);
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
    void sendHeartbeat(readReporterConfig()).catch((e) => {
      // 网络抖动静默；签名无效会导致看板一直离线，必须让用户知道
      if (e instanceof OperatorProofError) {
        updateStatus(`心跳被拒：${e.message}`);
        warnOperatorProof(e.message);
      }
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
    const boardOrigin = new URL(readReporterConfig().apiBaseUrl).origin;
    const { server, port: bound } = await startLocalBridge(
      port,
      boardOrigin,
      (ticketId) => handleAccountSwitch(context, ticketId),
      () => handleRestoreHomeAccount(context),
      async () => {
        const home = await loadHomeAuthBackup(storageRoot(context));
        return summarizeBackup(home);
      },
      async () => {
        // 仅从已配置看板拉包，不能让网页指定任意 VSIX 来源。
        await installFromBoardWithAccessKey();
        // 让 HTTP 响应先返回给页面，再自动重载；否则运行中的旧扩展仍会报告旧版本。
        setTimeout(() => {
          void vscode.commands.executeCommand('workbench.action.reloadWindow');
        }, 800);
        return { ok: true, message: 'installed', reloadScheduled: true };
      },
      async () => {
        const session = await resolveLocalCursorSession();
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
      handleRestoreHomeAccount(context),
    ),
    vscode.commands.registerCommand('cursorTeamUsage.checkUpdate', async () => {
      try {
        const config = readReporterConfig();
        const local = await readLocalBuildInfo(context.extensionPath);
        const remote = await fetchRemoteBuildMeta(config.apiBaseUrl);
        if (!remote.version || remote.available === false) {
          void vscode.window.showWarningMessage('看板未附带可安装的插件资产');
          return;
        }
        const same = remote.version === local.version;
        const choice = await vscode.window.showInformationMessage(
          same
            ? `已是最新版本 ${local.version}。仍要重装以刷新密钥/地址？`
            : `发现新版本 ${remote.version}，当前 ${local.version}`,
          same ? '重装' : '立即更新',
          '取消',
        );
        if (choice !== '重装' && choice !== '立即更新') return;
        await installAndOfferReload();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        void vscode.window.showErrorMessage(`Cursor Team Usage 检查更新失败：${msg}`);
      }
    }),
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        // 浏览器打不开本机桥时，用 cursor:// 拉起 IDE。path 区分切换和恢复，恢复不需要票据。
        const route = uri.path.replace(/^\/+|\/+$/g, '');
        if (route === 'restore') {
          void handleRestoreHomeAccount(context);
          return;
        }
        const ticket = new URLSearchParams(uri.query).get('ticket') || '';
        if (!ticket) {
          void vscode.window.showErrorMessage('Cursor Team Usage：切换链接缺少 ticket');
          return;
        }
        void handleAccountSwitch(context, ticket);
      },
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cursorTeamUsage.localBridgePort')) {
        void setupLocalBridge(context);
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
