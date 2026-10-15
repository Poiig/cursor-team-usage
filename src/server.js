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
  getLogRetentionDays,
  getServerAutoRefreshSec,
  getStoreDriver,
  loadAppConfig,
} from './config.js';
import { assertAccessKey, isAccessKeyConfigured } from './access-key.js';
import { fetchMemberSnapshot } from './cursor-api.js';
import {
  ensureMemberUsageEventsSynced,
  loadPreviousCycle,
  persistSnapshotUsageEvents,
} from './usage-events-sync.js';
import { probeLocalCursorSession, resolveLocalCursorSession } from './local-session.js';
import {
  initAppLog,
  memberLogLabel,
  pruneOldAppLogs,
  pruneOldLogFiles,
  writeAppLog,
} from './app-log.js';
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
  listUsageEvents,
  pruneOperationalData,
  saveSyncResult,
  setUsagePercentHistory,
  toPublicMember,
  updateMember,
  upsertMemberBySession,
} from './store.js';
import {
  archiveYesterdayPercents,
  msUntilNextLocalMidnight,
} from './usage-percent-history.js';
import {
  claimAccountSwitch,
  createAccountSwitch,
  finishAccountSwitch,
  getSwitchReport,
  listAccountSwitchLogs,
  recommendSwitchMember,
} from './account-switch.js';
import {
  applyPresenceDisplayNames,
  enrichMembersWithPresence,
  hydratePresenceFromAppLog,
  listPresenceByUsername,
  pruneStalePresence,
  recordAccountPresence,
  reconcilePresenceFromActivity,
  removeMemberPresence,
  clearPresenceForMember,
} from './account-presence.js';
import { listLoginEvents, recordLoginEvent } from './login-log.js';
import { createApplication, lookupApplication, markApplication } from './applications.js';
import { verifyOperatorUsername } from './operator-proof.js';
import {
  forgetPluginClient,
  listPluginClientViews,
  recordPluginHeartbeat,
  recordPluginInstall,
  recordPluginReport,
} from './plugin-clients.js';
import { listReportEvents, recordReportEvent } from './report-log.js';
import { runExpiringNotify, setupExpiringNotifySchedule } from './notify.js';
import { getPersonDetail } from './people.js';
import {
  approveUser,
  authenticateUser,
  changeOwnPassword,
  createUser,
  getPublicUser,
  initUsers,
  isAdminUsername,
  listPublicUsers,
  mustChangePasswordFor,
  registerUser,
  rejectUser,
  removeUser,
  resetUserPassword,
  updateUser,
} from './users.js';
import {
  buildPatchedVsix,
  bufferEtag,
  consumeInstallToken,
  getExtensionBuildMeta,
  getConfiguredPublicBaseUrl,
  issueInstallToken,
  renderInstallPs1,
} from './extension-asset.js';
import { startEmailLogin, verifyEmailLogin } from './cursor-email-login.js';

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
  '/register.html',
  '/register.js',
  '/application-status.js',
  '/styles.css',
  '/favicon.svg',
  '/favicon.png',
]);

/** @type {ReturnType<typeof setInterval> | null} */
let autoRefreshTimer = null;
/** @type {ReturnType<typeof setInterval> | null} */
let logPruneTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let usagePercentArchiveTimer = null;
/** @type {ReturnType<typeof setInterval> | null} */
let usagePercentArchiveInterval = null;
/** 正在刷新的成员，避免上报与定时器重复拉同一账号。 */
const refreshingIds = new Set();

/**
 * @param {import('node:http').IncomingMessage} req
 */
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) {
      const err = new Error('请求体过大');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  return JSON.parse(text);
}

/** 登录 / 注册按 TCP 对端限流，不信 X-Forwarded-For，避免改头绕过。 */
const attemptBuckets = new Map();

/**
 * @param {string} key
 * @param {number} limit
 * @param {number} windowMs
 */
