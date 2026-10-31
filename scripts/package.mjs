import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const { version } = JSON.parse(await readFile('static/manifest.json', 'utf8'));
const zip = resolve(`release/putaway-${version}.zip`);
await mkdir('release', { recursive: true });
await rm(zip, { force: true });

if (process.platform === 'win32') {
  const tar = join(process.env.SystemRoot, 'System32', 'tar.exe');
  execFileSync(tar, ['-a', '-c', '-f', zip, '-C', 'dist', '.'], { stdio: 'inherit' });
}
else execFileSync('zip', ['-qr', zip, '.'], { cwd: 'dist', stdio: 'inherit' });
console.log(zip);
