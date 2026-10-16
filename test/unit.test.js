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
  topModelsByTokens,
  usageKindLabel,
  usageCostLabel,
  eventTotalTokens,
  fetchMe,
  fetchUserRules,
  isTransientCursorError,
} from '../src/cursor-api.js';
import {
  archiveYesterdayPercents,
  dailyPercentDeltas,
  deltaVsYesterday,
  recordSyncPercents,
  yesterdayDayKey,
} from '../src/usage-percent-history.js';
import {
  USAGE_EVENTS_OVERLAP_MS,
  USAGE_EVENTS_RETENTION_DAYS,
  USAGE_EVENTS_STALE_MS,
  computeUsageEventsSyncWindow,
  normalizeUsageEventForStore,
  usageEventsNeedSync,
} from '../src/usage-events.js';
import {
  consumeInstallToken,
  getInstallToken,
  issueInstallToken,
  renderInstallSh,
} from '../src/extension-asset.js';

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

test('安装令牌仅允许下载 VSIX 一次', () => {
  const token = issueInstallToken('https://usage.example.com', 'alice');
  assert.equal(getInstallToken(token)?.operatorUsername, 'alice');
  assert.equal(consumeInstallToken(token)?.apiBaseUrl, 'https://usage.example.com');
  assert.equal(consumeInstallToken(token), null);
});