function allowAttempt(key, limit, windowMs) {
  const now = Date.now();
  const fresh = (attemptBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (fresh.length >= limit) {
    attemptBuckets.set(key, fresh);
    return false;
  }
  fresh.push(now);
  attemptBuckets.set(key, fresh);
  return true;
}

/** @param {import('node:http').IncomingMessage} req */
function peerIp(req) {
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * 只有安装包里的签名对得上、且账号仍可登录，才把上报算到这个人身上。
 * @param {string} username
 * @param {string} proof
 */
async function checkOperator(username, proof) {
  const name = String(username || '').trim();
  if (!name) return { username: null, reason: '未带使用人' };
  if (!String(proof || '').trim()) return { username: null, reason: '缺少签名' };
  if (!verifyOperatorUsername(name, proof)) return { username: null, reason: '签名不符' };
  const user = await getPublicUser(name);
  if (!user) return { username: null, reason: '用户不存在' };
  if (user.pending) return { username: null, reason: '用户待审批' };
  if (user.disabled) return { username: null, reason: '用户已禁用' };
  return { username: user.username, reason: '' };
}

/**
 * @param {string} username
 * @param {string} proof
 */
async function trustedOperatorName(username, proof) {
  return (await checkOperator(username, proof)).username;
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
    // 有错误即算异常（含仍保留旧快照），与列表「异常」徽章一致
    if (m.lastError) errored++;
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

/** @param {string} id @param {{ source?: string, trigger?: string }} [ctx] */
async function refreshOne(id, ctx = {}) {
  if (refreshingIds.has(id)) {
    const current = await getMemberInternal(id);
    return current ? toPublicMember(current) : null;
  }
  refreshingIds.add(id);
  const source = ctx.source || '未知';
  const trigger = ctx.trigger || '';
  try {
    const member = await getMemberInternal(id);
    if (!member) throw new Error('成员不存在');
    const label = memberLogLabel(member);
    try {
      const snapshot = await fetchMemberSnapshot(member.cookieValue);
      // 先落事件再存快照，避免 _usageEvents 进 last_snapshot。
      try {
        await persistSnapshotUsageEvents(id, snapshot);
      } catch (eventsErr) {
        console.warn('[usage-events] 刷新落库失败', id, eventsErr?.message || eventsErr);
      }
      const result = await saveSyncResult(id, { snapshot });
      await writeAppLog('刷新', {
        账号: label,
        来源: source,
        触发: trigger || undefined,
        结果: '成功',
        同步时间: result?.lastSyncedAt || snapshot?.syncedAt,
        可选接口警告:
          Array.isArray(snapshot?.warnings) && snapshot.warnings.length
            ? snapshot.warnings.join(' | ')
            : undefined,
      });
      return result;
    } catch (e) {
      const msg = e?.message || String(e);
      const result = await saveSyncResult(id, { error: msg });
      await writeAppLog('刷新', {
        账号: label,
        来源: source,
        触发: trigger || undefined,
        结果: '失败',
        错误: msg,
      });
      return result;
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
 * @param {{ trigger?: string }} [ctx]
 */
async function refreshDueMembers(concurrency = 2, ctx = {}) {
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

  await writeAppLog('自动刷新', {
    触发: ctx.trigger || '定时扫描',
    到期账号数: due.length,
    总账号数: members.length,
    账号列表: due.map((m) => memberLogLabel(m)).join('; '),
  });

  const queue = [...due];
  const results = [];
  async function worker() {
    while (queue.length) {
      const m = queue.shift();
      if (!m) break;
      results.push(
        await refreshOne(m.id, { source: '自动刷新', trigger: ctx.trigger || '到期' }),
      );
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()),
  );

  const ok = results.filter((r) => r && !r.lastError).length;
  const fail = results.length - ok;
  await writeAppLog('自动刷新', {
    触发: ctx.trigger || '定时扫描',
    完成: true,
    成功: ok,
    失败: fail,
  });
  return results;
}

/** @param {number} [concurrency] @param {{ source?: string, trigger?: string }} [ctx] */
async function refreshAll(concurrency = 3, ctx = {}) {
  const members = (await getAllMembersInternal()).sort((a, b) => {
    const aTime = Date.parse(a.lastSyncedAt || '') || 0;
    const bTime = Date.parse(b.lastSyncedAt || '') || 0;
    return aTime - bTime;
  });
  await writeAppLog('全量刷新', {
    来源: ctx.source || '控制台',
    触发: ctx.trigger || '手动',
    账号数: members.length,
    账号列表: members.map((m) => memberLogLabel(m)).join('; '),
  });
  const queue = [...members];
  const results = [];

  async function worker() {
    while (queue.length) {
      const m = queue.shift();
      if (!m) break;
      results.push(
        await refreshOne(m.id, {
          source: ctx.source || '全量刷新',
          trigger: ctx.trigger || '手动',
        }),
      );
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, members.length)) }, () =>
      worker(),
    ),
  );

  const ok = results.filter((r) => r && !r.lastError).length;
  await writeAppLog('全量刷新', {
    完成: true,
    成功: ok,
    失败: results.length - ok,
  });
  return results;
}

/**
 * 每日清理过期日志文件。
 */
function setupLogPruneSchedule() {
  if (logPruneTimer) {
    clearInterval(logPruneTimer);
    logPruneTimer = null;
  }
  const days = getLogRetentionDays();
  if (days <= 0) return;
  logPruneTimer = setInterval(
    () => {
      Promise.all([pruneOldAppLogs(days), pruneOldLogFiles(days)])
        .then(([, n]) => {
          if (n > 0) {
            writeAppLog('日志清理', { 删除文件数: n, 保留天数: days }).catch(() => {});
          }
        })
        .catch((e) => console.error('日志清理失败:', e?.message || e));
    },
    24 * 3600 * 1000,
  );
}

/**
 * 用各账号最新快照把「昨天」的周期累计%盖进历史，供今日对比与日用量图。
 */
async function archiveAllYesterdayUsagePercents() {
  const members = await getAllMembersInternal();
  let n = 0;
  for (const m of members) {
    if (!m.lastSnapshot) continue;
    const next = archiveYesterdayPercents(m.usagePercentHistory, m.lastSnapshot);
    await setUsagePercentHistory(m.id, next);
    n += 1;
  }
  if (n > 0) {
    await writeAppLog('额度日归档', { 账号数: n });
  }
  return n;
}

/**
 * 对齐本地零点执行额度%归档；之后每 24h 再跑。
 */
function setupUsagePercentArchiveSchedule() {
  if (usagePercentArchiveTimer) {
    clearTimeout(usagePercentArchiveTimer);
    usagePercentArchiveTimer = null;
  }
  if (usagePercentArchiveInterval) {
    clearInterval(usagePercentArchiveInterval);
    usagePercentArchiveInterval = null;
  }
  const delay = msUntilNextLocalMidnight();
  console.log(`额度日归档：${Math.round(delay / 60000)} 分钟后对齐本地零点`);
  usagePercentArchiveTimer = setTimeout(() => {
    archiveAllYesterdayUsagePercents().catch((e) =>
      console.error('额度日归档失败:', e?.message || e),
    );
    usagePercentArchiveInterval = setInterval(
      () => {
        archiveAllYesterdayUsagePercents().catch((e) =>
          console.error('额度日归档失败:', e?.message || e),
        );
      },
      24 * 3600 * 1000,
    );
  }, delay);
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
    refreshDueMembers(2, { trigger: '定时扫描' }).catch((e) =>
      writeAppLog('自动刷新', { 结果: '异常', 错误: e?.message || String(e) }),
    );
  }, tickSec * 1000);
  setTimeout(() => {
    refreshDueMembers(2, { trigger: '启动补刷' }).catch((e) =>
      writeAppLog('自动刷新', { 结果: '启动补刷异常', 错误: e?.message || String(e) }),
    );
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
  if (pathname === '/api/auth/register' && method === 'POST') return false;
  if (pathname === '/api/auth/application-status' && method === 'POST') return false;
  // 扩展侧用 Access Key，不走控制台 Cookie
  if (pathname.startsWith('/api/agent/')) return false;
  // 插件元数据 / 凭安装令牌下载：供一键安装脚本与更新检查
  if (pathname === '/api/extension/meta' && method === 'GET') return false;
  if (pathname === '/api/extension/reporter.vsix' && method === 'GET') return false;
  if (pathname === '/api/extension/install.ps1' && method === 'GET') return false;
  if (pathname.startsWith('/api/')) return true;
  if (
    pathname === '/' ||
    pathname === '/index.html' ||
    pathname === '/detail.html' ||
    pathname === '/user.html'
  ) {
    return true;
  }
  if (
    pathname === '/app.js' ||
    pathname === '/detail.js' ||
    pathname === '/user.js' ||
    pathname === '/shared.js'
  ) {
    return true;
  }
  return false;
}

/**
 * 仅管理员可写名册 / 管用户；普通用户只读用量并允许切换。
 * @param {string} pathname
 * @param {string} method
 */
function requiresAdmin(pathname, method) {
  if (pathname === '/api/members' && method === 'POST') return true;
  if (pathname.startsWith('/api/members/email-login')) return true;
  if (pathname === '/api/export/accounts') return true;
  if (pathname.startsWith('/api/users')) return true;
  if (pathname.startsWith('/api/reports')) return true;
  if (pathname === '/api/login-logs') return true;
  if (pathname === '/api/report-logs') return true;
  const memberWrite = pathname.match(/^\/api\/members\/[^/]+$/);
  if (memberWrite && (method === 'PUT' || method === 'DELETE')) return true;
  // 管理员手动移除账号使用人席位
  if (pathname.match(/^\/api\/members\/[^/]+\/presence$/) && method === 'DELETE') return true;
  return false;
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {Buffer} buf
 * @param {string} fileName
 * @param {string} contentType
 */
function sendDownload(res, buf, fileName, contentType) {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'Cache-Control': 'no-store',
    ETag: bufferEtag(buf),
  });
  res.end(buf);
}

/**
 * 取点击切换时的客户端 IP（优先反代头，再退回 socket）。
 * @param {import('node:http').IncomingMessage} req
 */
function clientIpOf(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0].trim();
  if (Array.isArray(xf) && xf[0]) return String(xf[0]).split(',')[0].trim();
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  return req.socket?.remoteAddress || null;
}

/**
 * @param {import('node:http').IncomingMessage} req
 */
async function assertAdmin(req) {
  const ok = await isAdminUsername(req.consoleUser);
  if (!ok) {
    const err = new Error('需要管理员权限');
    err.status = 403;
    throw err;
  }
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
      const me = await getPublicUser(session.username);
      if (!me || me.disabled || me.pending) {
        if (pathname.startsWith('/api/')) {
          return sendJson(res, 401, { error: '未登录', code: 'UNAUTHORIZED' });
        }
        res.writeHead(302, { Location: '/login.html' });
        res.end();
        return;
      }
      req.consoleUser = me.username;
      if (requiresAdmin(pathname, method)) {
        await assertAdmin(req);
      }
    }

    if (method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        store: getStoreDriver(),
        agentAuth: isAccessKeyConfigured(),
        autoRefreshSec: getServerAutoRefreshSec(),
      });
    }

    if (method === 'GET' && pathname === '/api/extension/meta') {
      const meta = await getExtensionBuildMeta();
      const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || '')
        .trim()
        .replace(/\/+$/, '');
      return sendJson(res, 200, {
        ok: true,
        ...meta,
        accessKeyConfigured: isAccessKeyConfigured(),
        publicBaseUrl,
      });
    }

    if (method === 'POST' && pathname === '/api/extension/install-link') {
      const apiBaseUrl = getConfiguredPublicBaseUrl();
      const meta = await getExtensionBuildMeta();
      if (!meta.available) {
        const err = new Error('当前镜像未附带插件资产，请用含扩展构建的镜像重新部署');
        err.status = 503;
        throw err;
      }
      if (!isAccessKeyConfigured()) {
        const err = new Error('未配置 ACCESS_KEY，无法生成与看板一致的插件');
        err.status = 503;
        throw err;
      }
      const operatorUsername = String(req.consoleUser || '').trim();
      const token = issueInstallToken(apiBaseUrl, operatorUsername);
      const vsixPath = `/api/extension/reporter.vsix?token=${encodeURIComponent(token)}`;
      const ps1Path = `/api/extension/install.ps1?token=${encodeURIComponent(token)}`;
      await writeAppLog('签发插件安装链', {
        操作者: req.consoleUser,
        看板地址: apiBaseUrl,
        构建号: meta.build,
      });
      return sendJson(res, 200, {
        ok: true,
        apiBaseUrl,
        version: meta.version,
        build: meta.build,
        operatorUsername,
        token,
        vsixUrl: `${apiBaseUrl}${vsixPath}`,
        installPs1Url: `${apiBaseUrl}${ps1Path}`,
        // Windows 一行安装（下载脚本并执行）
        oneLiner: `irm '${apiBaseUrl}${ps1Path}' | iex`,
      });
    }

    if (method === 'GET' && pathname === '/api/extension/reporter.vsix') {
      const token = String(url.searchParams.get('token') || '');
      const row = consumeInstallToken(token);
      if (!row) {
        // 已登录管理员也可直接拉（面板调试）
        const session = readSessionFromRequest(req);
        if (!session || !(await isAdminUsername(session.username))) {
          return sendJson(res, 401, { error: '安装令牌无效或已过期', code: 'INSTALL_TOKEN' });
        }
        const apiBaseUrl = getConfiguredPublicBaseUrl();
        const packed = await buildPatchedVsix({
          apiBaseUrl,
          operatorUsername: session.username,
        });
        await recordPluginInstall(session.username, packed);
        return sendDownload(
          res,
          packed.buffer,
          packed.fileName,
          'application/octet-stream',
        );
      }
      const packed = await buildPatchedVsix({
        apiBaseUrl: row.apiBaseUrl,
        operatorUsername: row.operatorUsername,
      });
      await recordPluginInstall(row.operatorUsername, packed);
      return sendDownload(res, packed.buffer, packed.fileName, 'application/octet-stream');
    }

    if (method === 'GET' && pathname === '/api/extension/install.ps1') {
      const token = String(url.searchParams.get('token') || '');
      const row = consumeInstallToken(token);
      if (!row) {
        return sendJson(res, 401, { error: '安装令牌无效或已过期', code: 'INSTALL_TOKEN' });
      }
      const meta = await getExtensionBuildMeta();
      const downloadUrl = `${row.apiBaseUrl}/api/extension/reporter.vsix?token=${encodeURIComponent(token)}`;
      const ps1 = renderInstallPs1({
        downloadUrl,
        version: meta.version,
        build: meta.build,
      });
      const buf = Buffer.from(ps1, 'utf8');
      return sendDownload(res, buf, 'install-cursor-team-usage-reporter.ps1', 'text/plain; charset=utf-8');
    }

    if (method === 'POST' && pathname === '/api/auth/login') {
      if (!allowAttempt(`login:${peerIp(req)}`, 30, 10 * 60 * 1000)) {
        const err = new Error('尝试过于频繁，请稍后再试');
        err.status = 429;
        throw err;
      }
      const body = await readBody(req);
      const user = await authenticateUser(body?.username, body?.password);
      if (!user) {
        await recordLoginEvent({
          username: body?.username,
          ok: false,
          ip: clientIpOf(req),
          userAgent: req.headers['user-agent'],
        });
        const err = new Error('用户名或密码错误');
        err.status = 401;
        throw err;
      }
      const token = issueSessionToken(user.username);
      setSessionCookie(res, token);
      await writeAppLog('登录', {
        用户: user.username,
        角色: user.role,
        IP: clientIpOf(req) || undefined,
      });
      await recordLoginEvent({
        username: user.username,
        ok: true,
        role: user.role,
        ip: clientIpOf(req),
        userAgent: req.headers['user-agent'],
      });
      return sendJson(res, 200, {
        ok: true,
        username: user.username,
        role: user.role,
        mustChangePassword: Boolean(user.mustChangePassword),
      });
    }

    if (method === 'POST' && pathname === '/api/auth/register') {
      if (!allowAttempt(`register:${peerIp(req)}`, 10, 10 * 60 * 1000)) {
        const err = new Error('申请过于频繁，请稍后再试');
        err.status = 429;
        throw err;
      }
      const body = await readBody(req);
      const user = await registerUser({
        username: body?.username,
        password: body?.password,
      });
      const application = await createApplication(user.username);
      await writeAppLog('注册申请', {
        用户: user.username,
        IP: clientIpOf(req) || undefined,
      });
      return sendJson(res, 201, {
        ok: true,
        user,
        token: application.token,
        message: '已提交注册申请，请等待管理员审批后再登录',
      });
    }

    if (method === 'POST' && pathname === '/api/auth/application-status') {
      const body = await readBody(req);
      const view = await lookupApplication(body?.token);
      if (!view) return sendJson(res, 404, { error: '未找到申请', status: 'unknown' });
      return sendJson(res, 200, view);
    }

    if (method === 'POST' && pathname === '/api/auth/logout') {
      clearSessionCookie(res);
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'GET' && pathname === '/api/auth/me') {
      const session = readSessionFromRequest(req);
      if (!session) return sendJson(res, 401, { error: '未登录', code: 'UNAUTHORIZED' });
      const me = await getPublicUser(session.username);
      if (!me || me.disabled || me.pending) {
        return sendJson(res, 401, { error: '未登录', code: 'UNAUTHORIZED' });
      }
      return sendJson(res, 200, {
        username: me.username,
        role: me.role,
        mustChangePassword: await mustChangePasswordFor(me.username),
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
      const user = await changeOwnPassword(session.username, String(body?.password || ''));
      await writeAppLog('改密', { 用户: session.username });
      return sendJson(res, 200, { ok: true, user });
    }

    if (method === 'GET' && pathname === '/api/users') {
      await assertAdmin(req);
      const users = await listPublicUsers();
      const presence = await listPresenceByUsername();
      const plugins = await listPluginClientViews();
      // 席位里的账号名是上报时快照，展示用号池里的最新别名与邮箱
      const memberById = new Map((await listMembers()).map((m) => [m.id, m]));
      return sendJson(
        res,
        200,
        {
          users: users.map((user) => ({
            ...user,
            activeAccounts: (presence[user.username] || []).map((row) => {
              const member = memberById.get(row.memberId);
              return {
                ...row,
                memberDisplayName: member?.displayName || row.memberDisplayName,
                memberEmail: member?.email || null,
              };
            }),
            plugin: plugins[user.username] || null,
          })),
        },
      );
    }

    // 人员详情：全员可读（勿挂在 /api/users 下，避免被管理员写接口规则挡住）
    const peopleMatch = pathname.match(/^\/api\/people\/([^/]+)$/);
    if (method === 'GET' && peopleMatch) {
      const personUsername = decodeURIComponent(peopleMatch[1]);
      const detail = await getPersonDetail(personUsername);
      // 上报记录仅管理员可见；切换记录全员可见
      if (!(await isAdminUsername(req.consoleUser))) detail.reports = null;
      return sendJson(res, 200, detail);
    }

    if (method === 'GET' && pathname === '/api/login-logs') {
      await assertAdmin(req);
      const limit = Number(url.searchParams.get('limit') || 200);
      return sendJson(res, 200, { logs: await listLoginEvents(limit) });
    }

    if (method === 'GET' && pathname === '/api/report-logs') {
      await assertAdmin(req);
      const limit = Number(url.searchParams.get('limit') || 200);
      return sendJson(res, 200, { logs: await listReportEvents(limit) });
    }

    // 管理员手动测企微推送（无候选也会发一条说明）
    if (method === 'POST' && pathname === '/api/notify/test') {
      await assertAdmin(req);
      const result = await runExpiringNotify({ force: true });
      await writeAppLog('企微推送测试', {
        操作者: req.consoleUser,
        账号数: result.count,
        跳过: result.skipped || undefined,
      });
      return sendJson(res, 200, result);
    }

    if (method === 'POST' && pathname === '/api/users') {
      await assertAdmin(req);
      const body = await readBody(req);
      const user = await createUser({
        username: body?.username,
        password: body?.password,
        role: body?.role,
      });
      await writeAppLog('创建用户', {
        操作者: req.consoleUser,
        用户: user.username,
        角色: user.role,
      });
      return sendJson(res, 201, { user });
    }

    const userMatch = pathname.match(
      /^\/api\/users\/([^/]+)(\/reset-password|\/approve|\/reject)?$/,
    );
    if (userMatch) {
      await assertAdmin(req);
      const username = decodeURIComponent(userMatch[1]);
      const suffix = userMatch[2] || '';
      if (method === 'POST' && suffix === '/reset-password') {
        const body = await readBody(req);
        const user = await resetUserPassword(username, String(body?.password || ''));
        await writeAppLog('重置密码', { 操作者: req.consoleUser, 用户: user.username });
        return sendJson(res, 200, { user });
      }
      if (method === 'POST' && suffix === '/approve') {
        const user = await approveUser(username);
        await markApplication(user.username, 'approved');
        await writeAppLog('同意注册', { 操作者: req.consoleUser, 用户: user.username });
        return sendJson(res, 200, { user });
      }
      if (method === 'POST' && suffix === '/reject') {
        await markApplication(username, 'rejected');
        await forgetPluginClient(username);
        await rejectUser(username);
        await writeAppLog('拒绝注册', { 操作者: req.consoleUser, 用户: username });
        return sendJson(res, 200, { ok: true });
      }
      if (method === 'PUT' && !suffix) {
        const body = await readBody(req);
        const patch = {};
        if (body?.role != null) patch.role = body.role;
        if (body?.disabled != null) patch.disabled = body.disabled;
        if (body?.alias != null) patch.alias = body.alias;
        const user = await updateUser(username, patch);
        await writeAppLog('更新用户', {
          操作者: req.consoleUser,
          用户: user.username,
          角色: user.role,
          禁用: user.disabled,
        });
        return sendJson(res, 200, { user });
      }
      if (method === 'DELETE' && !suffix) {
        await markApplication(username, 'removed');
        await forgetPluginClient(username);
        await removeUser(username);
        await writeAppLog('删除用户', { 操作者: req.consoleUser, 用户: username });
        return sendJson(res, 200, { ok: true });
      }
    }

    if (method === 'GET' && pathname === '/api/switch-logs') {
      const limit = Number(url.searchParams.get('limit') || 100);
      const logs = await listAccountSwitchLogs({ limit });
      const aliasByUser = new Map(
        (await listPublicUsers()).map((u) => [
          String(u.username || '').toLowerCase(),
          String(u.alias || '').trim(),
        ]),
      );
      return sendJson(res, 200, {
        logs: logs.map((log) => {
          const username = String(log.operatorUsername || '').trim();
          const alias = aliasByUser.get(username.toLowerCase()) || '';
          return {
            ...log,
            operatorAlias: alias || null,
            operatorLabel: alias ? `${username}（${alias}）` : username || '—',
          };
        }),
      });
    }

    if (method === 'GET' && pathname === '/api/reports/switches') {
      await assertAdmin(req);
      const limit = Number(url.searchParams.get('limit') || 500);
      const report = await getSwitchReport({ limit });
      const aliasByUser = new Map(
        (await listPublicUsers()).map((u) => [
          String(u.username || '').toLowerCase(),
          String(u.alias || '').trim(),
        ]),
      );
      const withAlias = (username) => {
        const name = String(username || '').trim() || '—';
        const alias = aliasByUser.get(name.toLowerCase()) || '';
        return alias ? `${name}（${alias}）` : name;
      };
      return sendJson(res, 200, {
        ...report,
        operators: (report.operators || []).map((row) => ({
          ...row,
          operatorLabel: withAlias(row.username),
        })),
        recent: (report.recent || []).map((log) => {
          const username = String(log.operatorUsername || '').trim();
          const alias = aliasByUser.get(username.toLowerCase()) || '';
          return {
            ...log,
            operatorAlias: alias || null,
            operatorLabel: alias ? `${username}（${alias}）` : username || '—',
          };
        }),
      });
    }

    // 轻量在线心跳：IDE 开着即可，不读会话、不写上报日志
    if (method === 'POST' && pathname === '/api/agent/heartbeat') {
      assertAccessKey(req);
      const body = await readBody(req);
      const { username: operatorUsername, reason } = await checkOperator(
        body?.operatorUsername,
        body?.operatorProof,
      );
      if (!operatorUsername) {
        return sendJson(res, 401, {
          error: `插件使用人校验失败（${reason}），请在看板重新安装插件`,
          code: 'OPERATOR_PROOF',
        });
      }
      const view = await recordPluginHeartbeat(operatorUsername, {
        version: body?.pluginVersion,
        build: body?.pluginBuild,
        hostname: body?.hostname,
      });
      if (!view) {
        return sendJson(res, 404, { error: '尚未安装个性化插件', code: 'PLUGIN_NOT_INSTALLED' });
      }
      return sendJson(res, 200, { ok: true, online: true, heartbeatAt: view.heartbeatAt });
    }

    if (method === 'POST' && pathname === '/api/agent/report') {
      assertAccessKey(req);
      const body = await readBody(req);
      const sessionToken = String(body?.sessionToken || '').trim();
      if (!sessionToken) throw new Error('缺少 sessionToken');
      const { username: operatorUsername, reason: operatorReason } = await checkOperator(
        body?.operatorUsername,
        body?.operatorProof,
      );
      // upsert：新建=上报来源；已有账号续 Token，不覆盖人工显示名/主机名
      const { member, created, manualProtected } = await upsertMemberBySession({
        sessionToken,
        displayName: body?.displayName,
        email: body?.email,
        hostname: body?.hostname,
      });
      await recordAccountPresence({
        memberId: member.id,
        memberDisplayName: member.displayName,
        hostname: body?.hostname,
        username: operatorUsername,
        label: operatorUsername || body?.displayName || body?.hostname,
      });
      if (operatorUsername) {
        await recordPluginReport(operatorUsername, {
          version: body?.pluginVersion,
          build: body?.pluginBuild,
          hostname: body?.hostname,
        });
      }
      await writeAppLog(created ? '注册' : '上报', {
        账号: memberLogLabel(member),
        操作: created ? '新建账号' : manualProtected ? '续期Token(人工号)' : '更新Token',
        来源: member.source || undefined,
        使用人: operatorUsername || undefined,
        使用人校验: operatorUsername ? undefined : `失败(${operatorReason})`,
        声明使用人: !operatorUsername && body?.operatorUsername ? body.operatorUsername : undefined,
        主机名: body?.hostname || member?.hostname || undefined,
        邮箱: body?.email || member?.email || undefined,
        显示名请求: body?.displayName || undefined,
        插件版本: body?.pluginVersion || undefined,
        插件构建: body?.pluginBuild || undefined,
      });
      const shouldRefresh = body?.refresh !== false;
      let refreshed = member;
      if (shouldRefresh && member?.id) {
        refreshed = await refreshOne(member.id, {
          source: created ? '注册' : '上报',
          trigger: '上报后刷新',
        });
      }
      await recordReportEvent({
        operatorUsername,
        memberId: member.id,
        memberDisplayName: member.displayName,
        memberEmail: body?.email || member.email || null,
        hostname: String(body?.hostname || '').trim() || null,
        hostRemark: String(body?.displayName || '').trim() || null,
        pluginVersion: String(body?.pluginVersion || '').trim() || null,
        pluginBuild: String(body?.pluginBuild || '').trim() || null,
        ok: !refreshed?.lastError,
        error: refreshed?.lastError || null,
      });
      // 上报路径顺带清过期席位与超额审计，控制表体积
      await pruneStalePresence().catch(() => {});
      await pruneOperationalData({ appLogRetentionDays: getLogRetentionDays() }).catch(() => {});
      return sendJson(res, created ? 201 : 200, {
        ok: true,
        created,
        member: refreshed,
        hostname: body?.hostname || null,
        operatorVerified: Boolean(operatorUsername),
        operatorError: operatorUsername ? null : operatorReason,
      });
    }

    if (method === 'POST' && pathname === '/api/agent/switch/claim') {
      assertAccessKey(req);
      const body = await readBody(req);
      const claimed = await claimAccountSwitch({
        ticketId: body?.ticketId,
        hostname: body?.hostname,
      });
      await writeAppLog('切换领取', {
        操作者: claimed.operatorUsername,
        账号: claimed.displayName,
        主机名: body?.hostname || undefined,
        票据: claimed.ticketId,
      });
      return sendJson(res, 200, { ok: true, ...claimed });
    }

    if (method === 'GET' && pathname === '/api/agent/extension/vsix') {
      assertAccessKey(req);
      const apiBaseUrl = getConfiguredPublicBaseUrl();
      const operatorUsername = await trustedOperatorName(
        req.headers['x-console-user'],
        req.headers['x-operator-proof'],
      );
      if (!operatorUsername) {
        return sendJson(res, 401, { error: '插件使用人签名无效', code: 'OPERATOR_PROOF' });
      }
      const packed = await buildPatchedVsix({
        apiBaseUrl,
        operatorUsername,
      });
      await recordPluginInstall(operatorUsername, packed);
      return sendDownload(res, packed.buffer, packed.fileName, 'application/octet-stream');
    }

    if (method === 'POST' && pathname === '/api/agent/switch/result') {
      assertAccessKey(req);
      const body = await readBody(req);
      const log = await finishAccountSwitch({
        logId: body?.logId,
        ok: body?.ok !== false,
        error: body?.error,
        hostname: body?.hostname,
      });
      if (log.status === 'success') {
        await recordAccountPresence({
          memberId: log.memberId,
          memberDisplayName: log.memberDisplayName,
          hostname: log.hostname,
          username: log.operatorUsername,
          label: log.operatorUsername || log.hostname,
        });
      }
      await writeAppLog('切换结果', {
        操作者: log.operatorUsername,
        账号: log.memberDisplayName || log.memberEmail || log.memberId,
        主机名: log.hostname || undefined,
        结果: log.status,
        错误: log.error || undefined,
      });
      await pruneStalePresence().catch(() => {});
      await pruneOperationalData({ appLogRetentionDays: getLogRetentionDays() }).catch(() => {});
      return sendJson(res, 200, { ok: true, log });
    }

    if (method === 'GET' && pathname === '/api/members') {
      const named = applyPresenceDisplayNames(
        await enrichMembersWithPresence(await listMembers()),
        new Map(
          (await listPublicUsers())
            .filter((user) => user.alias)
            .map((user) => [user.username.toLowerCase(), user.alias]),
        ),
      );
      const members = named;
      const recommended = recommendSwitchMember(members);
      return sendJson(res, 200, {
        members,
        summary: buildTeamSummary(members),
        recommendedSwitchId: recommended?.id || null,
      });
    }

    if (method === 'GET' && pathname === '/api/local-session') {
      return sendJson(res, 200, await probeLocalCursorSession());
    }

    if (method === 'POST' && pathname === '/api/members/email-login/start') {
      if (!allowAttempt(`email-login:${peerIp(req)}`, 8, 10 * 60 * 1000)) {
        return sendJson(res, 429, { error: '发送验证码过于频繁，请稍后再试' });
      }
      const body = await readBody(req);
      const email = String(body?.email || '').trim().toLowerCase();
      if (email && !allowAttempt(`email-login-mail:${email}`, 4, 10 * 60 * 1000)) {
        return sendJson(res, 429, { error: '该邮箱发送过于频繁，请稍后再试' });
      }
      const started = await startEmailLogin({
        email,
        displayName: body?.displayName,
      });
      await writeAppLog('邮箱验证码', {
        步骤: '发送',
        邮箱: started.email,
        // 不记录 loginId / 验证码，避免审计日志泄露登录过程凭证
      });
      return sendJson(res, 200, started);
    }

    if (method === 'POST' && pathname === '/api/members/email-login/verify') {
      if (!allowAttempt(`email-login-verify:${peerIp(req)}`, 20, 10 * 60 * 1000)) {
        return sendJson(res, 429, { error: '验证过于频繁，请稍后再试' });
      }
      const body = await readBody(req);
      const verified = await verifyEmailLogin({
        loginId: body?.loginId,
        code: body?.code,
      });
      const displayName =
        String(body?.displayName || '').trim() || verified.displayName || verified.email;
      const memberId = String(body?.memberId || '').trim();
      let member;
      let source;
      if (memberId) {
        member = await updateMember(memberId, {
          displayName,
          sessionToken: verified.cookieValue,
        });
        source = '邮箱验证码更新';
      } else {
        member = await addMember({
          displayName,
          sessionToken: verified.cookieValue,
        });
        source = '邮箱验证码';
      }
      await writeAppLog('添加账号', {
        账号: memberLogLabel(member),
        来源: source,
        邮箱: verified.email,
      });
      const refreshed = await refreshOne(member.id, {
        source: '添加账号',
        trigger: source,
      });
      return sendJson(res, memberId ? 200 : 201, { member: refreshed });
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
        await writeAppLog('添加账号', {
          账号: memberLogLabel(member),
          来源: '本机导入',
        });
        const refreshed = await refreshOne(member.id, {
          source: '添加账号',
          trigger: '本机导入',
        });
        return sendJson(res, 201, {
          member: refreshed,
          local: {
            email: local.email,
            expiresAt: local.exp ? new Date(local.exp * 1000).toISOString() : null,
          },
        });
      }
      const member = await addMember(body);
      await writeAppLog('添加账号', {
        账号: memberLogLabel(member),
        来源: '手动粘贴Token',
      });
      const refreshed = await refreshOne(member.id, {
        source: '添加账号',
        trigger: '手动添加',
      });
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
      /^\/api\/members\/([^/]+)(\/refresh|\/usage-events|\/previous-cycle|\/switch|\/presence)?$/,
    );
    if (memberMatch) {
      const id = decodeURIComponent(memberMatch[1]);
      const suffix = memberMatch[2] || '';

      if (method === 'DELETE' && suffix === '/presence') {
        await assertAdmin(req);
        const hostname = String(url.searchParams.get('hostname') || '').trim();
        if (!hostname) throw new Error('缺少 hostname');
        const removed = await removeMemberPresence(id, hostname);
        if (!removed) {
          const err = new Error('该使用人不在此账号席位上');
          err.status = 404;
          throw err;
        }
        await writeAppLog('移除使用人', {
          操作者: req.consoleUser,
          账号: id,
          主机名: hostname,
        });
        return sendJson(res, 200, { ok: true });
      }

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
        const model = String(url.searchParams.get('model') || '').trim();
        const forceSync =
          url.searchParams.get('sync') === '1' || url.searchParams.get('sync') === 'true';
        try {
          await ensureMemberUsageEventsSynced(id, member.cookieValue, { force: forceSync });
        } catch (syncErr) {
          // 有本地缓存时仍可读库；完全无数据则把错误抛给前端。
          console.warn('[usage-events] sync 失败', id, syncErr?.message || syncErr);
          const listed = await listUsageEvents(id, { days, model, page, pageSize });
          if (!listed.total && page === 1) throw syncErr;
        }
        const data = await listUsageEvents(id, { days, model, page, pageSize });
        return sendJson(res, 200, { ...data, fromCache: true });
      }

      if (method === 'GET' && suffix === '/previous-cycle') {
        const member = await getMemberInternal(id);
        if (!member) throw new Error('成员不存在');
        return sendJson(res, 200, await loadPreviousCycle(member));
      }

      if (method === 'POST' && suffix === '/refresh') {
        const member = await refreshOne(id, { source: '控制台', trigger: '单账号刷新' });
        return sendJson(res, 200, { member });
      }
      if (method === 'POST' && suffix === '/switch') {
        const result = await createAccountSwitch({
          memberId: id,
          operatorUsername: String(req.consoleUser || ''),
          clientIp: clientIpOf(req),
        });
        await writeAppLog('切换发起', {
          操作者: req.consoleUser,
          账号: result.member.displayName || result.member.email || result.member.id,
          票据: result.ticketId,
          IP: clientIpOf(req) || undefined,
        });
        return sendJson(res, 200, result);
      }
      if (method === 'PUT' && !suffix) {
        await assertAdmin(req);
        const body = await readBody(req);
        const member = await updateMember(id, body);
        return sendJson(res, 200, { member });
      }
      if (method === 'DELETE' && !suffix) {
        await assertAdmin(req);
        // 只从号池摘掉；席位一并清，不碰 Cursor/插件本机授权
        const cleared = await clearPresenceForMember(id);
        await deleteMember(id);
        await writeAppLog('删除账号', {
          操作者: req.consoleUser,
          账号: id,
          清席位: cleared || undefined,
        });
        return sendJson(res, 200, { ok: true, clearedPresence: cleared });
      }
    }

    if (method === 'POST' && pathname === '/api/refresh-all') {
      const members = await refreshAll(1, { source: '控制台', trigger: '刷新用量' });
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
// 控制台账号、席位与审计侧表同库，须先开库再写应用日志。
await initStore();
await initAppLog();
await initUsers();
await hydratePresenceFromAppLog();
// 席位以库为准：启动时用切换/上报审计把归属纠正写回，之后靠插件上报与人工维护
const presenceReconciled = await reconcilePresenceFromActivity().catch((e) => {
  console.warn('[presence] 纠正写库失败:', e?.message || e);
  return 0;
});
if (presenceReconciled) {
  console.log(`[presence] 已纠正写库 ${presenceReconciled} 条席位`);
}
setupServerAutoRefresh();
setupLogPruneSchedule();
setupUsagePercentArchiveSchedule();
setupExpiringNotifySchedule();

server.listen(PORT, HOST, async () => {
  console.log(`cursor-team-usage → http://${HOST}:${PORT}`);
  console.log(`存储：${getStoreDriver()}`);
  console.log(
    `插件上报鉴权：${isAccessKeyConfigured() ? '已启用 Access Key' : '未配置（/api/agent/report 不可用）'}`,
  );
  console.log('控制台登录：支持多用户；默认 admin / admin（首次登录须改密）');
  await writeAppLog('启动', {
    地址: `http://${HOST}:${PORT}`,
    存储: getStoreDriver(),
    自动刷新秒: getServerAutoRefreshSec(),
    日志保留天: getLogRetentionDays(),
    插件鉴权: isAccessKeyConfigured() ? '已启用' : '未配置',
  });
});
