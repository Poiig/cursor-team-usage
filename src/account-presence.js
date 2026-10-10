/**
 * 账号当前使用人：Reporter 定时上报 hostname，按主机保留最近所在账号。
 * 90 分钟内有上报/切换记录视为活跃，数据落在 volume，重启不丢。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccountUserLimits } from './config.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'data', 'account-presence.json');
const LOG_DIR = path.join(ROOT, 'data', 'log');
const ACTIVE_MS = 90 * 60 * 1000;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** @type {Record<string, { memberId: string, memberDisplayName?: string|null, hostname: string, username?: string|null, label: string, lastSeenAt: string }>|null} */
let cache = null;
let writeChain = Promise.resolve();

async function load() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(await readFile(FILE, 'utf8'));
    cache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    cache = {};
  }
  return cache;
}

async function persist() {
  writeChain = writeChain.catch(() => {}).then(async () => {
    await mkdir(path.dirname(FILE), { recursive: true });
    await writeFile(FILE, JSON.stringify(cache || {}, null, 2) + '\n', 'utf8');
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
 * 从最近应用日志回填升级前的上报记录，避免首次启用 presence 后列表暂时全空。
 */
export async function hydratePresenceFromAppLog(now = Date.now()) {
  const rows = await load();
  const dates = [new Date(now), new Date(now - 86400000)].map((date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  });
  let changed = false;
  for (const date of dates) {
    let text = '';
    try {
      text = await readFile(path.join(LOG_DIR, `${date}.log`), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('[上报]')) continue;
      const time = line.match(/^\[([^\]]+)\]/)?.[1];
      const seenMs = time ? new Date(time.replace(' ', 'T')).getTime() : NaN;
      if (!Number.isFinite(seenMs) || seenMs < now - ACTIVE_MS) continue;
      const memberId = line.match(/\bid=([^\s]+)/)?.[1] || '';
      const hostname = line.match(/主机名=([^\s]+)/)?.[1] || '';
      if (!memberId || !hostname) continue;
      const username = line.match(/使用人=([^\s]+)/)?.[1] || '';
      const remark =
        line.match(/显示名请求=(.*?)(?:\s插件版本=|\s插件构建=|$)/)?.[1]?.trim() || hostname;
      const key = hostname.toLowerCase();
      if (Date.parse(rows[key]?.lastSeenAt || '') >= seenMs) continue;
      const identity = resolvePresenceIdentity({ username, label: remark, hostname });
      rows[key] = {
        memberId,
        memberDisplayName:
          line.match(/\[上报\]\s账号=(.*?)\sid=/)?.[1]?.trim() || null,
        hostname,
        username: identity.username,
        label: identity.label || hostname,
        lastSeenAt: new Date(seenMs).toISOString(),
      };
      changed = true;
    }
  }
  if (changed) await persist();
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
