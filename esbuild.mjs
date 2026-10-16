import * as esbuild from 'esbuild';
import { readdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');

const builds = tests
  ? [
      {
        entryPoints: readdirSync('test').filter((f) => f.endsWith('.test.ts')).map((f) => `test/${f}`),
        outdir: 'out/test',
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node18',
        sourcemap: true,
      },
    ]
  : [
      {
        entryPoints: ['src/extension.ts'],
        outfile: 'dist/extension.js',
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node18',
        external: ['vscode'],
        sourcemap: true,
      },
      {
        entryPoints: ['src/webview/graph.ts', 'src/webview/commit.ts'],
        outdir: 'dist/webview',
        bundle: true,
        platform: 'browser',
        format: 'iife',
        target: 'es2020',
        sourcemap: true,
      },
    ];

if (watch) {
  for (const b of builds) {
    const ctx = await esbuild.context(b);
    await ctx.watch();
  }
  console.log('watching…');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
