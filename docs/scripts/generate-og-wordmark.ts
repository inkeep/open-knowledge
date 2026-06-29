import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';


const root = path.resolve(import.meta.dirname, '..');
const svg = readFileSync(path.join(root, 'public', 'ok-wordmark.svg'));
const dataUrl = `data:image/svg+xml;base64,${svg.toString('base64')}`;

const header = [
  '// Generated from public/ok-wordmark.svg — do not hand-edit.',
  '// Inlined as a module-graph constant so OG-image rendering needs no runtime',
  '// filesystem read (a process.cwd()+readFileSync read defeats the Next/',
  '// Turbopack file tracer and breaks require() of on-demand routes on Vercel).',
  '// Regenerate with: bun run generate:og-wordmark',
  '',
].join('\n');

const out = `${header}export const OK_WORDMARK_DATA_URL = ${JSON.stringify(dataUrl)};\n`;
writeFileSync(path.join(root, 'src', 'lib', 'ok-wordmark.data.ts'), out);
console.log(
  `wrote src/lib/ok-wordmark.data.ts (${dataUrl.length} chars from ${svg.length} svg bytes)`,
);
