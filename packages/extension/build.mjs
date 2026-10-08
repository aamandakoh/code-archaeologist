import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const builds = [
  // Extension host: Node, CommonJS, vscode provided at runtime.
  {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['vscode'],
    sourcemap: true,
  },
  // Webview: browser script, no Node or vscode access.
  {
    entryPoints: ['webview/main.ts'],
    outfile: 'dist/webview.js',
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    sourcemap: true,
  },
  // Settings page: the same, for the settings form.
  {
    entryPoints: ['webview/settings.ts'],
    outfile: 'dist/settings.js',
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    sourcemap: true,
  },
];

if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch();
  console.log('Watching for changes…');
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
