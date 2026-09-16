/**
 * 本地 HTTP 服务：静态看板 + 成员 CRUD + 用量同步 + 登录鉴权。
 * 默认只监听 127.0.0.1，避免会话 Token 被局域网误访问。
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getListenConfig,
  getServerAutoRefreshSec,
  getStoreDriver,
  loadAppConfig,
} from './config.js';
import { assertAccessKey, isAccessKeyConfigured } from './access-key.js';
import { fetchMemberSnapshot, fetchMemberUsageEvents } from './cursor-api.js';
import { probeLocalCursorSession, resolveLocalCursorSession } from './local-session.js';
import {
  clearSessionCookie,
  issueSessionToken,
  readSessionFromRequest,
  setSessionCookie,
} from './session-auth.js';
import {
  addMember,
  deleteMember,
  getAllMembersInternal,
  getMemberInternal,
  initStore,
  listMembers,
  saveSyncResult,
  toPublicMember,
  updateMember,
  upsertMemberBySession,
} from './store.js';
import {
  authenticateUser,
  changeAdminPassword,
  initUsers,
  mustChangePasswordFor,
} from './users.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const { host: HOST, port: PORT } = getListenConfig();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/** 无需登录可访问的静态资源前缀/文件。 */
const PUBLIC_STATIC = new Set([
  '/login.html',
  '/login.js',
  '/styles.css',
  '/favicon.svg',
  '/favicon.png',
]);

/** @type {ReturnType<typeof setInterval> | null} */
let autoRefreshTimer = null;
/** 正在刷新的成员，避免上报与定时器重复拉同一账号。 */
const refreshingIds = new Set();

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
 * @param {Record<string, string>} [extraHeaders]
 */
function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

/**
 * @param {Awaited<ReturnType<typeof listMembers>>} members
 */
function buildTeamSummary(members) {
  let todayBilled = 0;
  let todayRequests = 0;
  let todayTokens = 0;
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
    // 顶部汇总按「今日」跨账号合计，与列表 Today 行一致
    const today = snap.spend?.today;
    if (today) {
      todayBilled += Number(today.dollars) || 0;
      todayRequests += Number(today.requests) || 0;
      todayTokens += Number(today.tokens) || 0;
    }
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
    todayBilledDollars: Math.round(todayBilled * 100) / 100,
    todayRequests,
    todayTokens,
    membersWithQuota: withQuota,
    nearQuotaCount: nearQuota,
    nearSpendCount: nearSpend,
  };
}

/** @param {string} id */
async function refreshOne(id) {
  if (refreshingIds.has(id)) {
    const current = await getMemberInternal(id);
    return current ? toPublicMember(current) : null;
  }
  refreshingIds.add(id);
  try {
    const member = await getMemberInternal(id);
    if (!member) throw new Error('成员不存在');
    try {
      const snapshot = await fetchMemberSnapshot(member.cookieValue);
      return await saveSyncResult(id, { snapshot });
    } catch (e) {
      return await saveSyncResult(id, { error: e?.message || String(e) });
    }
  } finally {
    refreshingIds.delete(id);
  }
}

/**
 * 是否已超过「距上次同步」的刷新间隔；从未同步的账号视为到期。
 * @param {{ lastSyncedAt?: string | null }} member
 * @param {number} intervalSec
 * @param {number} nowMs
 */
function isMemberDue(member, intervalSec, nowMs = Date.now()) {
  if (!member.lastSyncedAt) return true;
  const t = Date.parse(member.lastSyncedAt);
  if (!Number.isFinite(t)) return true;
  return nowMs - t >= intervalSec * 1000;
}

/**
 * 只刷新到期账号（按 lastSyncedAt 错开），避免整点齐刷。
 * @param {number} [concurrency]
 */
