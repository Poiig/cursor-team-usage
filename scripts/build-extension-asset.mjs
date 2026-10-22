/**
 * 构建随容器发布的 Reporter 基座 VSIX + 元数据（不含 ACCESS_KEY，运行时再注入）。
 * 版本只取 extension/package.json。每次镜像构建都可以重打，但不能另造构建号，
 * 否则已安装端会把同版本当成新版本。
 * 用法：node scripts/build-extension-asset.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const ASSET = path.join(ROOT, 'assets');

/** 把 npm / vsce 的失败直接变成构建失败，避免打出半成品 VSIX。 */
function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} → ${code}`));
    });
  });
}

const pkg = JSON.parse(readFileSync(path.join(EXT, 'package.json'), 'utf8'));
const version = String(pkg.version || '0.0.0');
const build = version;

mkdirSync(ASSET, { recursive: true });

if (!existsSync(path.join(EXT, 'node_modules'))) {
  console.log('extension: npm ci…');
  await run('npm', ['ci'], EXT);
}

console.log('extension: compile…');
await run('npm', ['run', 'compile'], EXT);

// 写入 build-info，打进 VSIX（勿被 vscodeignore）。build 与版本号相同，检测不看提交哈希。
writeFileSync(
  path.join(EXT, 'build-info.json'),
  JSON.stringify({ version, build, builtAt: new Date().toISOString() }, null, 2) + '\n',
);

console.log('extension: vsce package…');
await run('npx', ['vsce', 'package', '--no-dependencies'], EXT);

const vsixName = `${pkg.name}-${version}.vsix`;
if (!existsSync(path.join(EXT, vsixName))) {
  throw new Error(`vsce 未产出本次版本 ${vsixName}`);
}
const dest = path.join(ASSET, 'reporter-base.vsix');
copyFileSync(path.join(EXT, vsixName), dest);

writeFileSync(
  path.join(ASSET, 'extension-build.json'),
  JSON.stringify(
    {
      version,
      build,
      builtAt: new Date().toISOString(),
      file: 'reporter-base.vsix',
    },
    null,
    2,
  ) + '\n',
);

console.log(`asset ready: ${dest}`);
console.log(`version: ${version}`);
