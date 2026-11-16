import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const files = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.css': ['public/app.css', 'text/css; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/beihang.jpg': ['public/beihang.jpg', 'image/jpeg'],
  '/physics.png': ['public/physics.png', 'image/png'],
};
const assets = {};
for (const [route, [file, type]] of Object.entries(files)) {
  assets[route] = { type, base64: (await readFile(file)).toString('base64') };
}

await mkdir('dist/server', { recursive: true });
await mkdir('dist/.openai', { recursive: true });
const worker = await readFile('worker.mjs', 'utf8');
await writeFile('dist/server/index.js', `const assets = ${JSON.stringify(assets)};\n${worker}`);
await copyFile('.openai/hosting.json', 'dist/.openai/hosting.json');
execFileSync(process.execPath, ['--check', 'dist/server/index.js'], { stdio: 'inherit' });
