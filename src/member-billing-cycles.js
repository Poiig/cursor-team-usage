/**
 * 账号账单周期落库：一行一窗，可累积；估窗不写。
 * 上线 UI 只取 current + 最近 closed；后期直接分页同一张表。
 */

import { localDayKey } from './cursor-api.js';
import {
  cycleKindFromSnapshot,
  isSyntheticBillingWindow,
  previousCycleFinalPercents,
  previousCycleWindow,
  summarizeCycleEvents,
} from './billing-cycle.js';
import { exhaustionFromPercentDays } from '../public/shared.js';
import { percentsFromSnapshot } from './usage-percent-history.js';
import {
  closeBillingCycle,
  getCurrentBillingCycle,
  listUsageEventsInRange,
  setPrevCycleSummary,
  upsertBillingCycle,
} from './store.js';

/**
 * @typedef {{
 *   memberId: string,
 *   startIso: string,
 *   endIso: string,
 *   cycleKind: 'weekly' | 'monthly',
 *   planName: string | null,
 *   membershipType: string | null,
 *   source: 'billing',
 *   status: 'current' | 'closed',
 *   totalPct: number | null,
 *   autoPct: number | null,
 *   apiPct: number | null,
 *   peakTotal: number | null,
 *   exhaustedDate: string | null,
 *   daysToExhaust: number | null,
 *   totals: object | null,
 *   models: object[] | null,
 *   closedAt: string | null,
 *   storedAt: string,
 *   updatedAt: string,
 * }} BillingCycleRow
 */

/**
 * 从快照 + 按日% 拼一条可入库的周期行（不含 totals）。
 * @param {string} memberId
 * @param {any} snapshot
 * @param {Array<{ date: string, total?: number | null }> | null | undefined} usagePercentHistory
 * @param {'current' | 'closed'} status
 * @param {string} [nowIso]
 */
export function buildBillingCycleRow(memberId, snapshot, usagePercentHistory, status, nowIso) {
  const win = snapshot?.window;
  if (!win?.startIso || isSyntheticBillingWindow(win)) return null;
  const startMs = Date.parse(win.startIso);
  const endMs = Date.parse(win.endIso || '') || Date.now();
  if (!Number.isFinite(startMs)) return null;
  const startDay = localDayKey(startMs);
  const lastDay = localDayKey(Math.max(startMs, endMs - 1));
  const days = (usagePercentHistory || []).filter(
    (r) => r?.date && r.date >= startDay && r.date <= lastDay,
  );
  const p = percentsFromSnapshot(snapshot);
  const ex = exhaustionFromPercentDays(days, startDay, p.total);
  const now = nowIso || new Date().toISOString();
  return {
    memberId,
    startIso: win.startIso,
    endIso: win.endIso || new Date(endMs).toISOString(),
    cycleKind: cycleKindFromSnapshot(snapshot),
    planName: snapshot?.plan?.planName || null,
    membershipType: snapshot?.plan?.membershipType || null,
    source: 'billing',
    status,
    totalPct: p.total,
    autoPct: p.auto,
    apiPct: p.api,
    peakTotal: ex.peakTotal,
    exhaustedDate: ex.exhaustedDate,
    daysToExhaust: ex.daysToExhaust,
    totals: null,
    models: null,
    closedAt: status === 'closed' ? snapshot?.syncedAt || now : null,
    storedAt: now,
    updatedAt: now,
  };
}

/**
 * 同步成功后：upsert 本周期；若换期则封存旧 current 并写事件汇总。
 * @param {string} memberId
 * @param {any} prevMember 同步前内部成员
 * @param {any} nextSnapshot
 * @param {Array<{ date: string, total?: number | null }>} usagePercentHistory 已含本次 recordSync 的历史
 */
