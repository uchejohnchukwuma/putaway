import { createWriteStream, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const repo = 'Xenova/all-MiniLM-L6-v2';
const revision = 'main';
const files = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];

for (const file of files) {
  const dest = join('models', repo, file);
  if (existsSync(dest)) continue;
  await mkdir(dirname(dest), { recursive: true });
  const res = await fetch(`https://huggingface.co/${repo}/resolve/${revision}/${file}`);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  console.log('fetched', file);
}
