/** 控制台登录审计日志，独立落在 data/login-events.json。 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'data', 'login-events.json');
const MAX_ROWS = 2000;

/** @type {any[]|null} */
let cache = null;
let writeChain = Promise.resolve();

async function load() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(await readFile(FILE, 'utf8'));
    cache = Array.isArray(parsed) ? parsed : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function persist() {
  writeChain = writeChain.catch(() => {}).then(async () => {
    await mkdir(path.dirname(FILE), { recursive: true });
    await writeFile(FILE, JSON.stringify(cache || [], null, 2) + '\n', 'utf8');
  });
  return writeChain;
}

/**
 * @param {{ username?: string, ok: boolean, role?: string|null, ip?: string|null, userAgent?: string|null }} input
 */
export async function recordLoginEvent(input) {
  const rows = await load();
  rows.unshift({
    id: randomUUID(),
    username: String(input.username || '').trim() || '—',
    ok: Boolean(input.ok),
    role: input.role ? String(input.role) : null,
    ip: input.ip ? String(input.ip) : null,
    userAgent: input.userAgent ? String(input.userAgent).slice(0, 300) : null,
    createdAt: new Date().toISOString(),
  });
  if (rows.length > MAX_ROWS) rows.length = MAX_ROWS;
  await persist();
}

/** @param {number} [limit] */
export async function listLoginEvents(limit = 200) {
  const rows = await load();
  const n = Math.max(1, Math.min(1000, Number(limit) || 200));
  return rows.slice(0, n);
}
