/**
 * 本机 HTTP 桥：看板网页直接 POST 到 127.0.0.1，不依赖 cursor:// UriHandler。
 * Agent / Glass 模式往往接不住自定义协议，扩展宿主仍在跑时用这条通道。
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as vscode from 'vscode';

export type BridgeHandler = (ticketId: string) => void | Promise<void>;

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

/**
 * 仅绑定环回地址；带 CORS，方便看板页（任意内网 Origin）调用。
 */
export function startLocalBridge(
  port: number,
  onSwitch: BridgeHandler,
): Promise<{ server: http.Server; port: number }> {
  if (port <= 0) {
    return Promise.reject(new Error('local bridge disabled'));
  }

  const server = http.createServer(async (req, res) => {
    const origin = String(req.headers.origin || '*');
    const cors = {
      'Access-Control-Allow-Origin': origin === 'null' ? '*' : origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, service: 'cursor-team-usage-reporter' }));
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
          res.writeHead(400, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '缺少 ticketId' }));
          return;
        }
        // 先回 202，再异步跑切换（含模态确认 / 写库 / 重启），避免浏览器等太久
        res.writeHead(202, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, accepted: true, ticketId }));
        void Promise.resolve(onSwitch(ticketId)).catch((e) => {
          console.error('[ctu localBridge] switch failed:', e);
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        res.writeHead(400, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: msg }));
      }
      return;
    }

    res.writeHead(404, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not found' }));
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
