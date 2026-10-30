import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AuthBackupRecord } from './authBackup';
import type { LocalSession } from './authReader';
import type { LocalAuthPayload } from './authWriter';

export type ReporterConfig = {
  apiBaseUrl: string;
  accessKey: string;
  operatorUsername: string;
  operatorProof: string;
  displayName: string;
  refreshAfterReport: boolean;
};

const EXTENSION_ID = 'poiig.cursor-team-usage-reporter';

/**
 * 安装包内 build-info 为准：密钥/地址/使用人签名；settings 里旧默认值（如误装未注入包）不能盖过它。
 */
function readPackagedBuildInfo(): {
  apiBaseUrl?: string;
  accessKey?: string;
  username?: string;
  proof?: string;
} | null {
  const dir = vscode.extensions.getExtension(EXTENSION_ID)?.extensionPath;
  if (!dir) return null;
  try {
    const j = JSON.parse(readFileSync(path.join(dir, 'build-info.json'), 'utf8')) as {
      apiBaseUrl?: string;
      accessKey?: string;
      operatorUsername?: string;
      operatorProof?: string;
    };
    return {
      apiBaseUrl: String(j.apiBaseUrl || '').trim() || undefined,
      accessKey: String(j.accessKey || '').trim() || undefined,
      username: String(j.operatorUsername || '').trim() || undefined,
      proof: String(j.operatorProof || '').trim() || undefined,
    };
  } catch {
    return null;
  }
}

export function readReporterConfig(): ReporterConfig {
  const cfg = vscode.workspace.getConfiguration('cursorTeamUsage');
  const packaged = readPackagedBuildInfo();
  return {
    apiBaseUrl: (
      packaged?.apiBaseUrl ||
      String(cfg.get('apiBaseUrl') || 'http://127.0.0.1:3780')
    ).replace(/\/+$/, ''),
    accessKey: packaged?.accessKey || String(cfg.get('accessKey') || '').trim(),
    operatorUsername: packaged?.username || String(cfg.get('operatorUsername') || '').trim(),
    operatorProof: packaged?.proof || String(cfg.get('operatorProof') || '').trim(),
    displayName: String(cfg.get('displayName') || '').trim(),
    refreshAfterReport: cfg.get('refreshAfterReport') !== false,
  };
}

function assertReporterConfig(config: ReporterConfig) {
  if (!config.accessKey) {
    throw new Error('未配置 cursorTeamUsage.accessKey（需与服务端 ACCESS_KEY 一致）');
  }
  if (!config.apiBaseUrl) {
    throw new Error('未配置 cursorTeamUsage.apiBaseUrl');
  }
}

/**
 * IDE 存活心跳：只证明插件进程在跑，不上传会话。
 */
