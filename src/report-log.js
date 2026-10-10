/** Reporter 自动上报审计日志。 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'data', 'report-events.json');
const MAX_ROWS = 3000;

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

/** @param {Record<string, unknown>} input */
export async function recordReportEvent(input) {
  const rows = await load();
  rows.unshift({
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...input,
  });
  if (rows.length > MAX_ROWS) rows.length = MAX_ROWS;
  await persist();
}

/** @param {number} [limit] */
export async function listReportEvents(limit = 200) {
  const rows = await load();
  const n = Math.max(1, Math.min(1000, Number(limit) || 200));
  return rows.slice(0, n);
}
