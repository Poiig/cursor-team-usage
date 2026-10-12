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
  fetchMe,
} from '../src/cursor-api.js';
import {
  archiveYesterdayPercents,
  dailyPercentDeltas,
  deltaVsYesterday,
  recordSyncPercents,
  yesterdayDayKey,
} from '../src/usage-percent-history.js';

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

test('请求失败时错误信息带上接口地址与真实原因', async () => {
  const realFetch = globalThis.fetch;
  const session = { cookieValue: 'x' };
  const url = 'https://cursor.com/api/auth/me';
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: 'not_authenticated' }), { status: 401 });
    await assert.rejects(fetchMe(session), {
      message: `not_authenticated (HTTP 401): ${url}`,
      status: 401,
    });

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { code: 'rate_limited' } }), { status: 429 });
    await assert.rejects(fetchMe(session), {
      message: `{"code":"rate_limited"} (HTTP 429): ${url}`,
    });

    globalThis.fetch = async () => new Response('<html>Bad Gateway</html>', { status: 502 });
    await assert.rejects(fetchMe(session), { message: `HTTP 502: ${url}` });

    globalThis.fetch = async () => {
      const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      throw new TypeError('fetch failed', { cause });
    };
    await assert.rejects(fetchMe(session), { message: `fetch failed (ECONNRESET): ${url}` });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Cursor API 瞬时网络错误会重试并恢复', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      if (calls < 2) {
        const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
        throw new TypeError('fetch failed', { cause });
      }
      return new Response(JSON.stringify({ email: 'ok@example.com', name: 'OK' }));
    };
    const me = await fetchMe({ cookieValue: 'x' });
    assert.equal(me.email, 'ok@example.com');
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('countWorkingDaysInclusive / computeUsagePace 按工作日节奏预警', async () => {
  const { countWorkingDaysInclusive, computeUsagePace } = await import('../public/shared.js');
  // 用本地正午构造日期，避免 CI（UTC）与 +08 偏移把边界日算错
  const localNoon = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0, 0).getTime();
  // 2026-09-14 周一 → 2026-09-18 周五 = 5 个工作日
  const mon = localNoon(2026, 9, 14);
  const fri = localNoon(2026, 9, 18);
  assert.equal(countWorkingDaysInclusive(mon, fri), 5);
  // 含周末：9/14–9/20 = 仍为 5 工作日
  assert.equal(countWorkingDaysInclusive(mon, localNoon(2026, 9, 20)), 5);

  const member = {
    lastSnapshot: {
      meters: { totalPercentUsed: 50 },
      window: {
        startIso: new Date(2026, 8, 1, 0, 0, 0, 0).toISOString(),
        endIso: new Date(2026, 8, 30, 0, 0, 0, 0).toISOString(),
      },
    },
  };
  // 「今天」取本地周期中段工作日
  const pace = computeUsagePace(member, localNoon(2026, 9, 16));
  assert.ok(pace);
  assert.equal(pace.usedPercent, 50);
  assert.ok(pace.elapsedWorkDays >= 1);
  assert.ok(pace.dailyPercent > 0);
  assert.ok(['ok', 'warn', 'danger'].includes(pace.status));
  assert.ok(pace.label);
});

test('buildLocalAuthPayload 从 cookie 抽出本机写入字段', async () => {
  const { buildCookieValue } = await import('../src/auth.js');
  const { buildLocalAuthPayload } = await import('../src/account-switch.js');
  // 伪造 session JWT：sub 带 provider，供 stripeMembershipAuthId 使用
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'google-oauth2|user_test123',
      type: 'session',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url');
  const jwt = `${header}.${payload}.x`;
  const cookie = buildCookieValue('user_test123', jwt);
  const auth = buildLocalAuthPayload(cookie, { email: 'a@b.com' });
  assert.equal(auth.accessToken, jwt);
  assert.equal(auth.refreshToken, jwt);
  assert.equal(auth.cachedEmail, 'a@b.com');
  assert.equal(auth.stripeMembershipAuthId, 'google-oauth2|user_test123');
  assert.equal(auth.cachedSignUpType, 'google-oauth2');
  assert.equal(auth.userId, 'user_test123');
});

test('用户名与密码校验', async () => {
  const { assertValidUsername, assertValidPassword, toPublicUser } = await import('../src/users.js');
  assert.equal(assertValidUsername('张三'), '张三');
  assert.throws(() => assertValidUsername('bad name!'), /用户名/);
  assert.equal(assertValidPassword('abcd'), 'abcd');
  assert.throws(() => assertValidPassword('admin'), /默认密码/);
  const pub = toPublicUser({
    username: 'u1',
    passwordHash: 'x',
    salt: 'y',
    role: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    mustChangePassword: true,
    disabled: false,
    pending: true,
  });
  assert.equal(pub.username, 'u1');
  assert.equal(pub.role, 'user');
  assert.equal(pub.pending, true);
  assert.equal('passwordHash' in pub, false);
});

