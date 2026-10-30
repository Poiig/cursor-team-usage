/**
 * 从看板下载已注入 secret 的 VSIX，并用宿主 API 安装（供本地桥一键安装 / 检查更新）。
 */

import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import * as vscode from 'vscode';
import { OperatorProofError, readReporterConfig } from './reporter';

export type ExtensionBuildMeta = {
  version: string;
  build: string;
  builtAt?: string | null;
  available?: boolean;
};

/**
 * 读扩展包内版本。更新判断只用 version，build 只是同号副本，避免每次构建都被当成新版本。
 */
export async function readLocalBuildInfo(
  extensionPath: string,
): Promise<ExtensionBuildMeta> {
  let packageVersion = '0.0.0';
  let packageBuild = 'dev';
  try {
    const pkgUri = vscode.Uri.file(path.join(extensionPath, 'package.json'));
    const raw = await vscode.workspace.fs.readFile(pkgUri);
    const pkg = JSON.parse(Buffer.from(raw).toString('utf8')) as {
      version?: string;
      ctuBuild?: string;
    };
    packageVersion = String(pkg.version || packageVersion);
    packageBuild = String(pkg.ctuBuild || packageBuild);
  } catch {
    /* use defaults */
  }

  const tryPaths = [
    path.join(extensionPath, 'build-info.json'),
    path.join(extensionPath, 'extension', 'build-info.json'),
  ];
  for (const p of tryPaths) {
    try {
      const uri = vscode.Uri.file(p);
      const raw = await vscode.workspace.fs.readFile(uri);
      const j = JSON.parse(Buffer.from(raw).toString('utf8')) as ExtensionBuildMeta;
      if (j?.build) {
        return {
          version: String(j.version || packageVersion),
          build: String(j.build),
          builtAt: j.builtAt ?? null,
        };
      }
    } catch {
      /* next */
    }
  }
  return { version: packageVersion, build: packageBuild };
}

/**
 * 拉取看板发布的扩展元数据。
 */
export async function fetchRemoteBuildMeta(
  apiBaseUrl: string,
): Promise<ExtensionBuildMeta> {
  const res = await fetch(`${apiBaseUrl.replace(/\/+$/, '')}/api/extension/meta`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`检查更新失败 HTTP ${res.status}`);
  }
  const j = (await res.json()) as ExtensionBuildMeta & { ok?: boolean };
  return {
    version: String(j.version || '0.0.0'),
    build: String(j.build || ''),
    builtAt: j.builtAt ?? null,
    available: j.available,
  };
}

/**
 * 下载 VSIX 到临时目录并调用宿主安装扩展。
 * @param vsixUrl 完整下载 URL（可带安装令牌）
 * @param headers 可选 Header（Access Key 自更新）
 */
export async function downloadAndInstallVsix(
  vsixUrl: string,
  headers?: Record<string, string>,
): Promise<void> {
  const res = await fetch(vsixUrl, { headers, signal: AbortSignal.timeout(180_000) });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    const msg = data.error || `下载插件失败 HTTP ${res.status}`;
    throw data.code === 'OPERATOR_PROOF' ? new OperatorProofError(msg) : new Error(msg);
  }
  const dir = path.join(tmpdir(), 'ctu-reporter-install');
  await mkdir(dir, { recursive: true });
  const vsixPath = path.join(dir, `reporter-${Date.now()}.vsix`);
  const nodeStream = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
  await pipeline(nodeStream, createWriteStream(vsixPath));
  try {
    const uri = vscode.Uri.file(vsixPath);
    await vscode.commands.executeCommand('workbench.extensions.installExtension', uri);
  } finally {
    await unlink(vsixPath).catch(() => {});
  }
}

/**
 * 用已配置的 Access Key 从看板拉取并安装最新插件。
 */
export async function installFromBoardWithAccessKey(): Promise<ExtensionBuildMeta> {
  const config = readReporterConfig();
  if (!config.accessKey) {
    throw new Error('未配置 accessKey，无法从看板拉取插件');
  }
  if (!config.apiBaseUrl) {
    throw new Error('未配置 apiBaseUrl');
  }
  const meta = await fetchRemoteBuildMeta(config.apiBaseUrl);
  if (meta.available === false) {
    throw new Error('看板镜像未附带插件资产');
  }
  const url = `${config.apiBaseUrl}/api/agent/extension/vsix`;
  await downloadAndInstallVsix(url, {
    'X-Access-Key': config.accessKey,
    'X-Console-User': config.operatorUsername,
    'X-Operator-Proof': config.operatorProof,
  });
  return meta;
}

/** 只比数字段，与服务端 isNewerVersion 同一规则。 */
export function isNewerVersion(remote: string, local: string): boolean {
  const parse = (v: string) =>
    String(v || '')
      .split('.')
      .map((n) => {
        const x = parseInt(n, 10);
        return Number.isFinite(x) ? x : 0;
      });
  const a = parse(remote);
  const b = parse(local);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

let updateBusy = false;

/**
 * 看板版本更高时静默安装并重载窗口。心跳下发与启动检查共用，避免两路同时装。
 */
export async function autoUpdateAndReload(extensionPath: string): Promise<void> {
  if (updateBusy) return;
  const config = readReporterConfig();
  if (!config.apiBaseUrl || !config.accessKey) return;
  updateBusy = true;
  try {
    const local = await readLocalBuildInfo(extensionPath);
    const remote = await fetchRemoteBuildMeta(config.apiBaseUrl);
    if (!remote.version || remote.available === false || !isNewerVersion(remote.version, local.version)) {
      updateBusy = false;
      return;
    }
    await installFromBoardWithAccessKey();
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  } catch (e) {
    updateBusy = false;
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[ctu] auto update:', msg);
    if (e instanceof OperatorProofError) {
      await promptReinstallFromBoard(msg);
    }
  }
}

/** 用户已确认更新：失败要让人看见，签名失效时引导去看板重装。 */
export async function installAndOfferReload(): Promise<void> {
  try {
    const meta = await installFromBoardWithAccessKey();
    const reload = await vscode.window.showInformationMessage(
      `已安装 ${meta.version}，需重载窗口后生效`,
      '重载窗口',
    );
    if (reload === '重载窗口') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof OperatorProofError) {
      await promptReinstallFromBoard(msg);
    } else {
      void vscode.window.showErrorMessage(`Cursor Team Usage 更新失败：${msg}`);
    }
  }
}

/** 打开看板，让用户登录后点「安装插件」拿到带自己签名的新包。 */
export async function promptReinstallFromBoard(reason: string): Promise<void> {
  const { apiBaseUrl } = readReporterConfig();
  const choice = await vscode.window.showWarningMessage(
    `Cursor Team Usage：${reason}。请登录看板后点「安装插件」重新安装。`,
    '打开看板',
  );
  if (choice === '打开看板' && apiBaseUrl) {
    await vscode.env.openExternal(vscode.Uri.parse(apiBaseUrl));
  }
}
