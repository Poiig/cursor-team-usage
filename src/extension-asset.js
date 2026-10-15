/**
 * 容器内随镜像发布的 Reporter VSIX：部署构建号 + 运行时按 ACCESS_KEY / 看板地址注入。
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccessKey } from './config.js';
import { signOperatorUsername } from './operator-proof.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSET_DIR = path.join(ROOT, 'assets');
const BASE_VSIX = path.join(ASSET_DIR, 'reporter-base.vsix');
const BUILD_META = path.join(ASSET_DIR, 'extension-build.json');
const PATCH_PY = path.join(ROOT, 'scripts', 'patch_vsix.py');

/** @type {Map<string, { exp: number, apiBaseUrl: string, operatorUsername: string }>} */
const installTokens = new Map();

/**
 * 读取镜像构建时写入的扩展元数据。
 * @returns {Promise<{ version: string, build: string, builtAt: string | null, available: boolean }>}
 */
export async function getExtensionBuildMeta() {
  let version = '0.0.0';
  let build = 'local';
  let builtAt = null;
  try {
    const raw = JSON.parse(await readFile(BUILD_META, 'utf8'));
    version = String(raw.version || version);
    build = String(raw.build || build);
    builtAt = raw.builtAt ? String(raw.builtAt) : null;
  } catch {
    /* 本地 npm start 可能尚未打资产 */
  }
  // 兼容未跑 Docker 构建：尝试读 extension/package.json
  if (!existsSync(BASE_VSIX)) {
    try {
      const pkg = JSON.parse(
        await readFile(path.join(ROOT, 'extension', 'package.json'), 'utf8'),
      );
      version = String(pkg.version || version);
    } catch {
      /* ignore */
    }
  }
  return {
    version,
    build,
    builtAt,
    available: existsSync(BASE_VSIX),
  };
}

/**
 * @param {string} apiBaseUrl
 */
function normalizeApiBase(apiBaseUrl) {
  return String(apiBaseUrl || '')
    .trim()
    .replace(/\/+$/, '');
}

/**
 * 用 Python 把 secret 打进 VSIX 副本。
 * @param {{ apiBaseUrl: string, accessKey?: string | null, operatorUsername?: string | null, operatorProof?: string | null }} opts
 * @returns {Promise<{ buffer: Buffer, fileName: string, version: string, build: string }>}
 */
export async function buildPatchedVsix(opts) {
  const meta = await getExtensionBuildMeta();
  if (!meta.available) {
    const err = new Error(
      '镜像内未找到插件资产（reporter-base.vsix）。请使用含扩展构建步骤的 Docker 镜像，或在仓库根执行 npm run ext:asset',
    );
    err.status = 503;
    throw err;
  }
  const accessKey = (opts.accessKey != null ? opts.accessKey : getAccessKey()) || '';
  if (!accessKey) {
    const err = new Error('未配置 ACCESS_KEY，无法生成与看板一致的插件');
    err.status = 503;
    throw err;
  }
  const apiBaseUrl = normalizeApiBase(opts.apiBaseUrl);
  if (!/^https?:\/\//i.test(apiBaseUrl)) {
    const err = new Error('apiBaseUrl 须为 http(s) 地址');
    err.status = 400;
    throw err;
  }

  await mkdir(path.join(ROOT, 'data', 'builds'), { recursive: true });
  const tmpOut = path.join(
    os.tmpdir(),
    `ctu-reporter-${process.pid}-${Date.now()}.vsix`,
  );
  await runPythonPatch({
    src: BASE_VSIX,
    dst: tmpOut,
    accessKey,
    apiBaseUrl,
    operatorUsername: String(opts.operatorUsername || '').trim(),
    operatorProof:
      opts.operatorProof != null
        ? String(opts.operatorProof)
        : signOperatorUsername(opts.operatorUsername || ''),
    version: meta.version,
    build: meta.build,
  });
  try {
    const buffer = await readFile(tmpOut);
    const fileName = `cursor-team-usage-reporter-${meta.version}+${meta.build}.vsix`;
    return { buffer, fileName, version: meta.version, build: meta.build };
  } finally {
    await unlink(tmpOut).catch(() => {});
  }
}

/**
 * @param {{ src: string, dst: string, accessKey: string, apiBaseUrl: string, operatorUsername: string, operatorProof: string, version: string, build: string }} p
 */
