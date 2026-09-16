/**
 * 无依赖自检：Token 规范化与额度解析，避免核心逻辑回归时静默坏掉。
 * 运行：node --test test/unit.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCookieValue,
  normalizeManualToken,
  sessionFromCookie,
  maskToken,
  tokenExpiresAtIso,
} from '../src/auth.js';
import { getStoreDriver, loadAppConfig, getAccessKey } from '../src/config.js';
import {
  parseQuotaResponse,
  computeResetIso,
  summarizeEvents,
  parseUsageSummary,
  mergePlanMeters,
  buildOpenUsagePanelLines,
  aggregateSpendPeriods,
  usageKindLabel,
  usageCostLabel,
  eventTotalTokens,
} from '../src/cursor-api.js';

test('normalizeManualToken 接受 cookie / name=value / 裸 JWT', () => {
  const jwt =
    'eyJhbGciOiJub25lIn0.' +
    Buffer.from(JSON.stringify({ sub: 'auth0|user_abc' })).toString('base64url') +
    '.x';

  assert.equal(
    normalizeManualToken('user_abc%3A%3Atoken'),
    'user_abc%3A%3Atoken',
  );
  assert.equal(
    normalizeManualToken('WorkosCursorSessionToken=user_abc::token'),
    'user_abc%3A%3Atoken',
  );
  assert.equal(normalizeManualToken(jwt), buildCookieValue('user_abc', jwt));
  assert.equal(normalizeManualToken(''), null);
});

test('tokenExpiresAtIso 从 JWT exp 解析', () => {
  const exp = Math.floor(Date.UTC(2026, 8, 16, 3, 0, 0) / 1000); // 2026-09-16 11:00 CST = 03:00 UTC
  const jwt =
    'eyJhbGciOiJub25lIn0.' +
    Buffer.from(JSON.stringify({ sub: 'auth0|user_abc', exp })).toString('base64url') +
    '.x';
  const cookie = buildCookieValue('user_abc', jwt);
  assert.equal(tokenExpiresAtIso(cookie), new Date(exp * 1000).toISOString());
});

test('未配置数据库时默认 sqlite 存储', async () => {
  const saved = {
    STORE_DRIVER: process.env.STORE_DRIVER,
    DATABASE_URL: process.env.DATABASE_URL,
    PGHOST: process.env.PGHOST,
  };
  delete process.env.STORE_DRIVER;
  delete process.env.DATABASE_URL;
  delete process.env.PGHOST;
  try {
    await loadAppConfig();
    assert.equal(getStoreDriver(), 'sqlite');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('parseEnvFile 支持 # 注释与引号值', async () => {
  const { parseEnvFile } = await import('../src/config.js');
  const parsed = parseEnvFile(`
# comment
STORE_DRIVER=sqlite
DATABASE_URL="postgresql://u:p@h/db"
ACCESS_KEY='a//b'
`);
  assert.equal(parsed.STORE_DRIVER, 'sqlite');
  assert.equal(parsed.DATABASE_URL, 'postgresql://u:p@h/db');
  assert.equal(parsed.ACCESS_KEY, 'a//b');
});

test('getAccessKey 读取配置/环境变量', async () => {
  const prev = process.env.ACCESS_KEY;
  process.env.ACCESS_KEY = 'test-key-123';
  try {
    await loadAppConfig();
    assert.equal(getAccessKey(), 'test-key-123');
  } finally {
    if (prev === undefined) delete process.env.ACCESS_KEY;
    else process.env.ACCESS_KEY = prev;
    await loadAppConfig();
  }
});

test('sessionFromCookie 抽出 userId', () => {
  const s = sessionFromCookie('user_xyz%3A%3Aabc');
  assert.equal(s?.userId, 'user_xyz');
  assert.ok(maskToken(s.cookieValue).includes('••••'));
});

test('parseQuotaResponse 优先 gpt-4 桶', () => {
  const q = parseQuotaResponse({
    startOfMonth: '2026-09-01T00:00:00.000Z',
    'gpt-3.5': { numRequests: 10, maxRequestUsage: 500 },
    'gpt-4': { numRequests: 110, maxRequestUsage: 500 },
  });
  assert.equal(q?.used, 110);
  assert.equal(q?.limit, 500);
  assert.ok(q?.resetIso);
  assert.equal(computeResetIso('2026-01-31T00:00:00.000Z')?.startsWith('2026-02-28'), true);
});

test('summarizeEvents 汇总花费、token 与模型', () => {
  const s = summarizeEvents([
    {
      chargedCents: 250,
      tokenCents: 300,
      model: 'gpt-5',
      isTokenBasedCall: true,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    {
      chargedCents: 50,
      tokenCents: 50,
      model: 'gpt-5',
      isTokenBasedCall: true,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 50,
      cacheWriteTokens: 0,
    },
    {
      chargedCents: null,
      tokenCents: 10,
      model: 'composer',
      isTokenBasedCall: true,
      inputTokens: 10,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  ]);
  assert.equal(s.requestCount, 3);
  assert.equal(s.billedDollars, 3);
  assert.equal(s.totalTokens, 1380);
  assert.equal(s.topModels[0].model, 'gpt-5');
});

test('parseUsageSummary 读取 totalPercentUsed', () => {
  const s = parseUsageSummary({
    membershipType: 'pro_plus',
    billingCycleStart: '2026-09-10T00:00:00.000Z',
    billingCycleEnd: '2026-10-10T00:00:00.000Z',
    individualUsage: {
      plan: {
        used: 7000,
        limit: 7000,
        totalPercentUsed: 8.09,
        autoPercentUsed: 8.83,
        apiPercentUsed: 0,
      },
      onDemand: { enabled: false, used: 0 },
    },
  });
  assert.equal(s?.totalPercentUsed, 8.09);
  const m = mergePlanMeters(s, null);
  assert.equal(m.totalPercentUsed, 8.1);
  assert.equal(m.planLimitDollars, 70);
});

test('buildOpenUsagePanelLines 含百分比与花费块', () => {
  const now = Date.parse('2026-09-15T12:00:00+08:00');
  const spend = aggregateSpendPeriods(
    [
      {
        timestamp: now,
        chargedCents: 150,
        tokenCents: 150,
        inputTokens: 1000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      {
        timestamp: now - 86400000,
        chargedCents: 200,
        tokenCents: 200,
        inputTokens: 2000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ],
    now,
  );
  assert.equal(spend.today?.dollars, 1.5);
  assert.equal(spend.daily?.length, 30);

  const lines = buildOpenUsagePanelLines({
    planMeters: {
      totalPercentUsed: 8.1,
      autoPercentUsed: 8.9,
      apiPercentUsed: 0,
      billingCycleEnd: '2026-10-10T00:00:00.000Z',
      onDemand: { enabled: false },
    },
    meters: {},
    grokBot: { usagePercent: 0, resetsAt: '2026-09-22T00:00:00.000Z' },
    spend,
    window: { resetIso: '2026-10-10T00:00:00.000Z' },
  });
  const labels = lines.map((l) => l.label);
  assert.deepEqual(
    labels.slice(0, 4),
    ['Total usage', 'Cursor Models', 'Other Models', 'Grok Bot usage'],
  );
  assert.equal(lines.some((l) => l.type === 'spend-row'), true);
});

test('usageKindLabel / usageCostLabel 对齐官方 Type·Cost 文案', () => {
  assert.equal(usageKindLabel('USAGE_EVENT_KIND_INCLUDED_IN_PRO_PLUS'), 'Included');
  assert.equal(usageKindLabel('USAGE_EVENT_KIND_FREE'), 'Free');
  assert.equal(usageKindLabel('USAGE_EVENT_KIND_USAGE_BASED'), 'On-Demand');
  assert.equal(
    usageCostLabel({ kind: 'USAGE_EVENT_KIND_INCLUDED_IN_PRO_PLUS', chargedCents: 22 }),
    'Included',
  );
  assert.equal(
    usageCostLabel({ kind: 'USAGE_EVENT_KIND_USAGE_BASED', chargedCents: 150 }),
    '$1.50',
  );
  assert.equal(
    eventTotalTokens({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 880 }),
    1000,
  );
});

test('countWorkingDaysInclusive / computeUsagePace 按工作日节奏预警', async () => {
  const { countWorkingDaysInclusive, computeUsagePace } = await import('../public/shared.js');
  // 2026-09-14 周一 → 2026-09-18 周五 = 5 个工作日
  const mon = Date.parse('2026-09-14T00:00:00+08:00');
  const fri = Date.parse('2026-09-18T00:00:00+08:00');
  assert.equal(countWorkingDaysInclusive(mon, fri), 5);
  // 含周末：9/14–9/20 = 5 工作日
  assert.equal(countWorkingDaysInclusive(mon, Date.parse('2026-09-20T00:00:00+08:00')), 5);

  const member = {
    lastSnapshot: {
      meters: { totalPercentUsed: 50 },
      window: {
        startIso: '2026-09-01T00:00:00.000Z',
        endIso: '2026-09-30T00:00:00.000Z',
      },
    },
  };
  // 假想「今天」为周期中段工作日，50% 用量应可算出日均与预计期末
  const pace = computeUsagePace(member, Date.parse('2026-09-16T12:00:00+08:00'));
  assert.ok(pace);
  assert.equal(pace.usedPercent, 50);
  assert.ok(pace.elapsedWorkDays >= 1);
  assert.ok(pace.dailyPercent > 0);
  assert.ok(['ok', 'warn', 'danger'].includes(pace.status));
  assert.ok(pace.label);
});