export async function sendHeartbeat(
  config: ReporterConfig,
): Promise<{ update: boolean; version: string }> {
  assertReporterConfig(config);
  if (!config.operatorUsername || !config.operatorProof) {
    throw new Error('未绑定看板用户（请用个性化安装包重装）');
  }
  const own = vscode.extensions.getExtension(EXTENSION_ID);
  const res = await fetch(`${config.apiBaseUrl}/api/agent/heartbeat`, {
    signal: AbortSignal.timeout(15_000),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Access-Key': config.accessKey,
    },
    body: JSON.stringify({
      hostname: os.hostname(),
      operatorUsername: config.operatorUsername,
      operatorProof: config.operatorProof,
      pluginVersion: String(own?.packageJSON?.version || ''),
      pluginBuild: String(own?.packageJSON?.ctuBuild || ''),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
    update?: boolean;
    version?: string;
  };
  if (!res.ok) {
    const msg = data.error || `心跳失败 HTTP ${res.status}`;
    throw data.code === 'OPERATOR_PROOF' ? new OperatorProofError(msg) : new Error(msg);
  }
  return { update: Boolean(data.update), version: String(data.version || '') };
}

/** 安装包里的使用人签名不被看板认可，只能重新从看板安装。 */
export class OperatorProofError extends Error {}

/**
 * 无本地 home 时：向看板按本机 hostname 查成员表首次上报账号，落成备份记录。
 */
export async function fetchHomeAccountFromBoard(
  config: ReporterConfig,
): Promise<AuthBackupRecord | null> {
  if (!config.apiBaseUrl || !config.accessKey) return null;
  const hostname = os.hostname();
  const url = `${config.apiBaseUrl}/api/agent/home-account?hostname=${encodeURIComponent(hostname)}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { 'X-Access-Key': config.accessKey },
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `查询本机账号失败 HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    found?: boolean;
    email?: string | null;
    displayName?: string | null;
    auth?: LocalAuthPayload;
  };
  if (!data.found || !data.auth?.accessToken) return null;
  return {
    savedAt: new Date().toISOString(),
    hostname,
    email: data.email || data.auth.cachedEmail || null,
    userId: data.auth.userId || null,
    note: `看板号池（首次上报主机 ${hostname}）`,
    auth: data.auth,
  };
}

/**
 * 调用看板 /api/agent/report，Header 带 Access Key。
 */
export async function reportSession(
  config: ReporterConfig,
  session: LocalSession,
): Promise<{ created: boolean; memberId?: string; operatorError?: string | null }> {
  assertReporterConfig(config);

  const host = os.hostname();
  const own = vscode.extensions.getExtension(EXTENSION_ID);
  const res = await fetch(`${config.apiBaseUrl}/api/agent/report`, {
    // 服务端上报后会顺带刷新用量，留足时间
    signal: AbortSignal.timeout(60_000),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Access-Key': config.accessKey,
    },
    body: JSON.stringify({
      sessionToken: session.cookieValue,
      // 仅新建账号时服务端采用显示名；已有账号不会被覆盖
      displayName: config.displayName || host || session.email || session.userId,
      email: session.email,
      hostname: host,
      operatorUsername: config.operatorUsername,
      operatorProof: config.operatorProof,
      pluginVersion: String(own?.packageJSON?.version || ''),
      pluginBuild: String(own?.packageJSON?.ctuBuild || ''),
      refresh: config.refreshAfterReport,
    }),
  });

  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    created?: boolean;
    member?: { id?: string };
    operatorVerified?: boolean;
    operatorError?: string | null;
  };
  if (!res.ok) {
    throw new Error(data.error || `上报失败 HTTP ${res.status}`);
  }
  return {
    created: Boolean(data.created),
    memberId: data.member?.id,
    // 旧服务端不返回该字段，视为通过
    operatorError: data.operatorVerified === false ? data.operatorError || '签名无效' : null,
  };
}

/**
 * 领取网页发起的一键切换票据，拿到要写入本机的会话字段。
 */
export async function claimSwitchTicket(
  config: ReporterConfig,
  ticketId: string,
): Promise<{
  logId: string;
  ticketId: string;
  memberId: string;
  displayName?: string | null;
  operatorUsername?: string;
  auth: LocalAuthPayload;
}> {
  assertReporterConfig(config);
  const res = await fetch(`${config.apiBaseUrl}/api/agent/switch/claim`, {
    signal: AbortSignal.timeout(30_000),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Access-Key': config.accessKey,
    },
    body: JSON.stringify({
      ticketId,
      hostname: os.hostname(),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    logId?: string;
    ticketId?: string;
    memberId?: string;
    displayName?: string | null;
    operatorUsername?: string;
    auth?: LocalAuthPayload;
  };
  if (!res.ok || !data.auth || !data.logId) {
    throw new Error(data.error || `领取切换票据失败 HTTP ${res.status}`);
  }
  return {
    logId: data.logId,
    ticketId: data.ticketId || ticketId,
    memberId: data.memberId || '',
    displayName: data.displayName,
    operatorUsername: data.operatorUsername,
    auth: data.auth,
  };
}

/**
 * 向看板回报切换成败，供切换日志与操作日志落盘。
 */
export async function reportSwitchResult(
  config: ReporterConfig,
  input: { logId: string; ok: boolean; error?: string },
): Promise<void> {
  assertReporterConfig(config);
  const res = await fetch(`${config.apiBaseUrl}/api/agent/switch/result`, {
    signal: AbortSignal.timeout(30_000),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Access-Key': config.accessKey,
    },
    body: JSON.stringify({
      logId: input.logId,
      ok: input.ok,
      error: input.error,
      hostname: os.hostname(),
    }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `回报切换结果失败 HTTP ${res.status}`);
  }
}
