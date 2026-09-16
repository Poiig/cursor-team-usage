import * as vscode from 'vscode';
import os from 'node:os';
import type { LocalSession } from './authReader';

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

/**
 * 调用看板 /api/agent/report，Header 带 Access Key。
 */
export async function reportSession(
  config: ReporterConfig,
  session: LocalSession,
): Promise<{ created: boolean; memberId?: string }> {
  if (!config.accessKey) {
    throw new Error('未配置 cursorTeamUsage.accessKey（需与服务端 ACCESS_KEY 一致）');
  }
  if (!config.apiBaseUrl) {
    throw new Error('未配置 cursorTeamUsage.apiBaseUrl');
  }

  const host = os.hostname();
  const res = await fetch(`${config.apiBaseUrl}/api/agent/report`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Access-Key': config.accessKey,
    },
    body: JSON.stringify({
      sessionToken: session.cookieValue,
      // 未手动配置显示名时，默认用本机机器名。
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
