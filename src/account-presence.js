/**
 * 账号当前使用人：Reporter 定时上报 hostname，按主机保留最近所在账号。
 * 90 分钟内有上报/切换记录视为活跃；数据落存储驱动（sqlite/pg），多实例共享。
 */

import { readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccountUserLimits } from './config.js';
import {
  listAppLogsForHydrate,
  loadAccountPresenceMap,
  prunePresenceBefore,
  saveAccountPresenceMap,
} from './store.js';
import { PRESENCE_KEEP_MS } from './store-side-data.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 升级前本地 JSON；首次读库为空时导入一次后改名，避免反复覆盖库。 */
const LEGACY_FILE = path.join(ROOT, 'data', 'account-presence.json');
const LOG_DIR = path.join(ROOT, 'data', 'log');
const ACTIVE_MS = 90 * 60 * 1000;
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
 * 同一主机每次只属于一个账号；切换或上报会覆盖它的当前位置。
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

/** @param {any} member @param {number} [now] */
export async function getMemberCapacity(member, now = Date.now()) {
  const rows = await load();
  const activeUsers = Object.values(rows)
    .filter(
      (row) =>
        row.memberId === member?.id &&
        Number.isFinite(Date.parse(row.lastSeenAt)) &&
        Date.parse(row.lastSeenAt) >= now - ACTIVE_MS,
    )
    .map((row) => ({
      hostname: row.hostname,
      username: row.username || null,
      label: row.label || row.hostname,
      lastSeenAt: row.lastSeenAt,
    }));

  // 旧插件没有绑定看板用户；仅在完全没有近期上报时，用账号保存的备注主机占一格。
  // 一旦新旧插件产生真实 presence，就不再叠加这个兜底，避免重复计算。
  const legacyHostname = String(member?.hostname || '').trim();
  const legacyRemark = String(member?.displayName || legacyHostname).trim();
  if (!activeUsers.length && legacyRemark) {
    activeUsers.push({
      hostname: legacyHostname || legacyRemark,
      label: legacyRemark,
      lastSeenAt: null,
    });
  }

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
 * 从应用日志（优先库内 app_logs，回退按日文本）回填升级前的上报记录。
 * @param {number} [now]
 */
export async function hydratePresenceFromAppLog(now = Date.now()) {
  const rows = await load();
  let changed = false;

  /** @param {string} line @param {number} seenMs */
  function applyLine(line, seenMs) {
    if (!line.includes('[上报]')) return;
    if (!Number.isFinite(seenMs) || seenMs < now - ACTIVE_MS) return;
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
    const sinceIso = new Date(now - ACTIVE_MS).toISOString();
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

/** 用户名 → 当前正在使用的账号，供用户管理列表展示。 */
export async function listPresenceByUsername(now = Date.now()) {
  const rows = await load();
  const out = {};
  for (const row of Object.values(rows)) {
    if (
      !row.username ||
      !Number.isFinite(Date.parse(row.lastSeenAt)) ||
      Date.parse(row.lastSeenAt) < now - ACTIVE_MS
    ) {
      continue;
    }
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