test('macOS 安装命令下载 VSIX 后自动寻找 Cursor CLI 并启动', () => {
  const command = renderInstallSh({
    downloadUrl: 'https://usage.example.com/api/extension/reporter.vsix?token=abc',
  });
  assert.match(command, /curl -fL 'https:\/\/usage\.example\.com\/api\/extension\/reporter\.vsix\?token=abc'/);
  assert.match(command, /command -v cursor/);
  assert.match(command, /\/Applications\/Cursor\.app\/Contents\/Resources\/app\/bin\/cursor/);
  assert.match(command, /"\$cli" --install-extension "\$vsix" --force/);
  assert.match(command, /open -a Cursor$/);
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
  assert.ok(Array.isArray(spend.todayModels));

  const todayKey = '2026-09-15';
  const byTokens = topModelsByTokens(
    [
      {
        timestamp: now,
        model: 'grok-bot-default',
        inputTokens: 5000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      {
        timestamp: now,
        model: 'default',
        inputTokens: 1000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      {
        timestamp: now,
        model: 'grok-bot-default',
        inputTokens: 2000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      {
        timestamp: now - 86400000,
        model: 'ignored-yesterday',
        inputTokens: 99999,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ],
    todayKey,
  );
  assert.equal(byTokens[0].model, 'grok-bot-default');
  assert.equal(byTokens[0].tokens, 7000);
  assert.equal(byTokens[1].model, 'default');
  assert.equal(byTokens[1].tokens, 1000);

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

test('isTransientCursorError 识别连接超时，排除会话失效', () => {
  assert.equal(
    isTransientCursorError({
      message: 'fetch failed (UND_ERR_CONNECT_TIMEOUT): https://cursor.com/api/auth/me',
    }),
    true,
  );
  assert.equal(isTransientCursorError({ message: '请求超时: https://cursor.com/api/auth/me', retryable: true }), true);
  assert.equal(isTransientCursorError({ status: 503 }), true);
  assert.equal(
    isTransientCursorError({ message: 'not_authenticated (HTTP 401): https://cursor.com/api/auth/me', status: 401 }),
    false,
  );
});

test('短暂同步失败有旧快照时不写 lastError，会话错误仍落红条', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const pathMod = await import('node:path');
  const dir = await mkdtemp(pathMod.join(tmpdir(), 'ctu-sync-'));
  const prevDriver = process.env.STORE_DRIVER;
  const prevSqlite = process.env.SQLITE_PATH;
  process.env.STORE_DRIVER = 'sqlite';
  process.env.SQLITE_PATH = pathMod.join(dir, 't.sqlite');
  try {
    await loadAppConfig();
    const store = await import('../src/store-sqlite.js');
    await store.close().catch(() => {});
    await store.init();
    const jwt =
      'eyJhbGciOiJub25lIn0.' +
      Buffer.from(JSON.stringify({ sub: 'auth0|user_sync' })).toString('base64url') +
      '.x';
    const added = await store.addMember({
      displayName: '补偿测',
      sessionToken: buildCookieValue('user_sync', jwt),
    });
    const syncedAt = '2026-10-16T00:00:00.000Z';
    await store.saveSyncResult(added.id, {
      snapshot: { email: 'a@x.com', syncedAt, meters: { totalPercentUsed: 10 } },
    });
    const kept = await store.saveSyncResult(added.id, {
      error: 'fetch failed (UND_ERR_CONNECT_TIMEOUT): https://cursor.com/api/auth/me',
      transient: true,
    });
    assert.equal(kept.lastError, null);
    const inner = await store.getMemberInternal(added.id);
    assert.equal(inner.lastSyncedAt, syncedAt);
    assert.equal(inner.lastSnapshot.email, 'a@x.com');

    const hard = await store.saveSyncResult(added.id, {
      error: 'not_authenticated (HTTP 401): https://cursor.com/api/auth/me',
    });
    assert.match(hard.lastError, /401/);
    await store.close();
  } finally {
    const store = await import('../src/store-sqlite.js');
    await store.close().catch(() => {});
    if (prevDriver === undefined) delete process.env.STORE_DRIVER;
    else process.env.STORE_DRIVER = prevDriver;
    if (prevSqlite === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prevSqlite;
    await rm(dir, { recursive: true, force: true });
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

test('fetchUserRules 用 Bearer JWT 调 KnowledgeBaseList 并映射字段', async () => {
  const realFetch = globalThis.fetch;
  const jwt = 'h.eyJzdWIiOiJhdXRoMHx1c2VyXzEyMyJ9.s';
  let seen;
  try {
    globalThis.fetch = async (url, init) => {
      seen = { url, auth: init.headers.Authorization };
      return new Response(
        JSON.stringify({
          success: true,
          allResults: [
            { id: '1', knowledge: '永远用中文', title: '中文', createdAt: '2026-10-15T05:43:51.014Z' },
            { id: 2, knowledge: '无标题' },
          ],
        }),
      );
    };
    const rules = await fetchUserRules(buildCookieValue('user_123', jwt));
    assert.equal(seen.url, 'https://api2.cursor.sh/aiserver.v1.AiService/KnowledgeBaseList');
    assert.equal(seen.auth, `Bearer ${jwt}`);
    assert.deepEqual(rules, [
      { id: '1', title: '中文', content: '永远用中文', createdAt: '2026-10-15T05:43:51.014Z' },
      { id: '2', title: '', content: '无标题', createdAt: null },
    ]);

    globalThis.fetch = async () => new Response(JSON.stringify({ success: true }));
    assert.deepEqual(await fetchUserRules(buildCookieValue('user_123', jwt)), []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('切换日志：领取后久无回报、未领取票据丢失时判定为卡住', async () => {
  const { staleSwitchReason, CLAIMED_STALE_MS, PENDING_STALE_MS } = await import(
    '../src/account-switch.js'
  );
  const now = Date.parse('2026-10-15T06:30:00Z');
  const ago = (ms) => new Date(now - ms).toISOString();

  assert.match(
    staleSwitchReason({ status: 'claimed', claimedAt: ago(CLAIMED_STALE_MS + 1000) }, now),
    /未回报/,
  );
  assert.equal(staleSwitchReason({ status: 'claimed', claimedAt: ago(60_000) }, now), null);
  assert.match(
    staleSwitchReason({ status: 'pending', createdAt: ago(PENDING_STALE_MS + 1000) }, now),
    /失效/,
  );
  assert.equal(staleSwitchReason({ status: 'pending', createdAt: ago(60_000) }, now), null);
  assert.equal(
    staleSwitchReason({ status: 'success', claimedAt: ago(CLAIMED_STALE_MS * 10) }, now),
    null,
  );
});

test('renderMarkdown 渲染规则常见块且转义原始 HTML', async () => {
  const { renderMarkdown } = await import('../public/shared.js');
  const html = renderMarkdown(
    [
      '## 标题',
      '- **纯 HTML**：用 `<p>`',
      '- 第二项 [文档](https://example.com)',
      '',
      '| type | 用途 |',
      '|---|---|',
      '| `fix` | 修复 |',
      '',
      '<p><b>根因</b></p>',
      '```',
      'a < b',
      '```',
    ].join('\n'),
  );
  assert.match(html, /<h2>标题<\/h2>/);
  assert.match(html, /<li><strong>纯 HTML<\/strong>：用 <code>&lt;p&gt;<\/code><\/li>/);
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noreferrer">文档<\/a>/);
  assert.match(html, /<th>type<\/th><th>用途<\/th>/);
  assert.match(html, /<td><code>fix<\/code><\/td>/);
  assert.match(html, /<p>&lt;p&gt;&lt;b&gt;根因&lt;\/b&gt;&lt;\/p&gt;<\/p>/);
  assert.match(html, /<pre><code>a &lt; b<\/code><\/pre>/);
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

test('pickHomeMemberByHostname 按首次上报主机名取最早一条', async () => {
  const { pickHomeMemberByHostname } = await import('../src/account-switch.js');
  const members = [
    { id: 'b', hostname: 'PC-A', createdAt: '2026-02-01T00:00:00.000Z' },
    { id: 'a', hostname: 'PC-A', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'c', hostname: 'PC-B', createdAt: '2026-01-02T00:00:00.000Z' },
  ];
  assert.equal(pickHomeMemberByHostname(members, 'pc-a')?.id, 'a');
  assert.equal(pickHomeMemberByHostname(members, 'PC-B')?.id, 'c');
  assert.equal(pickHomeMemberByHostname(members, 'missing'), null);
  assert.equal(pickHomeMemberByHostname(members, ''), null);
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
    guideCompleted: false,
  });
  assert.equal(pub.username, 'u1');
  assert.equal(pub.role, 'user');
  assert.equal(pub.pending, true);
  assert.equal(pub.guideCompleted, false);
  assert.equal('passwordHash' in pub, false);
});

test('用户完成引导后持久化状态', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const pathMod = await import('node:path');
  const dir = await mkdtemp(pathMod.join(tmpdir(), 'ctu-guide-'));
  const prevDriver = process.env.STORE_DRIVER;
  const prevSqlite = process.env.SQLITE_PATH;
  process.env.STORE_DRIVER = 'sqlite';
  process.env.SQLITE_PATH = pathMod.join(dir, 'guide.sqlite');
  try {
    await loadAppConfig();
    const sqlite = await import('../src/store-sqlite.js');
    await sqlite.close().catch(() => {});
    const store = await import('../src/store.js');
    await store.initStore();
    const { completeGuideFor, getPublicUser, initUsers } = await import('../src/users.js');
    await initUsers();
    assert.equal((await getPublicUser('admin'))?.guideCompleted, false);
    await completeGuideFor('admin');
    assert.equal((await getPublicUser('admin'))?.guideCompleted, true);
    await sqlite.close();
    await store.initStore();
    assert.equal((await getPublicUser('admin'))?.guideCompleted, true);
  } finally {
    const sqlite = await import('../src/store-sqlite.js');
    await sqlite.close().catch(() => {});
    if (prevDriver === undefined) delete process.env.STORE_DRIVER;
    else process.env.STORE_DRIVER = prevDriver;
    if (prevSqlite === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prevSqlite;
    await rm(dir, { recursive: true, force: true });
  }
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

test('人员详情：别名匹配相关号池账号', async () => {
  const { relatedPoolMembersForPerson } = await import('../src/people.js');
  const related = relatedPoolMembersForPerson(
    { alias: '王路峰' },
    [
      { id: 'a', displayName: '王路峰', email: 'a@x.com', hostname: 'PC-A' },
      { id: 'b', displayName: '宋文杰', email: 'b@x.com' },
    ],
  );
  assert.equal(related.length, 1);
  assert.equal(related[0].id, 'a');
  assert.deepEqual(relatedPoolMembersForPerson({ alias: '' }, [{ id: 'a', displayName: '王路峰' }]), []);
});

test('人员详情：无痕迹时 404；有上报则返回聚合', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const pathMod = await import('node:path');
  const dir = await mkdtemp(pathMod.join(tmpdir(), 'ctu-people-'));
  const prevDriver = process.env.STORE_DRIVER;
  const prevSqlite = process.env.SQLITE_PATH;
  process.env.STORE_DRIVER = 'sqlite';
  process.env.SQLITE_PATH = pathMod.join(dir, 't.sqlite');
  try {
    await loadAppConfig();
    const sqlite = await import('../src/store-sqlite.js');
    await sqlite.close().catch(() => {});
    const store = await import('../src/store.js');
    await store.initStore();
    const { initUsers } = await import('../src/users.js');
    await initUsers();
    const { recordReportEvent } = await import('../src/report-log.js');
    const { getPersonDetail } = await import('../src/people.js');

    await assert.rejects(() => getPersonDetail('nobody_here'), /不存在/);

    await recordReportEvent({
      operatorUsername: 'alice',
      memberId: 'm1',
      memberDisplayName: '甲',
      hostname: 'PC-A',
      ok: true,
    });
    const detail = await getPersonDetail('alice');
    assert.equal(detail.username, 'alice');
    assert.equal(detail.reports.length, 1);
    assert.equal(detail.reports[0].memberDisplayName, '甲');
  } finally {
    const sqlite = await import('../src/store-sqlite.js');
    await sqlite.close().catch(() => {});
    if (prevDriver === undefined) delete process.env.STORE_DRIVER;
    else process.env.STORE_DRIVER = prevDriver;
    if (prevSqlite === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prevSqlite;
    await rm(dir, { recursive: true, force: true });
  }
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
    'zephyrwang',
  );
});

test('使用人席位：上报粘性占有，不因断报清空；可手动移除', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const pathMod = await import('node:path');
  const dir = await mkdtemp(pathMod.join(tmpdir(), 'ctu-presence-'));
  const prevDriver = process.env.STORE_DRIVER;
  const prevSqlite = process.env.SQLITE_PATH;
  process.env.STORE_DRIVER = 'sqlite';
  process.env.SQLITE_PATH = pathMod.join(dir, 't.sqlite');
  const presence = await import('../src/account-presence.js');
  try {
    await loadAppConfig();
    const sqlite = await import('../src/store-sqlite.js');
    await sqlite.close().catch(() => {});
    const store = await import('../src/store.js');
    await store.initStore();
    presence.resetPresenceCacheForTests();

    const member = { id: 'm1', planName: 'Pro', displayName: '甲' };
    await presence.recordAccountPresence({
      memberId: 'm1',
      memberDisplayName: '甲',
      hostname: 'PC-A',
      username: 'alice',
    });
    // 伪造「过夜」：把 lastSeenAt 改到 10 小时前，席位仍应保留
    const map = await store.loadAccountPresenceMap();
    map['pc-a'].lastSeenAt = new Date(Date.now() - 10 * 3600 * 1000).toISOString();
    await store.saveAccountPresenceMap(map);
    presence.resetPresenceCacheForTests();

    const cap = await presence.getMemberCapacity(member);
    assert.equal(cap.activeUserCount, 1);
    assert.equal(cap.activeUsers[0].hostname, 'PC-A');
    assert.equal(cap.maxUsers, 3);

    // 上报切到另一账号时，旧号席位让出
    await presence.recordAccountPresence({
      memberId: 'm2',
      memberDisplayName: '乙',
      hostname: 'PC-A',
      username: 'alice',
    });
    presence.resetPresenceCacheForTests();
    assert.equal((await presence.getMemberCapacity(member)).activeUserCount, 0);
    assert.equal(
      (await presence.getMemberCapacity({ id: 'm2', planName: 'Pro' })).activeUserCount,
      1,
    );

    const removed = await presence.removeMemberPresence('m2', 'PC-A');
    assert.equal(removed, true);
    assert.equal(
      (await presence.getMemberCapacity({ id: 'm2', planName: 'Pro' })).activeUserCount,
      0,
    );
    assert.equal(await presence.removeMemberPresence('m2', 'PC-A'), false);
  } finally {
    presence.resetPresenceCacheForTests();
    const sqlite = await import('../src/store-sqlite.js');
    await sqlite.close().catch(() => {});
    if (prevDriver === undefined) delete process.env.STORE_DRIVER;
    else process.env.STORE_DRIVER = prevDriver;
    if (prevSqlite === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prevSqlite;
    await rm(dir, { recursive: true, force: true });
  }
});

test('插件使用人签名与版本展示', async () => {
  const { loadAppConfig } = await import('../src/config.js');
  await loadAppConfig();
  const { signOperatorUsername, verifyOperatorUsername } = await import('../src/operator-proof.js');
  const proof = signOperatorUsername('张三');
  assert.equal(verifyOperatorUsername('张三', proof), true);
  assert.equal(verifyOperatorUsername('李四', proof), false);
  assert.equal(verifyOperatorUsername('张三', `${proof}x`), false);

  const { initStore } = await import('../src/store.js');
  await initStore();
  const {
    pluginClientView,
    isPluginOnline,
    PLUGIN_ONLINE_MS,
    recordPluginInstall,
    recordPluginReport,
    recordPluginHeartbeat,
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
  const now = Date.parse('2026-10-15T12:00:00.000Z');
  assert.equal(isPluginOnline(new Date(now - PLUGIN_ONLINE_MS + 1000).toISOString(), now), true);
  assert.equal(isPluginOnline(new Date(now - PLUGIN_ONLINE_MS - 1000).toISOString(), now), false);
  assert.equal(isPluginOnline(null, now), false);
  assert.equal(
    pluginClientView({
      version: '0.2.8',
      installedAt: '2026-10-15T11:00:00.000Z',
      reportedAt: '2026-10-15T11:50:00.000Z',
    }).online,
    false,
  );
  assert.equal(
    pluginClientView({
      version: '0.2.8',
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    }).online,
    true,
  );

  const name = '__plugin_client_test__';
  await forgetPluginClient(name);
  const installed = await recordPluginInstall(name, { version: '0.2.8', build: 'abc' });
  assert.equal(installed.state, 'installed');
  assert.equal(installed.version, '0.2.8');
  assert.equal(installed.online, false);
  const beat = await recordPluginHeartbeat(name, { version: '0.2.8', hostname: 'PC-HB' });
  assert.equal(beat?.online, true);
  assert.equal(beat?.hostname, 'PC-HB');
  const reported = await recordPluginReport(name, {
    version: '0.2.8',
    build: 'def',
    hostname: 'PC-1',
  });
  assert.equal(reported.state, 'reported');
  assert.equal(reported.hostname, 'PC-1');
  assert.equal(reported.online, true);
  assert.ok(reported.heartbeatAt);
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

test('usage events 增量窗口与过期判断', () => {
  const now = Date.parse('2026-10-14T12:00:00+08:00');
  const empty = computeUsageEventsSyncWindow(null, now);
  assert.equal(empty.endMs, now);
  assert.equal(empty.startMs, now - USAGE_EVENTS_RETENTION_DAYS * 86400000);

  const wm = now - 3 * 86400000;
  const incr = computeUsageEventsSyncWindow(wm, now);
  assert.equal(incr.startMs, wm - USAGE_EVENTS_OVERLAP_MS);

  assert.equal(usageEventsNeedSync({ count: 0 }, now), true);
  assert.equal(usageEventsNeedSync({ count: 10, syncedAt: null }, now), true);
  assert.equal(
    usageEventsNeedSync(
      { count: 10, syncedAt: new Date(now - USAGE_EVENTS_STALE_MS - 1).toISOString() },
      now,
    ),
    true,
  );
  assert.equal(
    usageEventsNeedSync(
      { count: 10, syncedAt: new Date(now - 60_000).toISOString() },
      now,
    ),
    false,
  );

  const row = normalizeUsageEventForStore({
    id: 'e1',
    timestamp: Math.floor(now / 1000),
    model: 'grok',
    kind: 'USAGE_EVENT_KIND_INCLUDED',
    kindLabel: 'Included',
    isTokenBasedCall: true,
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    totalTokens: 12,
    costLabel: 'Included',
    // 官方偶发小数 cents，落库须取整以免 PG INTEGER 报错。
    chargedCents: 209.52439880371094,
    tokenCents: '41.77399826049805',
  });
  assert.equal(row.eventId, 'e1');
  assert.equal(row.tsMs, now);
  assert.equal(row.totalTokens, 12);
  assert.equal(row.chargedCents, 210);
  assert.equal(row.tokenCents, 42);
});

test('usageEventsRangeStartMs 按本地自然日含今天', async () => {
  const { usageEventsRangeStartMs, localDayStartMs } = await import('../src/usage-events.js');
  const now = Date.parse('2026-10-14T12:12:00+08:00');
  const todayStart = localDayStartMs(now);
  assert.equal(usageEventsRangeStartMs(1, now), todayStart);
  assert.equal(usageEventsRangeStartMs(7, now), todayStart - 6 * 86400000);
});

test('sqlite usage_events upsert 去重、model 筛选与分页', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const pathMod = await import('node:path');
  const dir = await mkdtemp(pathMod.join(tmpdir(), 'ctu-ev-'));
  const prevDriver = process.env.STORE_DRIVER;
  const prevSqlite = process.env.SQLITE_PATH;
  process.env.STORE_DRIVER = 'sqlite';
  process.env.SQLITE_PATH = pathMod.join(dir, 't.sqlite');
  try {
    await loadAppConfig();
    const store = await import('../src/store-sqlite.js');
    await store.close().catch(() => {});
    await store.init();

    const now = Date.parse('2026-10-14T12:00:00+08:00');
    const memberId = 'm-test';
    const mk = (id, model, hoursAgo, tokens) => ({
      id,
      timestamp: now - hoursAgo * 3600000,
      model,
      kind: 'k',
      kindLabel: 'Included',
      isTokenBasedCall: true,
      inputTokens: tokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: tokens,
      costLabel: 'Included',
    });

    await store.upsertUsageEvents(memberId, [
      mk('a', 'default', 1, 100),
      mk('b', 'grok', 2, 200),
      mk('a', 'default', 1, 150), // 同 id 覆盖
      mk('c', 'grok', 3, 50),
      mk('d', 'composer', 40 * 24, 999), // 超出 7 天窗口
    ]);

    const wm = await store.getUsageEventsWatermark(memberId);
    assert.equal(wm, now - 3600000);

    const page1 = await store.listUsageEvents(memberId, {
      days: 7,
      page: 1,
      pageSize: 10,
      nowMs: now,
    });
    assert.equal(page1.total, 3);
    assert.equal(page1.events.length, 3);
    assert.equal(page1.hasNext, false);
    assert.equal(page1.events[0].id, 'a');
    assert.equal(page1.events[0].totalTokens, 150);
    assert.ok(page1.models.includes('default'));
    assert.ok(page1.models.includes('grok'));

    const grok = await store.listUsageEvents(memberId, {
      days: 7,
      model: 'grok',
      page: 1,
      pageSize: 50,
      nowMs: now,
    });
    assert.equal(grok.total, 2);
    assert.equal(grok.events.every((e) => e.model === 'grok'), true);

    // 凑满超过一页，验证 hasNext。
    const more = [];
    for (let i = 0; i < 12; i++) {
      more.push(mk(`x${i}`, 'default', 4, 1));
    }
    await store.upsertUsageEvents(memberId, more);
    const paged = await store.listUsageEvents(memberId, {
      days: 7,
      model: 'default',
      page: 1,
      pageSize: 10,
      nowMs: now,
    });
    assert.equal(paged.total, 13);
    assert.equal(paged.events.length, 10);
    assert.equal(paged.hasNext, true);

    // days=1：仅今天（本地 0 点起）；今日内事件计入，40 天前的 d 不计。
    const { localDayStartMs } = await import('../src/usage-events.js');
    const dayStart = localDayStartMs(now);
    const todayOnly = await store.listUsageEvents(memberId, {
      days: 1,
      page: 1,
      pageSize: 50,
      nowMs: now,
    });
    assert.ok(todayOnly.total >= 1);
    assert.ok(todayOnly.events.every((e) => e.timestamp >= dayStart));
    assert.ok(!todayOnly.events.some((e) => e.id === 'd'));

    await store.close();
  } finally {
    if (prevDriver == null) delete process.env.STORE_DRIVER;
    else process.env.STORE_DRIVER = prevDriver;
    if (prevSqlite == null) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prevSqlite;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('成员来源归一化与操作者别名展示', async () => {
  const {
    normalizeMemberSource,
    isManualMemberSource,
    MEMBER_SOURCE_MANUAL,
  } = await import('../src/store-member-fields.js');
  assert.equal(normalizeMemberSource('manual'), 'manual');
  assert.equal(normalizeMemberSource(null), 'report');
  assert.equal(isManualMemberSource(MEMBER_SOURCE_MANUAL), true);
  assert.equal(isManualMemberSource('report'), false);

  const { formatOperatorLabel } = await import('../public/shared.js');
  assert.equal(formatOperatorLabel('chenyao', '陈瑶'), 'chenyao（陈瑶）');
  assert.equal(formatOperatorLabel('chenyao', ''), 'chenyao');
});

test('邮箱登录：解析 AuthKit 页、auth code 与会话 Cookie', async () => {
  const {
    parseAuthKitPage,
    extractAuthCode,
    extractSessionTokenFromSetCookie,
    isCloudflareChallenge,
    buildMultipartBody,
    buildAuthKitState,
  } = await import('../src/cursor-email-login.js');

  const actionId = '409dfdd69397fa9f326db3612977e0aa51bada7cdb';
  const html = [
    '<input type="hidden" name="authorization_session_id" value="01SESSION"/>',
    '<input type="hidden" name="redirect_uri" value="https://cursor.com/api/auth/callback"/>',
    '<input type="hidden" name="state" value="%7B%22nonce%22%3A%22x%22%7D"/>',
    `20:{"id":"${actionId}","bound":null}`,
    'signInAction\\":\\"$h20\\"',
    '"magic_codes":true',
    'name="password"',
  ].join('\n');

  const parsed = parseAuthKitPage(html);
  assert.equal(parsed.authorizationSessionId, '01SESSION');
  assert.equal(parsed.redirectUri, 'https://cursor.com/api/auth/callback');
  assert.equal(parsed.state, '%7B%22nonce%22%3A%22x%22%7D');
  assert.equal(parsed.signInActionId, actionId);
  assert.equal(parsed.hasMagicCodes, true);
  assert.equal(parsed.isPasswordStep, true);

  assert.equal(
    extractAuthCode('https://cursor.com/api/auth/callback?code=abc_DEF-12&state=x'),
    'abc_DEF-12',
  );
  assert.equal(extractAuthCode('no code here'), null);

  const rawCookie =
    'WorkosCursorSessionToken=user_01%3A%3AeyJhbGciOiJIUzI1NiJ9.e30.x; Path=/; HttpOnly';
  const token = extractSessionTokenFromSetCookie([rawCookie]);
  assert.ok(token);
  assert.equal(normalizeManualToken(token), 'user_01%3A%3AeyJhbGciOiJIUzI1NiJ9.e30.x');

  assert.equal(isCloudflareChallenge('<title>Just a moment...</title>'), true);
  assert.equal(isCloudflareChallenge('<html>Sign in</html>'), false);

  const body = buildMultipartBody({ email: 'a@b.com', code: '123456' }, '----BOUND');
  assert.match(body, /name="email"\r\n\r\na@b.com\r\n/);
  assert.match(body, /name="code"\r\n\r\n123456\r\n/);
  assert.match(body, /----BOUND--/);

  const state = buildAuthKitState('nonce-test');
  assert.match(state, /returnTo/);
  assert.match(decodeURIComponent(decodeURIComponent(state)), /nonce-test/);
});

test('wecom expiring notify: filter and body', async () => {
  const {
    buildExpiringNotifyText,
    daysUntilReset,
    isExpiringSwitchableMember,
    msUntilNextLocalTime,
    resolveWecomWebhookUrl,
  } = await import('../src/notify.js');

  assert.equal(
    resolveWecomWebhookUrl('5b0e5d10-f9c3-47bd-ac21-f41c8c002aea'),
    'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=5b0e5d10-f9c3-47bd-ac21-f41c8c002aea',
  );
  assert.equal(
    resolveWecomWebhookUrl('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc'),
    'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc',
  );

  const now = Date.parse('2026-10-14T08:00:00+08:00');
  const resetSoon = new Date(now + 3 * 86400000).toISOString();
  const ok = {
    id: '1',
    displayName: 'expiring-ok',
    totalPercentUsed: 40,
    lastSnapshot: { window: { resetIso: resetSoon }, meters: { totalPercentUsed: 40 } },
  };
  const full = {
    id: '2',
    displayName: 'used-up',
    totalPercentUsed: 100,
    lastSnapshot: { window: { resetIso: resetSoon }, meters: { totalPercentUsed: 100 } },
  };
  const far = {
    id: '3',
    displayName: 'far-reset',
    totalPercentUsed: 20,
    lastSnapshot: {
      window: { resetIso: new Date(now + 30 * 86400000).toISOString() },
      meters: { totalPercentUsed: 20 },
    },
  };
  assert.equal(daysUntilReset(resetSoon, now), 3);
  assert.equal(isExpiringSwitchableMember(ok, now), true);
  assert.equal(isExpiringSwitchableMember(full, now), false);
  assert.equal(isExpiringSwitchableMember(far, now), false);

  const built = buildExpiringNotifyText({
    members: [ok, full, far],
    panelUrl: 'http://192.168.1.1:3780/',
    nowMs: now,
  });
  assert.equal(built.count, 1);
  assert.doesNotMatch(built.text, /expiring-ok/);
  assert.match(built.text, /剩余 60%/);
  assert.match(built.text, /http:\/\/192\.168\.1\.1:3780/);
  assert.match(built.text, /Cursor Team Usage/);

  const delay = msUntilNextLocalTime(9, 30, Date.parse('2026-10-14T08:00:00'));
  assert.ok(delay > 0 && delay < 2 * 3600 * 1000);
});

test('上个账单周期：窗口、收尾使用率留存与按模型汇总', async () => {
  const {
    carryCycleHistory,
    previousCycleFinalPercents,
    previousCycleWindow,
    summarizeCycleEvents,
  } = await import('../src/billing-cycle.js');

  const cur = { window: { startIso: '2026-10-18T08:43:00.000Z', endIso: '2026-11-18T08:43:00.000Z' } };
  const win = previousCycleWindow(cur);
  assert.equal(new Date(win.startMs).toISOString(), '2026-09-18T08:43:00.000Z');
  assert.equal(new Date(win.endMs).toISOString(), '2026-10-18T08:43:00.000Z');
  assert.equal(previousCycleWindow({}), null);

  const prev = {
    window: { startIso: '2026-09-18T08:43:00.000Z', endIso: '2026-10-18T08:43:00.000Z' },
    meters: { totalPercentUsed: 97.5, autoPercentUsed: 80, apiPercentUsed: 99 },
    syncedAt: '2026-10-18T08:30:00.000Z',
  };
  const same = carryCycleHistory(prev, { window: { ...prev.window } });
  assert.deepEqual(same.cycleHistory, []);
  const next = carryCycleHistory(prev, { ...cur });
  assert.equal(next.cycleHistory.length, 1);
  assert.equal(next.cycleHistory[0].total, 97.5);

  const exact = previousCycleFinalPercents({ lastSnapshot: next }, win);
  assert.equal(exact.approximate, false);
  assert.equal(exact.api, 99);
  const approx = previousCycleFinalPercents(
    {
      lastSnapshot: cur,
      usagePercentHistory: [
        { date: '2026-10-16', total: 90, auto: 70, api: 95 },
        { date: '2026-10-17', total: 96, auto: 79, api: 98 },
        { date: '2026-10-18', total: 2, auto: 1, api: 3 },
      ],
    },
    win,
  );
  assert.equal(approx.approximate, true);
  assert.equal(approx.total, 96);

  const t = Date.parse('2026-10-01T04:00:00Z');
  const s = summarizeCycleEvents([
    { timestamp: t, model: 'auto', inputTokens: 100, outputTokens: 0, tokenCents: 10 },
    { timestamp: t, model: 'claude-4.5-sonnet', inputTokens: 300, outputTokens: 0, chargedCents: 30 },
    { timestamp: t + 1000, model: 'claude-4.5-sonnet', inputTokens: 600, outputTokens: 0, tokenCents: 60 },
  ]);
  assert.equal(s.totals.requests, 3);
  assert.equal(s.totals.totalTokens, 1000);
  assert.equal(s.totals.dollars, 1);
  assert.equal(s.totals.billedDollars, 0.3);
  assert.equal(s.models[0].model, 'claude-4.5-sonnet');
  assert.equal(s.models[0].tokenShare, 90);
  assert.equal(s.groups.cursor.requests, 1);
  assert.equal(s.groups.other.tokenShare, 90);
  assert.equal(s.daily.length, 1);
});

test('上个账单周期：拉全后落库，同周期再进不请求 Cursor；刚结束不落库', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const pathMod = await import('node:path');
  const dir = await mkdtemp(pathMod.join(tmpdir(), 'ctu-prev-'));
  const prevDriver = process.env.STORE_DRIVER;
  const prevSqlite = process.env.SQLITE_PATH;
  process.env.STORE_DRIVER = 'sqlite';
  process.env.SQLITE_PATH = pathMod.join(dir, 't.sqlite');
  const realFetch = globalThis.fetch;
  try {
    await loadAppConfig();
    const sqlite = await import('../src/store-sqlite.js');
    await sqlite.close().catch(() => {});
    const store = await import('../src/store.js');
    await store.initStore();
    const { loadPreviousCycle } = await import('../src/usage-events-sync.js');

    const added = await store.addMember({
      displayName: '甲',
      sessionToken: buildCookieValue('user_prev', 'h.eyJzdWIiOiJhdXRoMHx1c2VyX3ByZXYifQ.s'),
    });
    const lastSnapshot = { window: { startIso: '2026-10-18T08:43:00.000Z' } };
    const cycleEnd = Date.parse(lastSnapshot.window.startIso);
    const load = async (nowMs) =>
      loadPreviousCycle({ ...(await store.getMemberInternal(added.id)), lastSnapshot }, { nowMs });

    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(
        JSON.stringify({
          usageEventsDisplay: [{ id: 'e1', timestamp: cycleEnd - 86400000, model: 'auto', tokenUsage: { inputTokens: 10 } }],
          totalUsageEventsCount: 1,
        }),
      );
    };

    const fresh = await load(cycleEnd + 10 * 60 * 1000);
    assert.equal(fresh.source, 'cursor');
    assert.equal((await store.getMemberInternal(added.id)).prevCycleSummary, null);

    const first = await load(cycleEnd + 2 * 3600 * 1000);
    assert.equal(first.source, 'cursor');
    assert.equal(first.totals.requests, 1);
    const callsAfterStore = calls;

    globalThis.fetch = async () => {
      throw new Error('不应再请求 Cursor');
    };
    const second = await load(cycleEnd + 3 * 3600 * 1000);
    assert.equal(calls, callsAfterStore);
    assert.equal(second.source, 'stored');
    assert.equal(second.totals.requests, 1);
    assert.ok(second.storedAt);
  } finally {
    globalThis.fetch = realFetch;
    const sqlite = await import('../src/store-sqlite.js');
    await sqlite.close().catch(() => {});
    if (prevDriver === undefined) delete process.env.STORE_DRIVER;
    else process.env.STORE_DRIVER = prevDriver;
    if (prevSqlite === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prevSqlite;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

