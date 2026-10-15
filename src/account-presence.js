/**
 * 账号使用人席位：以数据库为准。
 * 写入路径：插件上报 / 切换成功 / 管理员移除；展示只读库，不因断报清空。
 * 启动时可用审计日志把缺失或过期归属纠正写回库。
 */

import { readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccountUserLimits } from './config.js';
import {
  listAppLogsForHydrate,
  listStoredReportEvents,
  listSwitchLogs,
  loadAccountPresenceMap,
  prunePresenceBefore,
  saveAccountPresenceMap,
} from './store.js';
import { PRESENCE_KEEP_MS } from './store-side-data.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 升级前本地 JSON；首次读库为空时导入一次后改名，避免反复覆盖库。 */
const LEGACY_FILE = path.join(ROOT, 'data', 'account-presence.json');
const LOG_DIR = path.join(ROOT, 'data', 'log');
/** 仅用于启动时从日志回填，与席位展示无关。 */
const HYDRATE_MS = PRESENCE_KEEP_MS;
const KEEP_MS = PRESENCE_KEEP_MS;
/** 多实例共享库时短缓存，避免长期脏读。 */
const CACHE_TTL_MS = 5000;

/** @type {Record<string, { memberId: string, memberDisplayName?: string|null, hostname: string, username?: string|null, label: string, lastSeenAt: string }>|null} */
let cache = null;
let cacheAt = 0;
let writeChain = Promise.resolve();
let migratedLegacy = false;