export async function persistMemberBillingCycle(memberId, prevMember, nextSnapshot, usagePercentHistory) {
  const row = buildBillingCycleRow(memberId, nextSnapshot, usagePercentHistory, 'current');
  if (!row) return null;

  const prevStart = prevMember?.lastSnapshot?.window?.startIso;
  const nextStart = row.startIso;
  const rolled =
    Boolean(prevStart) &&
    Boolean(nextStart) &&
    Date.parse(nextStart) - Date.parse(prevStart) > 86400000 &&
    !isSyntheticBillingWindow(prevMember?.lastSnapshot?.window);

  if (rolled) {
    const prevSnap = prevMember.lastSnapshot;
    const closing = buildBillingCycleRow(
      memberId,
      { ...prevSnap, window: { ...prevSnap.window, endIso: prevSnap.window?.endIso || nextStart } },
      prevMember.usagePercentHistory || usagePercentHistory,
      'closed',
      nextSnapshot.syncedAt || new Date().toISOString(),
    );
    if (closing) {
      const startMs = Date.parse(closing.startIso);
      const endMs = Date.parse(closing.endIso);
      let totals = null;
      let models = null;
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
        try {
          const events = await listUsageEventsInRange(memberId, startMs, endMs);
          const summary = summarizeCycleEvents(events);
          totals = summary.totals || null;
          models = Array.isArray(summary.models) ? summary.models.slice(0, 20) : null;
        } catch {
          /* 事件不全也照样封存 % */
        }
      }
      const sealed = { ...closing, totals, models };
      await closeBillingCycle(memberId, sealed);
      // 兼容旧报表字段
      await setPrevCycleSummary(memberId, {
        startIso: sealed.startIso,
        endIso: sealed.endIso,
        cycleKind: sealed.cycleKind,
        planName: sealed.planName,
        membershipType: sealed.membershipType,
        totals: sealed.totals,
        models: sealed.models,
        total: sealed.totalPct,
        auto: sealed.autoPct,
        api: sealed.apiPct,
        peakTotal: sealed.peakTotal,
        exhaustedDate: sealed.exhaustedDate,
        daysToExhaust: sealed.daysToExhaust,
        storedAt: sealed.storedAt,
        closedAt: sealed.closedAt,
      });
    } else {
      // 无合格旧窗时，仍把库里的 current 标成 closed（若存在）
      const cur = await getCurrentBillingCycle(memberId);
      if (cur && cur.startIso !== nextStart) {
        await closeBillingCycle(memberId, {
          ...cur,
          status: 'closed',
          endIso: cur.endIso || nextStart,
          closedAt: nextSnapshot.syncedAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  await upsertBillingCycle(row);
  return row;
}

/**
 * 详情用：本周期 + 上个已封存（最多 2 条）。
 * @param {BillingCycleRow[]} rows listBillingCycles 倒序结果
 */
export function pickCurrentAndPrevious(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const current = list.find((r) => r.status === 'current') || null;
  const previous =
    list.find((r) => r.status === 'closed' && (!current || r.startIso !== current.startIso)) || null;
  return { current, previous };
}

/**
 * 表行 → 详情表展示结构。
 * @param {BillingCycleRow} row
 */
export function billingCycleToViewRow(row) {
  if (!row) return null;
  return {
    startIso: row.startIso,
    endIso: row.endIso,
    current: row.status === 'current',
    cycleKind: row.cycleKind,
    planName: row.planName,
    membershipType: row.membershipType,
    total: row.totalPct,
    auto: row.autoPct,
    api: row.apiPct,
    peakTotal: row.peakTotal,
    exhaustedDate: row.exhaustedDate,
    daysToExhaust: row.daysToExhaust,
    daySamples: null,
    closedAt: row.closedAt,
    totals: row.totals,
  };
}

/**
 * 旧 prev_cycle_summary → 详情行（换期落库前的兼容）。
 * @param {any} summary
 */
export function viewRowFromPrevSummary(summary) {
  if (!summary?.startIso || isSyntheticBillingWindow(summary)) return null;
  return {
    startIso: summary.startIso,
    endIso: summary.endIso || null,
    current: false,
    cycleKind: summary.cycleKind === 'weekly' ? 'weekly' : 'monthly',
    planName: summary.planName || null,
    membershipType: summary.membershipType || null,
    total: summary.total ?? null,
    auto: summary.auto ?? null,
    api: summary.api ?? null,
    peakTotal: summary.peakTotal ?? null,
    exhaustedDate: summary.exhaustedDate ?? null,
    daysToExhaust: summary.daysToExhaust ?? null,
    daySamples: null,
    closedAt: summary.closedAt || summary.storedAt || null,
    totals: summary.totals || null,
  };
}

/**
 * 给 previous 展示行补套餐 / 收尾% / 用完日 / 事件汇总。
 * @param {any} previous
 * @param {any} member
 */
function enrichPreviousViewRow(previous, member) {
  if (!previous?.startIso) return previous;
  const startMs = Date.parse(previous.startIso);
  const endMs = Date.parse(previous.endIso || '') || startMs;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return {
      ...previous,
      planName:
        previous.planName || member?.planName || member?.lastSnapshot?.plan?.planName || null,
      membershipType:
        previous.membershipType ||
        member?.membershipType ||
        member?.lastSnapshot?.plan?.membershipType ||
        null,
      totals: previous.totals || member?.prevCycleSummary?.totals || null,
    };
  }
  const win = { startMs, endMs };
  const p = previousCycleFinalPercents(member, win) || {};
  const startDay = localDayKey(startMs);
  const lastDay = localDayKey(Math.max(startMs, endMs - 1));
  const days = (member?.usagePercentHistory || []).filter(
    (r) => r?.date && r.date >= startDay && r.date <= lastDay,
  );
  const total = previous.total ?? p.total ?? null;
  const auto = previous.auto ?? p.auto ?? null;
  const api = previous.api ?? p.api ?? null;
  const ex = exhaustionFromPercentDays(days, startDay, total);
  const summaryMatch =
    member?.prevCycleSummary?.startIso &&
    Math.abs(Date.parse(member.prevCycleSummary.startIso) - startMs) < 60_000
      ? member.prevCycleSummary
      : null;
  return {
    ...previous,
    planName:
      previous.planName ||
      summaryMatch?.planName ||
      member?.planName ||
      member?.lastSnapshot?.plan?.planName ||
      null,
    membershipType:
      previous.membershipType ||
      summaryMatch?.membershipType ||
      member?.membershipType ||
      member?.lastSnapshot?.plan?.membershipType ||
      null,
    total,
    auto,
    api,
    peakTotal: previous.peakTotal ?? ex.peakTotal,
    exhaustedDate: previous.exhaustedDate ?? ex.exhaustedDate,
    daysToExhaust: previous.daysToExhaust ?? ex.daysToExhaust,
    totals: previous.totals || summaryMatch?.totals || null,
    closedAt: previous.closedAt || p.closedAt || summaryMatch?.storedAt || null,
  };
}

/**
 * 详情用双槽：表优先；缺 previous 时用 prevCycleSummary / 推算上个窗补上。
 * @param {any} member 内部成员
 * @param {BillingCycleRow[]} rows
 */
export async function resolveDetailBillingCycles(member, rows) {
  const picked = pickCurrentAndPrevious(rows);
  let current = billingCycleToViewRow(picked.current);
  if (!current && member?.lastSnapshot?.window && !isSyntheticBillingWindow(member.lastSnapshot.window)) {
    current = billingCycleToViewRow(
      buildBillingCycleRow(
        member.id,
        member.lastSnapshot,
        member.usagePercentHistory,
        'current',
      ),
    );
  }

  let previous = billingCycleToViewRow(picked.previous);
  if (!previous && member?.prevCycleSummary?.startIso) {
    const fromSummary = viewRowFromPrevSummary(member.prevCycleSummary);
    if (fromSummary && fromSummary.startIso !== current?.startIso) previous = fromSummary;
  }

  // 仍无 previous：用当前窗推算上个官方窗
  if (!previous && member?.lastSnapshot) {
    const win = previousCycleWindow(member.lastSnapshot);
    if (win) {
      const startIso = new Date(win.startMs).toISOString();
      const endIso = new Date(win.endMs).toISOString();
      if (startIso !== current?.startIso) {
        previous = {
          startIso,
          endIso,
          current: false,
          cycleKind: cycleKindFromSnapshot(member.lastSnapshot),
          planName: null,
          membershipType: null,
          total: null,
          auto: null,
          api: null,
          peakTotal: null,
          exhaustedDate: null,
          daysToExhaust: null,
          daySamples: null,
          closedAt: null,
          totals: null,
        };
      }
    }
  }

  if (previous) previous = enrichPreviousViewRow(previous, member);

  // 缺 % / 套餐的 closed 行写回表，避免一直靠兼容拼装
  if (
    previous &&
    member?.id &&
    (picked.previous?.totalPct == null || !picked.previous?.planName) &&
    (previous.total != null || previous.planName)
  ) {
    try {
      await closeBillingCycle(member.id, {
        memberId: member.id,
        startIso: previous.startIso,
        endIso: previous.endIso || previous.startIso,
        cycleKind: previous.cycleKind || 'monthly',
        planName: previous.planName,
        membershipType: previous.membershipType,
        source: 'billing',
        status: 'closed',
        totalPct: previous.total,
        autoPct: previous.auto,
        apiPct: previous.api,
        peakTotal: previous.peakTotal,
        exhaustedDate: previous.exhaustedDate,
        daysToExhaust: previous.daysToExhaust,
        totals: previous.totals,
        models: Array.isArray(member.prevCycleSummary?.models)
          ? member.prevCycleSummary.models.slice(0, 20)
          : null,
        closedAt: previous.closedAt,
        storedAt: member.prevCycleSummary?.storedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } catch {
      /* 回填失败不影响展示 */
    }
  }

  return { current, previous };
}