async function refreshDueMembers(concurrency = 2) {
  const sec = getServerAutoRefreshSec();
  if (sec <= 0) return [];
  const now = Date.now();
  const members = await getAllMembersInternal();
  const due = members
    .filter((m) => !refreshingIds.has(m.id) && isMemberDue(m, sec, now))
    .sort((a, b) => {
      const ta = a.lastSyncedAt ? Date.parse(a.lastSyncedAt) : 0;
      const tb = b.lastSyncedAt ? Date.parse(b.lastSyncedAt) : 0;
      return ta - tb;
    });
  if (!due.length) return [];

  const queue = [...due];
  const results = [];
  async function worker() {
    while (queue.length) {
      const m = queue.shift();
      if (!m) break;
      results.push(await refreshOne(m.id));
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()),
  );
  if (results.length) {
    console.log(`自动刷新：到期 ${results.length}/${members.length} 个账号`);
  }
  return results;
}

/** @param {number} [concurrency] */
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
 * 短周期扫描到期账号；AUTO_REFRESH_SEC 表示「每个账号距上次同步」的间隔，而非全员齐刷周期。
 */
function setupServerAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  const sec = getServerAutoRefreshSec();
  if (sec <= 0) {
    console.log('服务端自动刷新：已关闭');
    return;
  }
  // 扫描周期远短于账号间隔，便于按各自 lastSyncedAt 错开触发。
  const tickSec = Math.min(60, Math.max(15, Math.floor(sec / 12) || 15));
  console.log(`服务端自动刷新：每账号间隔 ${sec} 秒（扫描周期 ${tickSec} 秒）`);
  autoRefreshTimer = setInterval(() => {
    refreshDueMembers().catch((e) => console.error('自动刷新失败:', e?.message || e));
  }, tickSec * 1000);
  // 启动后尽快补刷从未同步的账号（例如刚上报 Token 但拉取失败）。
  setTimeout(() => {
    refreshDueMembers().catch((e) => console.error('启动补刷失败:', e?.message || e));
  }, 3000);
}

/** @param {string} urlPath */
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

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {string} pathname
 */