async function load() {
  if (cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;
  cache = await loadAccountPresenceMap();
  cacheAt = Date.now();
  if (!Object.keys(cache).length && !migratedLegacy) {
    await importLegacyJsonOnce();
  }
  return cache;
}

/**
 * 把旧版 data/account-presence.json 导入当前存储，成功后改名为 .migrated。
 */
async function importLegacyJsonOnce() {
  migratedLegacy = true;
  try {
    const parsed = JSON.parse(await readFile(LEGACY_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Object.keys(parsed).length) return;
    cache = parsed;
    await saveAccountPresenceMap(cache);
    try {
      await rename(LEGACY_FILE, `${LEGACY_FILE}.migrated`);
    } catch {
      /* 改名失败不影响已导入数据 */
    }
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      console.warn('[presence] 导入旧 JSON 失败:', e?.message || e);
    }
  }
}

async function persist() {
  writeChain = writeChain.catch(() => {}).then(async () => {
    await saveAccountPresenceMap(cache || {});
    cacheAt = Date.now();
  });
  return writeChain;
}

/** @param {any} member */
export function maxUsersForMember(member) {
  const plan = String(
    member?.planName ||
      member?.lastSnapshot?.plan?.planName ||
      member?.membershipType ||
      member?.lastSnapshot?.plan?.membershipType ||
      '',
  )
    .trim()
    .toLowerCase();
  const limits = getAccountUserLimits();
  if (plan.includes('pro+') || plan.includes('pro plus') || plan.includes('pro_plus')) {
    return limits.proPlus;
  }
  if (plan === 'pro' || /\bpro\b/.test(plan)) return limits.pro;
  return null;
}

/**
 * 席位上给人看的名字。
 * 用户名有别名时用用户管理里的别名；否则用账号列表里该主机名对应的中文备注。
 * @param {{ username?: string|null, hostname?: string|null, label?: string|null }} row
 * @param {{ aliasByUsername?: Map<string, string>, nameByHostname?: Map<string, string> }} [ctx]
 */
export function displayPresenceLabel(row, ctx = {}) {
  const username = String(row?.username || '').trim();
  const alias = username ? ctx.aliasByUsername?.get(username.toLowerCase()) : '';
  if (alias) return alias;
  const host = String(row?.hostname || '').trim().toLowerCase();
  const chinese = host ? ctx.nameByHostname?.get(host) : '';
  if (chinese) return chinese;
  if (username) return username;
  return String(row?.label || row?.hostname || '').trim();
}

/**
 * 给一批账号的使用人席位套上别名 / 中文备注。
 * @param {any[]} members
 * @param {Map<string, string>} aliasByUsername
 */
export function applyPresenceDisplayNames(members, aliasByUsername) {
  /** @type {Map<string, string>} */
  const nameByHostname = new Map();
  for (const member of members || []) {
    const host = String(member?.hostname || '').trim().toLowerCase();
    const name = String(member?.displayName || '').trim();
    if (host && name && !nameByHostname.has(host)) nameByHostname.set(host, name);
  }
  return (members || []).map((member) => ({
    ...member,
    activeUsers: (member.activeUsers || []).map((user) => ({
      ...user,
      label: displayPresenceLabel(user, { aliasByUsername, nameByHostname }) || user.label,
    })),
  }));
}

/** 新插件优先看板用户名；旧插件使用本次上报的主机备注。 */
export function resolvePresenceIdentity(input) {
  const username = String(input?.username || '').trim();
  const hostname = String(input?.hostname || '').trim();
  const remark = String(input?.label || '').trim();
  return {
    username: username || null,
    label: username || remark || hostname,
  };
}

/**
 * 同一主机每次只属于一个账号；切换或上报会覆盖它的当前位置（以本次 session 为准）。
 * @param {{ memberId: string, memberDisplayName?: string|null, hostname?: string|null, username?: string|null, label?: string|null }} input
 */
export async function recordAccountPresence(input) {
  const hostname = String(input.hostname || '').trim();
  const memberId = String(input.memberId || '').trim();
  if (!hostname || !memberId) return;
  const rows = await load();
  const now = Date.now();
  for (const [key, row] of Object.entries(rows)) {
    if (Date.parse(row.lastSeenAt) < now - KEEP_MS) delete rows[key];
  }
  const key = hostname.toLowerCase();
  const identity = resolvePresenceIdentity(input);
  rows[key] = {
    memberId,
    memberDisplayName:
      String(input.memberDisplayName || '').trim() || rows[key]?.memberDisplayName || null,
    hostname,
    // 新插件带看板用户名；旧插件不带，必须回退本次上报的主机备注，不能沿用旧用户。
    username: identity.username,
    label: identity.label || hostname,
    lastSeenAt: new Date(now).toISOString(),
  };
  await persist();
}

/**
 * 管理员从某账号席位移除一台主机；仅清看板席位，不回收 Cursor/插件授权。
 * @param {string} memberId
 * @param {string} hostname
 * @returns {Promise<boolean>} 是否删到了行
 */
export async function removeMemberPresence(memberId, hostname) {
  const id = String(memberId || '').trim();
  const key = String(hostname || '')
    .trim()
    .toLowerCase();
  if (!id || !key) return false;
  const rows = await load();
  const row = rows[key];
  if (!row || row.memberId !== id) return false;
  delete rows[key];
  await persist();
  return true;
}

/**
 * 删号池账号时一并清掉挂在该账号上的席位，避免幽灵使用人。
 * @param {string} memberId
 * @returns {Promise<number>} 删除行数
 */
export async function clearPresenceForMember(memberId) {
  const id = String(memberId || '').trim();
  if (!id) return 0;
  const rows = await load();
  let n = 0;
  for (const [key, row] of Object.entries(rows)) {
    if (row.memberId === id) {
      delete rows[key];
      n += 1;
    }
  }
  if (n) await persist();
  return n;
}

/** 席位按上报/切换粘性占有，不因断报消失。 @param {any} member */
export async function getMemberCapacity(member) {
  const rows = await load();
  const activeUsers = Object.values(rows)
    .filter((row) => row.memberId === member?.id)
    .map((row) => ({
      hostname: row.hostname,
      username: row.username || null,
      label: row.label || row.hostname,
      lastSeenAt: row.lastSeenAt,
    }))
    .sort((a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));

  const maxUsers = maxUsersForMember(member);
  return {
    activeUsers,
    activeUserCount: activeUsers.length,
    maxUsers,
    capacityFull: maxUsers != null && activeUsers.length >= maxUsers,
  };
}

/** @param {any[]} members */
export async function enrichMembersWithPresence(members) {
  return Promise.all(
    (members || []).map(async (member) => ({
      ...member,
      ...(await getMemberCapacity(member)),
    })),
  );
}

/**
 * 用最近成功的切换/上报纠正席位并写回库（缺席或归属不一致时）。
 * 不抬新 lastSeenAt 到「现在」，沿用事件时间，避免伪造活跃。
 * @returns {Promise<number>} 写库条数
 */
export async function reconcilePresenceFromActivity() {
  const [switches, reports, rows] = await Promise.all([
    listSwitchLogs({ limit: 500 }),
    listStoredReportEvents(500),
    load(),
  ]);

  /** @type {Map<string, { memberId: string, memberDisplayName?: string|null, hostname: string, username?: string|null, label: string, at: string }>} */
  const latest = new Map();

  /** @param {any} ev */
  function consider(ev) {
    const hostname = String(ev.hostname || '').trim();
    const memberId = String(ev.memberId || '').trim();
    const at = String(ev.createdAt || ev.finishedAt || '').trim();
    if (!hostname || !memberId || !at) return;
    const key = hostname.toLowerCase();
    const prev = latest.get(key);
    if (prev && String(prev.at) >= at) return;
    const username = String(ev.operatorUsername || ev.username || '').trim() || null;
    latest.set(key, {
      memberId,
      memberDisplayName: ev.memberDisplayName || null,
      hostname,
      username,
      label: username || hostname,
      at,
    });
  }

  for (const log of switches || []) {
    if (log.status !== 'success') continue;
    consider(log);
  }
  for (const log of reports || []) {
    if (log.ok === false) continue;
    consider(log);
  }

  let wrote = 0;
  for (const [key, ev] of latest) {
    const cur = rows[key];
    const curSeen = Date.parse(cur?.lastSeenAt || '') || 0;
    const evAt = Date.parse(ev.at) || 0;
    // 已有更新的上报/切换席位则不动；否则按审计纠正归属并写库
    if (cur && curSeen > evAt) continue;
    if (
      cur &&
      cur.memberId === ev.memberId &&
      String(cur.username || '') === String(ev.username || '')
    ) {
      continue;
    }
    rows[key] = {
      memberId: ev.memberId,
      memberDisplayName: ev.memberDisplayName,
      hostname: ev.hostname,
      username: ev.username,
      label: ev.label,
      lastSeenAt: new Date(evAt || Date.now()).toISOString(),
    };
    wrote += 1;
  }
  if (wrote) {
    cache = rows;
    await persist();
  }
  return wrote;
}

/**
 * 从应用日志（优先库内 app_logs，回退按日文本）回填升级前的上报记录。
 * @param {number} [now]
 */
export async function hydratePresenceFromAppLog(now = Date.now()) {
  const rows = await load();
  let changed = false;

  /** @param {string} line @param {number} seenMs */
  function applyLine(line, seenMs) {
    if (!line.includes('[上报]')) return;
    if (!Number.isFinite(seenMs) || seenMs < now - HYDRATE_MS) return;
    const memberId = line.match(/\bid=([^\s]+)/)?.[1] || '';
    const hostname = line.match(/主机名=([^\s]+)/)?.[1] || '';
    if (!memberId || !hostname) return;
    const username = line.match(/使用人=([^\s]+)/)?.[1] || '';
    const remark =
      line.match(/显示名请求=(.*?)(?:\s插件版本=|\s插件构建=|$)/)?.[1]?.trim() || hostname;
    const key = hostname.toLowerCase();
    if (Date.parse(rows[key]?.lastSeenAt || '') >= seenMs) return;
    const identity = resolvePresenceIdentity({ username, label: remark, hostname });
    rows[key] = {
      memberId,
      memberDisplayName: line.match(/\[上报\]\s账号=(.*?)\sid=/)?.[1]?.trim() || null,
      hostname,
      username: identity.username,
      label: identity.label || hostname,
      lastSeenAt: new Date(seenMs).toISOString(),
    };
    changed = true;
  }

  try {
    const sinceIso = new Date(now - HYDRATE_MS).toISOString();
    const dbLogs = await listAppLogsForHydrate(sinceIso, 2000);
    for (const entry of dbLogs) {
      applyLine(entry.line, Date.parse(entry.createdAt));
    }
  } catch {
    /* 库未就绪时回退文本 */
  }

  const dates = [new Date(now), new Date(now - 86400000)].map((date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  });
  for (const date of dates) {
    let text = '';
    try {
      text = await readFile(path.join(LOG_DIR, `${date}.log`), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const time = line.match(/^\[([^\]]+)\]/)?.[1];
      const seenMs = time ? new Date(time.replace(' ', 'T')).getTime() : NaN;
      applyLine(line, seenMs);
    }
  }
  if (changed) await persist();
}

/**
 * 删除超过保留期的 presence 行，并清内存缓存。
 * 上报/切换后调用，避免表无限膨胀。
 * @param {number} [now]
 */
export async function pruneStalePresence(now = Date.now()) {
  const cutoff = new Date(now - KEEP_MS).toISOString();
  await prunePresenceBefore(cutoff);
  cache = null;
  cacheAt = 0;
}

/** 用户名 → 当前所在账号（粘性席位），供用户管理列表展示。 */
export async function listPresenceByUsername() {
  const rows = await load();
  const out = {};
  for (const row of Object.values(rows)) {
    if (!row.username) continue;
    if (!out[row.username]) out[row.username] = [];
    out[row.username].push({
      memberId: row.memberId,
      memberDisplayName: row.memberDisplayName || null,
      hostname: row.hostname,
      lastSeenAt: row.lastSeenAt,
    });
  }
  return out;
}

/** 测试用：清内存缓存，下次从存储重读。 */
export function resetPresenceCacheForTests() {
  cache = null;
  cacheAt = 0;
  migratedLegacy = false;
}