function runPythonPatch(p) {
  const args = [
    PATCH_PY,
    p.src,
    p.dst,
    '--access-key',
    p.accessKey,
    '--api-base-url',
    p.apiBaseUrl,
    '--operator-username',
    p.operatorUsername,
    '--operator-proof',
    p.operatorProof,
    '--version',
    p.version,
    '--build',
    p.build,
  ];
  const bins =
    process.platform === 'win32'
      ? [
          ['py', ['-3', ...args]],
          ['python', args],
        ]
      : [
          ['python3', args],
          ['python', args],
        ];

  return (async () => {
    let lastErr;
    for (const [bin, a] of bins) {
      try {
        await spawnOk(bin, a);
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  })();
}

/** @param {string} cmd @param {string[]} args */
function spawnOk(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(stderr.trim() || `${cmd} exited ${code}`));
    });
  });
}

/**
 * 签发短时安装令牌（下载 VSIX / install.ps1 无需登录 Cookie）。
 * @param {string} apiBaseUrl
 * @param {string} operatorUsername
 * @param {number} [ttlSec]
 */
export function issueInstallToken(apiBaseUrl, operatorUsername, ttlSec = 600) {
  sweepInstallTokens();
  const token = randomBytes(24).toString('hex');
  installTokens.set(token, {
    exp: Date.now() + ttlSec * 1000,
    apiBaseUrl: normalizeApiBase(apiBaseUrl),
    operatorUsername: String(operatorUsername || '').trim(),
  });
  return token;
}

/** @param {string} token */
export function consumeInstallToken(token) {
  sweepInstallTokens();
  const row = installTokens.get(String(token || ''));
  if (!row) return null;
  if (row.exp <= Date.now()) {
    installTokens.delete(token);
    return null;
  }
  // VSIX 含上报密钥，首次下载后立即失效，避免安装链接被重放。
  installTokens.delete(String(token || ''));
  return row;
}

/**
 * 读取安装脚本需要的令牌，不消费它；实际下载 VSIX 时才使令牌失效。
 * @param {string} token
 */
export function getInstallToken(token) {
  sweepInstallTokens();
  const row = installTokens.get(String(token || ''));
  return row && row.exp > Date.now() ? row : null;
}

function sweepInstallTokens() {
  const now = Date.now();
  for (const [k, v] of installTokens) {
    if (v.exp <= now) installTokens.delete(k);
  }
}

/**
 * 生成 Windows 一键安装脚本（下载注入 secret 的 VSIX → cursor --install-extension → 启动 Cursor）。
 * @param {{ downloadUrl: string, version: string, build: string }} opts
 */
export function renderInstallPs1(opts) {
  const url = opts.downloadUrl.replace(/'/g, "''");
  return `# Cursor Team Usage Reporter 一键安装
# version ${opts.version} build ${opts.build}
$ErrorActionPreference = 'Stop'
$vsix = Join-Path $env:TEMP 'cursor-team-usage-reporter.vsix'
Write-Host "Download: ${url}"
Invoke-WebRequest -Uri '${url}' -OutFile $vsix -UseBasicParsing
if (-not (Test-Path -LiteralPath $vsix) -or (Get-Item -LiteralPath $vsix).Length -lt 1000) {
  throw "Download failed: $vsix"
}
$cli = Get-Command cursor -ErrorAction SilentlyContinue
if (-not $cli) { throw 'cursor CLI not found. Install Cursor and ensure cursor is on PATH.' }
Write-Host "Install: $($cli.Source)"
& $cli.Source --install-extension $vsix --force
if ($LASTEXITCODE -ne 0) { throw "Install failed ($LASTEXITCODE)" }
$exe = Join-Path $env:LOCALAPPDATA 'Programs\cursor\Cursor.exe'
if (Test-Path -LiteralPath $exe) { Start-Process -FilePath $exe }
elseif ($cli.Source -like '*.exe') { Start-Process -FilePath $cli.Source }
Write-Host 'Done. Developer: Reload Window if Cursor was already open.'
`;
}

/**
 * 插件 apiBaseUrl 只认 PUBLIC_BASE_URL，不用请求 Host（反代 / 本机打开时 Host 不是局域网地址）。
 * @returns {string}
 */
export function getConfiguredPublicBaseUrl() {
  const envUrl = String(process.env.PUBLIC_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  if (!envUrl) {
    const err = new Error(
      '未配置 PUBLIC_BASE_URL。请在 .env 填写看板对外地址，例如 http://192.168.100.104:3780，然后重启',
    );
    err.status = 503;
    throw err;
  }
  if (!/^https?:\/\//i.test(envUrl)) {
    const err = new Error('PUBLIC_BASE_URL 须为 http(s) 地址');
    err.status = 503;
    throw err;
  }
  return envUrl;
}

/** 内容指纹，便于缓存校验。 */
export function bufferEtag(buf) {
  return '"' + createHash('sha256').update(buf).digest('hex').slice(0, 16) + '"';
}
