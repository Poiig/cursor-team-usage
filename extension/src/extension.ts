import * as vscode from 'vscode';
import type { Server } from 'node:http';
import {
  ensureHomeAuthBackup,
  loadHomeAuthBackup,
  summarizeBackup,
  writeHomeAuthBackup,
  type AuthBackupRecord,
} from './authBackup';
import { probeLocalSessionAuth, resolveLocalCursorSession } from './authReader';
import { scheduleCursorRestart, writeLocalCursorAuth } from './authWriter';
import {
  fetchRemoteBuildMeta,
  autoUpdateAndReload,
  installAndOfferReload,
  installFromBoardWithAccessKey,
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
/** 成功回报最多等这么久就重启，看板慢不能拖住切换。 */
const REPORT_BEFORE_RESTART_MS = 3_000;

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
    const authOk = await probeLocalSessionAuth(session);
    if (authOk === false) {
      const msg = '本机会话已失效，已跳过上报（避免覆盖看板 Token）';
      updateStatus(msg);
      if (!silent) {
        void vscode.window.showWarningMessage(`Cursor Team Usage：${msg}`);
      }
      return;
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
    updateStatus(`正在切换到 ${label}…`);

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
    updateStatus(`正在恢复本机账号 ${label}…`);
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
function setupHeartbeat(context: vscode.ExtensionContext) {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
  const tick = () => {
    void sendHeartbeat(readReporterConfig())
      .then((info) => {
        // 看板明确说有新版本才装；旧服务端没有该字段时不打扰
        if (info.update) void autoUpdateAndReload(context.extensionPath);
      })
      .catch((e) => {
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

/** 探测 127.0.0.1:port 是否已是本扩展桥（多窗口时只有一个能 listen）。 */
async function isOwnBridgeListening(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => ({}))) as { service?: string };
    return data.service === 'cursor-team-usage-reporter';
  } catch {
    return false;
  }
}

async function closeBridgeServer(): Promise<void> {
  const server = bridgeServer;
  if (!server) return;
  bridgeServer = undefined;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // close 偶发不回调时不堵死重绑
    setTimeout(resolve, 500);
  });
}

async function setupLocalBridge(context: vscode.ExtensionContext) {
  await closeBridgeServer();
  const port = readLocalBridgePort();
  if (port <= 0) {
    updateStatus(lastMessage.includes('桥') ? lastMessage : `${lastMessage} · 本地桥已关闭`);
    return;
  }

  const bind = async () => {
    const boardOrigin = new URL(readReporterConfig().apiBaseUrl).origin;
    return startLocalBridge(
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
  };

  try {
    let started: Awaited<ReturnType<typeof startLocalBridge>>;
    try {
      started = await bind();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/EADDRINUSE/i.test(msg)) throw e;
      // 重载时旧监听可能尚未释放：稍等再试一次
      await new Promise((r) => setTimeout(r, 400));
      try {
        started = await bind();
      } catch (e2) {
        const msg2 = e2 instanceof Error ? e2.message : String(e2);
        if (/EADDRINUSE/i.test(msg2) && (await isOwnBridgeListening(port))) {
          // 另一 Cursor 窗口已在听：请求会打到那个窗口，本窗口不必再告警
          updateStatus(`就绪 · 本地桥 :${port}（其他窗口已监听）`);
          return;
        }
        throw e2;
      }
    }
    const { server, port: bound } = started;
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
        // 浏览器用 cursor:// 拉起 IDE。恢复认 path=/restore 或 ?action=restore（与切换同形，避免无 query 被协议层丢掉）。
        const route = uri.path.replace(/^\/+|\/+$/g, '');
        const params = new URLSearchParams(uri.query);
        if (route === 'restore' || params.get('action') === 'restore') {
          void handleRestoreHomeAccount(context);
          return;
        }
        const ticket = params.get('ticket') || '';
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
  setupHeartbeat(context);
  void setupLocalBridge(context);
  // 启动后稍后自动报一次，避开扩展激活尖峰。
  setTimeout(() => void doReport(context, true), 8000);
  setTimeout(() => void autoUpdateAndReload(context.extensionPath), 12_000);
}

export function deactivate() {
  if (timer) clearInterval(timer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (bridgeServer) {
    bridgeServer.close();
    bridgeServer = undefined;
  }
}
