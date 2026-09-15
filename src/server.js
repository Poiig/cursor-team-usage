/**
 * 本地 HTTP 服务：静态看板 + 成员 CRUD + 用量同步。
 * 默认只监听 127.0.0.1，避免会话 Token 被局域网误访问。
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchMemberSnapshot } from './cursor-api.js';
import { probeLocalCursorSession, resolveLocalCursorSession } from './local-session.js';
import {
  addMember,
  deleteMember,
  getAllMembersInternal,
  getMemberInternal,
  listMembers,
  saveSyncResult,
  updateMember,
} from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3780);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

/**
 * @param {import('node:http').IncomingMessage} req
 */
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  return JSON.parse(text);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} data
 */
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * 从已缓存快照汇总团队级指标，避免列表接口再打 cursor.com。
 * @param {Awaited<ReturnType<typeof listMembers>>} members
 */
function buildTeamSummary(members) {
  let billed = 0;
  let requests = 0;
  let tokens = 0;
  let withQuota = 0;
  let nearQuota = 0;
  let nearSpend = 0;
  let ok = 0;
  let errored = 0;

  for (const m of members) {
    if (m.lastError && !m.lastSnapshot) errored++;
    else if (m.lastSnapshot) ok++;

    const snap = m.lastSnapshot;
    if (!snap) continue;
    billed += snap.usage?.billedDollars ?? 0;
    requests += snap.usage?.requestCount ?? 0;
    tokens += snap.usage?.totalTokens ?? 0;
    if (snap.quota?.limit != null && snap.quota.limit > 0) withQuota++;
    const primary =
      snap.meters?.primaryPercent ??
      snap.meters?.totalPercentUsed ??
      snap.meters?.quotaPercent ??
      snap.meters?.spendPercent;
    if ((primary ?? 0) >= 80) nearQuota++;
    if ((snap.meters?.spendPercent ?? 0) >= 80) nearSpend++;
  }

  return {
    memberCount: members.length,
    syncedOk: ok,
    syncedError: errored,
    cycleBilledDollars: Math.round(billed * 100) / 100,
    cycleRequests: requests,
    cycleTokens: tokens,
    membersWithQuota: withQuota,
    nearQuotaCount: nearQuota,
    nearSpendCount: nearSpend,
  };
}

/**
 * 同步一名成员；失败写 lastError，不中断其余成员。
 * @param {string} id
 */
async function refreshOne(id) {
  const member = await getMemberInternal(id);
  if (!member) throw new Error('成员不存在');
  try {
    const snapshot = await fetchMemberSnapshot(member.cookieValue);
    return await saveSyncResult(id, { snapshot });
  } catch (e) {
    return await saveSyncResult(id, { error: e?.message || String(e) });
  }
}

/**
 * 并发刷新全员；限制并发避免触发 cursor.com 风控。
 * @param {number} [concurrency]
 */
async function refreshAll(concurrency = 3) {
  const members = await getAllMembersInternal();
  const queue = [...members];
  const results = [];

  async function worker() {
    while (queue.length) {
      const m = queue.shift();
      if (!m) break;
      results.push(await refreshOne(m.id));
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, members.length)) }, () =>
      worker(),
    ),
  );
  return results;
}

/**
 * @param {string} urlPath
 */
async function serveStatic(urlPath) {
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe === path.sep ? 'index.html' : safe);
  if (!filePath.startsWith(PUBLIC_DIR)) return null;
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    return { data, type: MIME[ext] || 'application/octet-stream' };
  } catch {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
    const { pathname } = url;
    const method = req.method || 'GET';

    if (method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'GET' && pathname === '/api/members') {
      const members = await listMembers();
      return sendJson(res, 200, { members, summary: buildTeamSummary(members) });
    }

    if (method === 'GET' && pathname === '/api/local-session') {
      return sendJson(res, 200, await probeLocalCursorSession());
    }

    if (method === 'POST' && pathname === '/api/members') {
      const body = await readBody(req);
      // 本机导入：服务端读 Cursor 登录态，前端不必经手完整 token。
      if (body?.fromLocalCursor) {
        const local = await resolveLocalCursorSession();
        if (!local) throw new Error('本机未找到有效的 Cursor 登录态');
        const displayName =
          String(body.displayName || '').trim() ||
          local.email ||
          local.userId;
        const member = await addMember({
          displayName,
          sessionToken: local.cookieValue,
        });
        const refreshed = await refreshOne(member.id);
        return sendJson(res, 201, {
          member: refreshed,
          local: {
            email: local.email,
            expiresAt: local.exp ? new Date(local.exp * 1000).toISOString() : null,
          },
        });
      }
      const member = await addMember(body);
      // 新增后立刻拉一次，看板马上有数；失败也保留名册条目。
      const refreshed = await refreshOne(member.id);
      return sendJson(res, 201, { member: refreshed });
    }

    const memberMatch = pathname.match(/^\/api\/members\/([^/]+)(\/refresh)?$/);
    if (memberMatch) {
      const id = decodeURIComponent(memberMatch[1]);
      const isRefresh = Boolean(memberMatch[2]);

      if (method === 'POST' && isRefresh) {
        const member = await refreshOne(id);
        return sendJson(res, 200, { member });
      }
      if (method === 'PUT' && !isRefresh) {
        const body = await readBody(req);
        const member = await updateMember(id, body);
        return sendJson(res, 200, { member });
      }
      if (method === 'DELETE' && !isRefresh) {
        await deleteMember(id);
        return sendJson(res, 200, { ok: true });
      }
    }

    if (method === 'POST' && pathname === '/api/refresh-all') {
      const members = await refreshAll();
      return sendJson(res, 200, {
        members,
        summary: buildTeamSummary(members.map((m) => m || {}).filter(Boolean)),
      });
    }

    if (method === 'GET' || method === 'HEAD') {
      const rel = pathname === '/' ? '/index.html' : pathname;
      const file = await serveStatic(rel);
      if (file) {
        res.writeHead(200, { 'Content-Type': file.type });
        res.end(method === 'HEAD' ? undefined : file.data);
        return;
      }
      return sendJson(res, 404, { error: 'Not found' });
    }

    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    const status = /不存在/.test(e?.message || '') ? 404 : 400;
    sendJson(res, status, { error: e?.message || String(e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Cursor Team Usage → http://${HOST}:${PORT}`);
  console.log('个人版模式：每位成员需提供 WorkosCursorSessionToken');
});