test('切换报表汇总与 Total usage 快照', async () => {
  const {
    buildSwitchReport,
    recommendSwitchMember,
    switchBlockReason,
    usageTotalPercentOf,
  } = await import('../src/account-switch.js');

  assert.equal(
    usageTotalPercentOf({
      totalPercentUsed: 12,
      lastSnapshot: { meters: { totalPercentUsed: 45.67, primaryPercent: 10 } },
    }),
    45.7,
  );
  assert.equal(usageTotalPercentOf({ lastError: 'x' }), null);
  assert.equal(usageTotalPercentOf({ totalPercentUsed: 8 }), 8);
  assert.match(
    switchBlockReason({ lastSnapshot: { meters: { totalPercentUsed: 100 } } }),
    /额度已用完/,
  );
  const recommended = recommendSwitchMember([
    {
      id: 'empty',
      lastSnapshot: {
        meters: { totalPercentUsed: 100 },
        window: { resetIso: '2026-10-11T00:00:00Z' },
      },
    },
    {
      id: 'later',
      lastSnapshot: {
        meters: { totalPercentUsed: 5 },
        window: { resetIso: '2026-10-20T00:00:00Z' },
      },
    },
    {
      id: 'soon',
      lastSnapshot: {
        meters: { totalPercentUsed: 56 },
        window: { resetIso: '2026-10-11T00:00:00Z' },
      },
    },
  ]);
  assert.equal(recommended.id, 'soon');
  assert.match(
    switchBlockReason({
      activeUserCount: 3,
      maxUsers: 3,
      lastSnapshot: { meters: { totalPercentUsed: 10 } },
    }),
    /使用人数已满/,
  );

  const { maxUsersForMember, resolvePresenceIdentity } = await import(
    '../src/account-presence.js'
  );
  assert.equal(maxUsersForMember({ planName: 'Pro' }), 3);
  assert.equal(maxUsersForMember({ planName: 'Pro+' }), 5);
  assert.equal(maxUsersForMember({ planName: 'Free' }), null);
  assert.deepEqual(
    resolvePresenceIdentity({
      username: '',
      label: '张三的开发机',
      hostname: 'DESKTOP-ABC',
    }),
    { username: null, label: '张三的开发机' },
  );
  assert.deepEqual(
    resolvePresenceIdentity({
      username: 'zhangsan',
      label: '张三的开发机',
      hostname: 'DESKTOP-ABC',
    }),
    { username: 'zhangsan', label: 'zhangsan' },
  );

  const report = buildSwitchReport([
    {
      operatorUsername: 'alice',
      memberId: 'm1',
      status: 'success',
      clientIp: '10.0.0.1',
      hostname: 'PC-A',
    },
    {
      operatorUsername: 'alice',
      memberId: 'm2',
      status: 'failed',
      clientIp: '10.0.0.1',
      hostname: 'PC-A',
    },
    {
      operatorUsername: 'bob',
      memberId: 'm1',
      status: 'success',
      clientIp: '10.0.0.2',
      hostname: null,
    },
  ]);
  assert.equal(report.length, 2);
  assert.equal(report[0].username, 'alice');
  assert.equal(report[0].switchCount, 2);
  assert.equal(report[0].successCount, 1);
  assert.equal(report[0].memberCount, 2);
  assert.deepEqual(report[0].ips, ['10.0.0.1']);
  assert.deepEqual(report[0].hostnames, ['PC-A']);
  assert.equal(report[1].username, 'bob');
  assert.equal(report[1].memberCount, 1);
});

test('使用人席位：别名优先，老插件回退主机中文备注', async () => {
  const { displayPresenceLabel } = await import('../src/account-presence.js');
  const aliasByUsername = new Map([['lukezhang', '陆克']]);
  const nameByHostname = new Map([
    ['allengao-pc', '高山'],
    ['desktop-q6vl93b', '王路峰'],
    ['luke-pc', '张朝刚'],
  ]);
  assert.equal(
    displayPresenceLabel(
      { username: 'lukezhang', hostname: 'LUKE-PC', label: 'lukezhang' },
      { aliasByUsername, nameByHostname },
    ),
    '陆克',
  );
  assert.equal(
    displayPresenceLabel(
      { username: null, hostname: 'allengao-pc', label: 'allengao-pc' },
      { aliasByUsername, nameByHostname },
    ),
    '高山',
  );
  assert.equal(
    displayPresenceLabel(
      { username: 'zephyrwang', hostname: 'DESKTOP-Q6VL93B', label: 'zephyrwang' },
      { aliasByUsername, nameByHostname },
    ),
    '王路峰',
  );
});

