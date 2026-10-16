/**
 * 本机 HTTP 桥：看板网页直接 POST 到 127.0.0.1，不依赖 cursor:// UriHandler。
 * Agent / Glass 模式往往接不住自定义协议，扩展宿主仍在跑时用这条通道。
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as vscode from 'vscode';

export type BridgeHandler = (ticketId: string) => void | Promise<void>;
export type RestoreHandler = () => void | Promise<void>;
export type BackupInfoHandler = () =>
  | Promise<Record<string, unknown>>
  | Record<string, unknown>;
export type InstallExtensionHandler = () => void | Promise<{ ok: boolean; message?: string }>;
export type CurrentAccountHandler = () =>
  | Promise<Record<string, unknown>>
  | Record<string, unknown>;
export type ExtensionInfoHandler = () =>
  | Promise<Record<string, unknown>>
  | Record<string, unknown>;

const DEFAULT_PORT = 3781;

/**
 * @returns 实际监听端口；0 表示关闭
 */
export function readLocalBridgePort(): number {
  const cfg = vscode.workspace.getConfiguration('cursorTeamUsage');
  const n = Number(cfg.get('localBridgePort'));
  if (!Number.isFinite(n) || n < 0) return DEFAULT_PORT;
  return Math.floor(n);
}

function writeCorsJson(
  res: http.ServerResponse,
  cors: Record<string, string>,
  status: number,
  body: unknown,
) {
  res.writeHead(status, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * 浏览器会随跨域请求带 Origin；只接受已配置看板，避免任意网页驱动本机 Cursor。
 */
function isAllowedBoardOrigin(origin: string, expectedOrigin: string): boolean {
  return Boolean(origin) && origin === expectedOrigin;
}

/**
 * 仅绑定环回地址，并仅向已配置看板开放跨域状态操作。
 */
export function startLocalBridge(
  port: number,
  boardOrigin: string,
  onSwitch: BridgeHandler,
  onRestore?: RestoreHandler,
  onBackupInfo?: BackupInfoHandler,
  onInstallExtension?: InstallExtensionHandler,
  onCurrentAccount?: CurrentAccountHandler,
  onExtensionInfo?: ExtensionInfoHandler,
): Promise<{ server: http.Server; port: number }> {
  if (port <= 0) {
    return Promise.reject(new Error('local bridge disabled'));
  }

  const server = http.createServer(async (req, res) => {
    const origin = String(req.headers.origin || '');
    const allowedOrigin = isAllowedBoardOrigin(origin, boardOrigin);
    const cors = {
      ...(allowedOrigin ? { 'Access-Control-Allow-Origin': boardOrigin } : {}),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(allowedOrigin ? 204 : 403, cors);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
      writeCorsJson(res, cors, 200, { ok: true, service: 'cursor-team-usage-reporter' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/current-account') {
      try {
        const info = onCurrentAccount ? await onCurrentAccount() : { available: false };
        writeCorsJson(res, cors, 200, { ok: true, ...info });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeCorsJson(res, cors, 500, { error: msg });
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/extension-info') {
      try {
        const info = onExtensionInfo ? await onExtensionInfo() : {};
        writeCorsJson(res, cors, 200, { ok: true, ...info });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeCorsJson(res, cors, 500, { error: msg });
      }
      return;
    }

    // 本机账号备份摘要：看板「恢复本机账号」按钮用
    if (req.method === 'GET' && url.pathname === '/backup') {
      try {
        const info = onBackupInfo ? await onBackupInfo() : { exists: false };
        writeCorsJson(res, cors, 200, { ok: true, ...info });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeCorsJson(res, cors, 500, { error: msg });
      }
      return;
    }

    if (req.method === 'POST' && !allowedOrigin) {
      writeCorsJson(res, cors, 403, { error: '不受信任的看板来源' });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/restore') {
      if (!onRestore) {
        writeCorsJson(res, cors, 501, { error: 'restore not available' });
        return;
      }
      try {
        // 先 202，再异步跑确认 / 写库 / 重启
        writeCorsJson(res, cors, 202, { ok: true, accepted: true });
        void Promise.resolve(onRestore()).catch((e) => {
          console.error('[ctu localBridge] restore failed:', e);
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeCorsJson(res, cors, 400, { error: msg });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/switch') {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        const body = JSON.parse(raw) as { ticketId?: string; ticket?: string };
        const ticketId = String(body.ticketId || body.ticket || url.searchParams.get('ticket') || '').trim();
        if (!ticketId) {
          writeCorsJson(res, cors, 400, { error: '缺少 ticketId' });
          return;
        }
        // 先回 202，再异步跑切换（含模态确认 / 写库 / 重启），避免浏览器等太久
        writeCorsJson(res, cors, 202, { ok: true, accepted: true, ticketId });
        void Promise.resolve(onSwitch(ticketId)).catch((e) => {
          console.error('[ctu localBridge] switch failed:', e);
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeCorsJson(res, cors, 400, { error: msg });
      }
      return;
    }

    // 看板一键安装：下载已注入 ACCESS_KEY 的 VSIX 并装进当前 Cursor
    if (req.method === 'POST' && url.pathname === '/install-extension') {
      if (!onInstallExtension) {
        writeCorsJson(res, cors, 501, { error: 'install-extension not available' });
        return;
      }
      try {
        const result = await onInstallExtension();
        writeCorsJson(res, cors, 200, result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeCorsJson(res, cors, 400, { error: msg });
      }
      return;
    }

    writeCorsJson(res, cors, 404, { error: 'Not found' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // 只听本机，避免局域网误触切换
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}
