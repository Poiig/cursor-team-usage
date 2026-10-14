/** Reporter 自动上报审计日志，落存储驱动。 */

import { randomUUID } from 'node:crypto';
import { insertReportEvent, listStoredReportEvents, pruneReportEvents } from './store.js';
import { REPORT_EVENTS_MAX } from './store-side-data.js';

/** @param {Record<string, unknown>} input */
export async function recordReportEvent(input) {
  await insertReportEvent({
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...input,
  });
  await pruneReportEvents(REPORT_EVENTS_MAX);
}

/** @param {number} [limit] */
export async function listReportEvents(limit = 200) {
  const n = Math.max(1, Math.min(1000, Number(limit) || 200));
  return listStoredReportEvents(n);
}
