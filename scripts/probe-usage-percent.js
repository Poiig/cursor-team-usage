/**
 * 探测 cursor.com usage-summary 与 api2 GetCurrentPeriodUsage 的真实字段，
 * 确认个人版百分比数据来源后再接入看板。
 */
import { resolveLocalCursorSession } from '../src/local-session.js';

const session = await resolveLocalCursorSession();
if (!session) {
  console.error('no local session');
  process.exit(1);
}

const jwt = session.cookieValue.split('%3A%3A')[1];
const headersBrowser = {
  Origin: 'https://cursor.com',
  Referer: 'https://cursor.com/dashboard',
  'User-Agent': 'cursor-team-usage-probe',
  Cookie: `WorkosCursorSessionToken=${session.cookieValue}`,
};

async function dump(label, res) {
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  console.log(`\n==== ${label} HTTP ${res.status} ====`);
  console.log(JSON.stringify(data, null, 2).slice(0, 4000));
}

await dump(
  'usage-summary',
  await fetch('https://cursor.com/api/usage-summary', { headers: headersBrowser }),
);

await dump(
  'GetCurrentPeriodUsage',
  await fetch('https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
    },
    body: '{}',
  }),
);
