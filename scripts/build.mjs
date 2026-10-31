import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const out = 'dist';
const watch = process.argv.includes('--watch');

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'fonts'), { recursive: true });
await mkdir(join(out, 'ort'), { recursive: true });

await cp('static', out, { recursive: true });
await cp('src/ui/styles.css', join(out, 'styles.css'));

if (!existsSync('models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx')) {
  console.error('Model missing. Run: npm run fetch-model');
  process.exit(1);
}
await cp('models', join(out, 'models'), { recursive: true });

for (const name of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  await cp(join('node_modules/onnxruntime-web/dist', name), join(out, 'ort', name));
}
await cp(
  'node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2',
  join(out, 'fonts/bricolage.woff2'),
);
for (const w of [400, 500]) {
  await cp(`node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-${w}-normal.woff2`, join(out, `fonts/mono-${w}.woff2`));
}

const options = {
  bundle: true,
  format: 'esm',
  target: 'chrome121',
  minify: !watch,
  sourcemap: watch,
  outdir: out,
  entryPoints: {
    background: 'src/background.ts',
    offscreen: 'src/offscreen.ts',
    newtab: 'src/ui/newtab.ts',
    popup: 'src/ui/popup.ts',
  },
  logLevel: 'info',
};
const contentOptions = { ...options, format: 'iife', entryPoints: { content: 'src/content.ts' } };

if (watch) {
  await (await context(options)).watch();
  await (await context(contentOptions)).watch();
} else {
  await build(options);
  await build(contentOptions);
}
