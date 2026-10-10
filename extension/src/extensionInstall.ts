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
import { readReporterConfig } from './reporter';

export type ExtensionBuildMeta = {
  version: string;
  build: string;
  builtAt?: string | null;
  available?: boolean;
};

/**
 * 读扩展包内 build-info（部署构建号）；缺省则回退 package.json。
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
  const res = await fetch(`${apiBaseUrl.replace(/\/+$/, '')}/api/extension/meta`);
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
  const res = await fetch(vsixUrl, { headers });
  if (!res.ok || !res.body) {
    throw new Error(`下载插件失败 HTTP ${res.status}`);
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

/**
 * 启动时比对构建号；有更新则提示一键安装。
 */
export async function maybePromptUpdate(extensionPath: string): Promise<void> {
  const config = readReporterConfig();
  if (!config.apiBaseUrl) return;
  try {
    const local = await readLocalBuildInfo(extensionPath);
    const remote = await fetchRemoteBuildMeta(config.apiBaseUrl);
    if (!remote.build || !remote.available) return;
    if (remote.version === local.version && remote.build === local.build) return;
    const choice = await vscode.window.showInformationMessage(
      `Cursor Team Usage 插件有更新：${remote.version} (${remote.build})，当前 ${local.build}`,
      '立即更新',
      '稍后',
    );
    if (choice !== '立即更新') return;
    await installFromBoardWithAccessKey();
    const reload = await vscode.window.showInformationMessage(
      '插件已安装，需重载窗口后生效',
      '重载窗口',
    );
    if (reload === '重载窗口') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } catch (e) {
    console.warn('[ctu] update check skipped:', e);
  }
}
