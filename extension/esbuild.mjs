import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
// sql-wasm-inline 作 node:sqlite 不可用时的旁路（单文件内嵌 wasm），不打进 extension.js
cpSync(
  path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm-inline.js'),
  path.join(__dirname, 'dist', 'sql-wasm-inline.js'),
);

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [path.join(__dirname, 'src', 'extension.ts')],
  bundle: true,
  outfile: path.join(__dirname, 'dist', 'extension.js'),
  // node:sqlite / 旁路 asm 由宿主或 dist 旁路文件提供
  external: ['vscode', 'node:sqlite'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('extension watching…');
} else {
  await esbuild.build(options);
  console.log('extension compiled → dist/extension.js');
}
