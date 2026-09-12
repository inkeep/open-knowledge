#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(HERE, '..');

const pkgDir = realpathSync(join(APP_ROOT, 'node_modules', '@excalidraw', 'excalidraw'));
const pkgPath = join(pkgDir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const version = pkg.version;
if (typeof version !== 'string' || version.length === 0) {
  console.error('[copy-excalidraw-assets] could not read @excalidraw/excalidraw version');
  process.exit(1);
}

const src = join(pkgDir, 'dist', 'prod', 'fonts');
if (!existsSync(src)) {
  console.error(`[copy-excalidraw-assets] missing source dir: ${src}`);
  process.exit(1);
}

const dst = join(APP_ROOT, 'public', 'excalidraw-assets');
const marker = join(dst, `.copied-from-${version}`);
if (existsSync(marker)) {
  process.exit(0);
}

if (existsSync(dst)) {
  rmSync(dst, { recursive: true, force: true });
}
mkdirSync(dst, { recursive: true });
cpSync(src, join(dst, 'fonts'), { recursive: true });
writeFileSync(marker, `${version}\n`);
console.log(
  `[copy-excalidraw-assets] vendored @excalidraw/excalidraw@${version} fonts → public/excalidraw-assets/fonts`,
);
