import assert from 'node:assert/strict';
import test from 'node:test';

test('未配置代理时 applyHttpProxyFromEnv 不启用', async () => {
  const saved = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
    NO_PROXY: process.env.NO_PROXY,
  };
  for (const k of Object.keys(saved)) delete process.env[k];
  try {
    const { applyHttpProxyFromEnv } = await import('../src/http-proxy.js');
    assert.deepEqual(applyHttpProxyFromEnv(), { enabled: false });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('配置 HTTPS_PROXY 时启用并回显', async () => {
  const saved = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
    NO_PROXY: process.env.NO_PROXY,
  };
  for (const k of Object.keys(saved)) delete process.env[k];
  process.env.HTTPS_PROXY = 'http://192.168.100.200:3128';
  process.env.NO_PROXY = '127.0.0.1,localhost,192.168.6.39';
  try {
    const { applyHttpProxyFromEnv } = await import('../src/http-proxy.js');
    const info = applyHttpProxyFromEnv();
    assert.equal(info.enabled, true);
    assert.equal(info.httpsProxy, 'http://192.168.100.200:3128');
    assert.equal(info.noProxy, '127.0.0.1,localhost,192.168.6.39');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
