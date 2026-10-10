import * as vscode from 'vscode';
import os from 'node:os';
import type { LocalSession } from './authReader';
import type { LocalAuthPayload } from './authWriter';

export type ReporterConfig = {
  apiBaseUrl: string;
  accessKey: string;
  displayName: string;
  refreshAfterReport: boolean;
  autoReportIntervalMinutes: number;
};

export function readReporterConfig(): ReporterConfig {
  const cfg = vscode.workspace.getConfiguration('cursorTeamUsage');
  return {
    apiBaseUrl: String(cfg.get('apiBaseUrl') || 'http://127.0.0.1:3780').replace(/\/+$/, ''),
    accessKey: String(cfg.get('accessKey') || '').trim(),
    displayName: String(cfg.get('displayName') || '').trim(),
    refreshAfterReport: cfg.get('refreshAfterReport') !== false,
    autoReportIntervalMinutes: Number(cfg.get('autoReportIntervalMinutes') ?? 60),
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
 * 调用看板 /api/agent/report，Header 带 Access Key。
 */
export async function reportSession(
  config: ReporterConfig,
  session: LocalSession,
): Promise<{ created: boolean; memberId?: string }> {
  assertReporterConfig(config);

  const host = os.hostname();
  const res = await fetch(`${config.apiBaseUrl}/api/agent/report`, {
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
      refresh: config.refreshAfterReport,
    }),
  });

  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    created?: boolean;
    member?: { id?: string };
  };
  if (!res.ok) {
    throw new Error(data.error || `上报失败 HTTP ${res.status}`);
  }
  return { created: Boolean(data.created), memberId: data.member?.id };
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
