#!/usr/bin/env node
/**
 * Copy Excalidraw's `dist/prod/fonts` tree into `public/excalidraw-assets/fonts`
 * so vite (dev) and the built dist both serve them from `/excalidraw-assets/`.
 *
 * The alternative — leaving `window.EXCALIDRAW_ASSET_PATH` unset — makes
 * Excalidraw fall back to its hardcoded `esm.sh` CDN URL for every font file
 * (see `createUrls` in `chunk-K2UTITRG.js`). That is a posture change for a
 * local-first editor: offline / air-gapped users silently render with system-
 * font fallbacks and every online use ships another vendor a request the app
 * did not previously make. Vendoring keeps the existing self-hosted stance.
 *
 * Idempotent — if the destination already has a marker matching the installed
 * Excalidraw version, do nothing. Cheap to run on every `predev`/`prebuild`.
 */
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

// Resolve the installed package root directly rather than via
// `require.resolve('@excalidraw/excalidraw/package.json', ...)` — the package
// declares an `exports` map that does not expose `./package.json`, so ESM
// resolution rejects it (`ERR_PACKAGE_PATH_NOT_EXPORTED`). `realpathSync`
// follows the pnpm workspace symlink to the actual store path.
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
