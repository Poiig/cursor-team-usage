import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
for (const name of ['read_cursor_auth.py', 'write_cursor_auth.py']) {
  cpSync(path.join(__dirname, '..', 'scripts', name), path.join(__dirname, 'dist', name));
}

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [path.join(__dirname, 'src', 'extension.ts')],
  bundle: true,
  outfile: path.join(__dirname, 'dist', 'extension.js'),
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
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
