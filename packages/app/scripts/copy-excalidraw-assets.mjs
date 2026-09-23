#!/usr/bin/env node
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
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

const publicDir = join(APP_ROOT, 'public');
const dst = join(publicDir, 'excalidraw-assets');
const markerName = `.copied-from-${version}`;
const PUBLISHED_DIR_MODE = 0o755;
const PUBLISHED_FILE_MODE = 0o644;
const REMOVAL_RETRIES = 3;

if (existsSync(join(dst, markerName))) {
  process.exit(0);
}

function pinModes(dir) {
  chmodSync(dir, PUBLISHED_DIR_MODE);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) pinModes(full);
    else if (entry.isFile()) chmodSync(full, PUBLISHED_FILE_MODE);
  }
}

function discard(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: REMOVAL_RETRIES });
  } catch (err) {
    console.warn(
      `[copy-excalidraw-assets] could not remove ${path}: ${err.code ?? err.message}; leaving it behind`,
    );
  }
}

function reinstate(superseded) {
  if (!existsSync(join(superseded, markerName))) return;
  try {
    renameSync(superseded, dst);
  } catch (err) {
    console.error(
      `[copy-excalidraw-assets] could not reinstate ${dst} from ${superseded}: ${err.code ?? err.message}`,
    );
  }
}

function reportDisplaced(superseded) {
  if (!existsSync(superseded)) return;
  const state = existsSync(join(dst, markerName))
    ? `${dst} is published; the tree this run displaced is a duplicate`
    : `${dst} is absent; the tree this run displaced is the only copy`;
  console.error(`[copy-excalidraw-assets] could not publish: ${state}, at ${superseded}`);
}

function publish(staged) {
  if (existsSync(join(dst, markerName))) return false;
  const superseded = `${staged}-superseded`;
  let displaced = true;
  try {
    renameSync(dst, superseded);
  } catch (err) {
    displaced = false;
    if (err.code !== 'ENOENT') throw err;
  }
  try {
    renameSync(staged, dst);
    return true;
  } catch (err) {
    if (existsSync(join(dst, markerName))) return false;
    if (displaced) {
      displaced = false;
      reinstate(superseded);
      reportDisplaced(superseded);
    }
    throw err;
  } finally {
    if (displaced) discard(superseded);
  }
}

mkdirSync(publicDir, { recursive: true });
const staged = mkdtempSync(join(APP_ROOT, '.excalidraw-assets-staging-'));
let published = false;
let stage = 'staging the vendored font tree';
try {
  cpSync(src, join(staged, 'fonts'), { recursive: true });
  writeFileSync(join(staged, markerName), `${version}\n`);
  pinModes(staged);
  stage = 'publishing the staged tree';
  published = publish(staged);
} catch (err) {
  console.error(`[copy-excalidraw-assets] ${stage} failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (!published) discard(staged);
}

if (published) {
  console.log(
    `[copy-excalidraw-assets] vendored @excalidraw/excalidraw@${version} fonts → public/excalidraw-assets/fonts`,
  );
}
