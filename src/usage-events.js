/**
 * Usage events 落库与增量同步的共享常量 / 纯函数（无 IO，便于单测）。
 */

export const USAGE_EVENTS_RETENTION_DAYS = 90;
/** 有 watermark 时回拨，避免边界漏事件。 */
export const USAGE_EVENTS_OVERLAP_MS = 2 * 60 * 60 * 1000;
/** 详情页判定本地缓存过期、需再 sync 的阈值。 */
export const USAGE_EVENTS_STALE_MS = 30 * 60 * 1000;

/**
 * 事件时间戳统一成毫秒。
 * @param {unknown} timestamp
 */
export function eventTsMs(timestamp) {
  const n = Number(timestamp);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}

/**
 * 增量拉取窗口：无库数据拉近 90 天；有则从 watermark 回拨 overlap。
 * @param {number | null | undefined} watermarkMs
 * @param {number} [nowMs]
 * @returns {{ startMs: number, endMs: number }}
 */
export function computeUsageEventsSyncWindow(watermarkMs, nowMs = Date.now()) {
  const endMs = nowMs;
  const fullStart = nowMs - USAGE_EVENTS_RETENTION_DAYS * 86400000;
  if (watermarkMs == null || !Number.isFinite(watermarkMs) || watermarkMs <= 0) {
    return { startMs: fullStart, endMs };
  }
  return {
    startMs: Math.max(fullStart, Number(watermarkMs) - USAGE_EVENTS_OVERLAP_MS),
    endMs,
  };
}

/**
 * 是否需要强制/过期触发 sync。
 * @param {{ count?: number, syncedAt?: string | null }} meta
 * @param {number} [nowMs]
 */
export function usageEventsNeedSync(meta, nowMs = Date.now()) {
  if (!meta || !meta.count) return true;
  if (!meta.syncedAt) return true;
  const t = Date.parse(meta.syncedAt);
  if (!Number.isFinite(t)) return true;
  return nowMs - t >= USAGE_EVENTS_STALE_MS;
}

/**
 * API/快照事件 → 落库行形状（字段齐全、便于 upsert）。
 * @param {any} e
 * @param {string} [syncedAt]
 */
export function normalizeUsageEventForStore(e, syncedAt = new Date().toISOString()) {
  const ts = eventTsMs(e?.timestamp ?? e?.ts_ms ?? e?.tsMs);
  const id = String(e?.id ?? e?.event_id ?? e?.eventId ?? `${ts}-${e?.model ?? 'unknown'}`);
  return {
    eventId: id,
    tsMs: ts,
    model: String(e?.model || 'unknown'),
    kind: String(e?.kind || ''),
    kindLabel: String(e?.kindLabel || e?.kind_label || ''),
    isTokenBased: Boolean(e?.isTokenBasedCall ?? e?.is_token_based),
    chargedCents: e?.chargedCents != null ? Number(e.chargedCents) : e?.charged_cents != null ? Number(e.charged_cents) : null,
    tokenCents: e?.tokenCents != null ? Number(e.tokenCents) : e?.token_cents != null ? Number(e.token_cents) : null,
    inputTokens: Number(e?.inputTokens ?? e?.input_tokens) || 0,
    outputTokens: Number(e?.outputTokens ?? e?.output_tokens) || 0,
    cacheReadTokens: Number(e?.cacheReadTokens ?? e?.cache_read_tokens) || 0,
    cacheWriteTokens: Number(e?.cacheWriteTokens ?? e?.cache_write_tokens) || 0,
    totalTokens: Number(e?.totalTokens ?? e?.total_tokens) || 0,
    costLabel: String(e?.costLabel ?? e?.cost_label ?? ''),
    syncedAt,
  };
}

/**
 * 库行 → 前端/API 事件形状（与旧 fetchMemberUsageEvents 字段对齐）。
 * @param {any} row
 */
export function usageEventFromStoreRow(row) {
  return {
    id: String(row.event_id ?? row.eventId),
    timestamp: Number(row.ts_ms ?? row.tsMs) || 0,
    model: row.model || 'unknown',
    kind: row.kind || '',
    kindLabel: row.kind_label ?? row.kindLabel ?? '',
    isTokenBasedCall: Boolean(row.is_token_based ?? row.isTokenBased),
    chargedCents: row.charged_cents ?? row.chargedCents ?? null,
    tokenCents: row.token_cents ?? row.tokenCents ?? null,
    inputTokens: Number(row.input_tokens ?? row.inputTokens) || 0,
    outputTokens: Number(row.output_tokens ?? row.outputTokens) || 0,
    cacheReadTokens: Number(row.cache_read_tokens ?? row.cacheReadTokens) || 0,
    cacheWriteTokens: Number(row.cache_write_tokens ?? row.cacheWriteTokens) || 0,
    totalTokens: Number(row.total_tokens ?? row.totalTokens) || 0,
    costLabel: row.cost_label ?? row.costLabel ?? '',
  };
}