test('插件使用人签名与版本展示', async () => {
  const { loadAppConfig } = await import('../src/config.js');
  await loadAppConfig();
  const { signOperatorUsername, verifyOperatorUsername } = await import('../src/operator-proof.js');
  const proof = signOperatorUsername('张三');
  assert.equal(verifyOperatorUsername('张三', proof), true);
  assert.equal(verifyOperatorUsername('李四', proof), false);
  assert.equal(verifyOperatorUsername('张三', `${proof}x`), false);

  const {
    pluginClientView,
    recordPluginInstall,
    recordPluginReport,
    forgetPluginClient,
    listPluginClientViews,
  } = await import('../src/plugin-clients.js');
  assert.equal(
    pluginClientView({
      version: '0.2.8',
      build: 'new',
      installedAt: '2026-10-10T02:00:00.000Z',
      reportVersion: '0.2.7',
      reportedAt: '2026-10-10T01:00:00.000Z',
    }).version,
    '0.2.8',
  );
  assert.equal(
    pluginClientView({
      version: '0.2.7',
      installedAt: '2026-10-10T01:00:00.000Z',
      reportVersion: '0.2.8',
      reportBuild: 'run',
      reportedAt: '2026-10-10T02:00:00.000Z',
    }).build,
    'run',
  );

  const name = '__plugin_client_test__';
  await forgetPluginClient(name);
  const installed = await recordPluginInstall(name, { version: '0.2.8', build: 'abc' });
  assert.equal(installed.state, 'installed');
  assert.equal(installed.version, '0.2.8');
  const reported = await recordPluginReport(name, {
    version: '0.2.8',
    build: 'def',
    hostname: 'PC-1',
  });
  assert.equal(reported.state, 'reported');
  assert.equal(reported.hostname, 'PC-1');
  await recordPluginReport(name, { version: '<bad>', build: 'def' });
  const views = await listPluginClientViews();
  assert.equal(views[name].version, '0.2.8');
  await forgetPluginClient(name);
  const left = await listPluginClientViews();
  assert.equal(left[name], undefined);
});

test('注册申请状态：通过、拒绝、删除后的展示', async () => {
  const { applicationMessage, reconcileStatus } = await import('../src/applications.js');
  assert.equal(reconcileStatus('pending', { pending: true }), 'pending');
  assert.equal(reconcileStatus('pending', { pending: false, disabled: false }), 'approved');
  assert.equal(reconcileStatus('approved', { disabled: true }), 'disabled');
  assert.equal(reconcileStatus('pending', null), 'rejected');
  assert.equal(reconcileStatus('approved', null), 'removed');
  assert.match(applicationMessage('approved', '张三'), /张三/);
  assert.match(applicationMessage('approved', '张三'), /可以直接登录/);
});

test('app-log 日期键、账号标签与过期清理', async () => {
  const { mkdtemp, writeFile, readdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const pathMod = await import('node:path');
  const { logDateKey, memberLogLabel, pruneOldLogFiles } = await import('../src/app-log.js');

  assert.equal(logDateKey(new Date(2026, 8, 16)), '2026-09-16');

  const label = memberLogLabel({
    id: 'abc',
    displayName: '陈瑶',
    email: 'a@b.com',
    hostname: 'LUKE-PC',
  });
  assert.match(label, /陈瑶/);
  assert.match(label, /id=abc/);

  const dir = await mkdtemp(pathMod.join(tmpdir(), 'ctu-log-'));
  const oldDay = new Date(2020, 0, 15, 12, 0, 0, 0);
  const keepDay = new Date(2026, 8, 16, 12, 0, 0, 0);
  await writeFile(pathMod.join(dir, `${logDateKey(oldDay)}.log`), 'old\n', 'utf8');
  await writeFile(pathMod.join(dir, `${logDateKey(keepDay)}.log`), 'keep\n', 'utf8');
  await writeFile(pathMod.join(dir, 'ignore.txt'), 'x', 'utf8');

  const removed = await pruneOldLogFiles(30, keepDay, dir);
  assert.equal(removed, 1);
  const left = await readdir(dir);
  assert.ok(left.includes(`${logDateKey(keepDay)}.log`));
  assert.ok(!left.includes(`${logDateKey(oldDay)}.log`));
});

test('额度日历史：同步写入今天、凌晨归档昨天、日差与对比', () => {
  // 固定到 2026-10-12 12:00 本地，便于断言日键。
  const now = new Date(2026, 9, 12, 12, 0, 0, 0).getTime();
  const snap = {
    meters: { totalPercentUsed: 29.9, autoPercentUsed: 31.4, apiPercentUsed: 0 },
  };
  const todayHist = recordSyncPercents([], snap, now);
  assert.equal(todayHist.length, 1);
  assert.equal(todayHist[0].date, '2026-10-12');
  assert.equal(todayHist[0].total, 29.9);

  const withYesterday = archiveYesterdayPercents(
    [{ date: '2026-10-11', total: 24.9, auto: 26.1, api: 0 }],
    snap,
    now,
  );
  assert.equal(yesterdayDayKey(now), '2026-10-11');
  assert.equal(
    withYesterday.find((r) => r.date === '2026-10-11')?.total,
    29.9,
  );
  assert.equal(deltaVsYesterday(withYesterday, 'total', 29.9, now), 0);

  const hist = [
    { date: '2026-10-10', total: 20, auto: 21, api: 0 },
    { date: '2026-10-11', total: 24.9, auto: 26.1, api: 0 },
  ];
  assert.equal(deltaVsYesterday(hist, 'total', 29.9, now), 5);
  assert.deepEqual(dailyPercentDeltas(hist, 'total'), [
    { date: '2026-10-11', value: 4.9 },
  ]);
});