function requiresConsoleAuth(pathname, method) {
  if (pathname === '/api/health') return false;
  if (pathname === '/api/auth/login' && method === 'POST') return false;
  if (pathname === '/api/agent/report') return false;
  if (pathname.startsWith('/api/')) return true;
  if (pathname === '/' || pathname === '/index.html' || pathname === '/detail.html') return true;
  if (pathname === '/app.js' || pathname === '/detail.js' || pathname === '/shared.js') return true;
  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
    const { pathname } = url;
    const method = req.method || 'GET';

    // 未登录访问受保护页：API 401，页面跳转登录。
    if (requiresConsoleAuth(pathname, method)) {
      const session = readSessionFromRequest(req);
      if (!session) {
        if (pathname.startsWith('/api/')) {
          return sendJson(res, 401, { error: '未登录', code: 'UNAUTHORIZED' });
        }
        res.writeHead(302, { Location: '/login.html' });
        res.end();
        return;
      }
      req.consoleUser = session.username;
    }

    if (method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        store: getStoreDriver(),
        agentAuth: isAccessKeyConfigured(),
        autoRefreshSec: getServerAutoRefreshSec(),
      });
    }

    if (method === 'POST' && pathname === '/api/auth/login') {
      const body = await readBody(req);
      const user = authenticateUser(body?.username, body?.password);
      if (!user) {
        const err = new Error('用户名或密码错误');
        err.status = 401;
        throw err;
      }
      const token = issueSessionToken(user.username);
      setSessionCookie(res, token);
      return sendJson(res, 200, {
        ok: true,
        username: user.username,
        mustChangePassword: Boolean(user.mustChangePassword),
      });
    }

    if (method === 'POST' && pathname === '/api/auth/logout') {
      clearSessionCookie(res);
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'GET' && pathname === '/api/auth/me') {
      const session = readSessionFromRequest(req);
      if (!session) return sendJson(res, 401, { error: '未登录', code: 'UNAUTHORIZED' });
      return sendJson(res, 200, {
        username: 'admin',
        mustChangePassword: mustChangePasswordFor(),
      });
    }

    if (method === 'POST' && pathname === '/api/auth/change-password') {
      const session = readSessionFromRequest(req);
      if (!session) {
        const err = new Error('未登录');
        err.status = 401;
        throw err;
      }
      const body = await readBody(req);
      const user = await changeAdminPassword(String(body?.password || ''));
      return sendJson(res, 200, { ok: true, user });
    }

    if (method === 'POST' && pathname === '/api/agent/report') {
      assertAccessKey(req);
      const body = await readBody(req);
      const sessionToken = String(body?.sessionToken || '').trim();
      if (!sessionToken) throw new Error('缺少 sessionToken');
      // upsert：新建写入显示名/主机名；已有账号只轮换 Token，不覆盖人工改名
      const { member, created } = await upsertMemberBySession({
        sessionToken,
        displayName: body?.displayName,
        email: body?.email,
        hostname: body?.hostname,
      });
      const shouldRefresh = body?.refresh !== false;
      let refreshed = member;
      if (shouldRefresh && member?.id) {
        refreshed = await refreshOne(member.id);
      }
      return sendJson(res, created ? 201 : 200, {
        ok: true,
        created,
        member: refreshed,
        hostname: body?.hostname || null,
      });
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
      if (body?.fromLocalCursor) {
        const local = await resolveLocalCursorSession();
        if (!local) throw new Error('本机未找到有效的 Cursor 登录态');
        const displayName =
          String(body.displayName || '').trim() || local.email || local.userId;
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
      const refreshed = await refreshOne(member.id);
      return sendJson(res, 201, { member: refreshed });
    }

    if (method === 'GET' && pathname === '/api/export/accounts') {
      const members = await getAllMembersInternal();
      return sendJson(res, 200, {
        app: 'cursor-team-usage',
        exportedAt: new Date().toISOString(),
        members: members.map((m) => ({
          displayName: m.displayName,
          email: m.email ?? m.lastSnapshot?.email ?? null,
          userId: m.userId,
          sessionToken: m.cookieValue,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt,
        })),
      });
    }

    const memberMatch = pathname.match(
      /^\/api\/members\/([^/]+)(\/refresh|\/usage-events)?$/,
    );
    if (memberMatch) {
      const id = decodeURIComponent(memberMatch[1]);
      const suffix = memberMatch[2] || '';

      if (method === 'GET' && !suffix) {
        const member = await getMemberInternal(id);
        if (!member) throw new Error('成员不存在');
        return sendJson(res, 200, { member: toPublicMember(member) });
      }

      if (method === 'GET' && suffix === '/usage-events') {
        const member = await getMemberInternal(id);
        if (!member) throw new Error('成员不存在');
        const days = Number(url.searchParams.get('days') || 7);
        const page = Number(url.searchParams.get('page') || 1);
        const pageSize = Number(url.searchParams.get('pageSize') || 50);
        const data = await fetchMemberUsageEvents(member.cookieValue, {
          days,
          page,
          pageSize,
        });
        return sendJson(res, 200, data);
      }

      if (method === 'POST' && suffix === '/refresh') {
        const member = await refreshOne(id);
        return sendJson(res, 200, { member });
      }
      if (method === 'PUT' && !suffix) {
        const body = await readBody(req);
        const member = await updateMember(id, body);
        return sendJson(res, 200, { member });
      }
      if (method === 'DELETE' && !suffix) {
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
      if (pathname === '/' || pathname === '/index.html') {
        if (!readSessionFromRequest(req)) {
          res.writeHead(302, { Location: '/login.html' });
          res.end();
          return;
        }
      }
      const rel = pathname === '/' ? '/index.html' : pathname;
      if (!PUBLIC_STATIC.has(rel) && requiresConsoleAuth(rel, method) && !readSessionFromRequest(req)) {
        res.writeHead(302, { Location: '/login.html' });
        res.end();
        return;
      }
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
    const status = e?.status || (/不存在/.test(e?.message || '') ? 404 : 400);
    sendJson(res, status, { error: e?.message || String(e) });
  }
});

await loadAppConfig();
// 控制台账号落在存储驱动内，须先开库再建默认 admin。
await initStore();
await initUsers();
setupServerAutoRefresh();

server.listen(PORT, HOST, () => {
  console.log(`cursor-team-usage → http://${HOST}:${PORT}`);
  console.log(`存储：${getStoreDriver()}`);
  console.log(
    `插件上报鉴权：${isAccessKeyConfigured() ? '已启用 Access Key' : '未配置（/api/agent/report 不可用）'}`,
  );
    console.log('控制台登录：默认 admin / admin（首次登录须改密）');
});
