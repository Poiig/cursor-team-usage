/**
 * 为全局 fetch 挂 HTTP(S) 代理。
 * Node 20 内置 fetch（undici）默认不读 HTTP_PROXY；需显式 setGlobalDispatcher。
 * 未配置代理时不改动，保持直连。
 */
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

/**
 * 若环境变量含代理则启用；返回当前生效说明供启动日志。
 * @returns {{ enabled: boolean, httpProxy?: string, httpsProxy?: string, noProxy?: string }}
 */
export function applyHttpProxyFromEnv() {
  const httpProxy = String(process.env.HTTP_PROXY || process.env.http_proxy || '').trim();
  const httpsProxy = String(process.env.HTTPS_PROXY || process.env.https_proxy || '').trim();
  const noProxy = String(process.env.NO_PROXY || process.env.no_proxy || '').trim();
  if (!httpProxy && !httpsProxy) {
    return { enabled: false };
  }
  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      httpProxy: httpProxy || undefined,
      httpsProxy: httpsProxy || httpProxy || undefined,
      noProxy: noProxy || undefined,
    }),
  );
  return {
    enabled: true,
    httpProxy: httpProxy || undefined,
    httpsProxy: httpsProxy || httpProxy || undefined,
    noProxy: noProxy || undefined,
  };
}
