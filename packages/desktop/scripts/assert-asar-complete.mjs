#!/usr/bin/env node
/**
 * Effect-level control: the packaged `app.asar` must actually carry the runtime
 * dependencies the main process imports.
 *
 * A packaged Electron app whose asar has no `node_modules` installs fine and
 * then dies on the first bare import, BEFORE `app.ready` — so there is no
 * window, no dialog, and no crash report. From the outside it is
 * indistinguishable from "nothing happened". Every other packaging control we
 * have (an executable exists, the smoke suite passes) stays green through it,
 * because the smoke suite drives the electron-vite `out/` build where the dev
 * `node_modules` are still on disk to resolve against.
 *
 * Reads the asar header directly rather than shelling out to the `asar` CLI:
 * the format is a 16-byte prefix whose last uint32 is the length of a JSON
 * directory listing, which is all we need and costs one read of the first few
 * hundred KB of a ~250 MB file.
 *
 * Usage: node assert-asar-complete.mjs <search-root> [label]
 *   <search-root>  directory to find app.asar under (e.g. dist-desktop)
 */

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Packages asserted present by name. `pino` is the one that actually broke —
 * `desktop-logger` imports it at module scope, so it is the first bare specifier
 * the main process resolves and thus the observed failure. The others are listed
 * so a partial collection (rather than a wholesale omission) still fails.
 */
const REQUIRED_PACKAGES = ['pino', 'electron-updater'];

/**
 * EVERY asar under the root, not the first one found. A single `electron-builder
 * --win` run with `arch: [x64, arm64]` writes `win-unpacked/` AND
 * `win-arm64-unpacked/`, each with its own `app.asar`; checking only one would
 * let a broken second arch ship. (`--dir` builds the host arch alone, which is
 * why the PR-gate cells see exactly one.)
 */
function findAsars(root) {
  if (!existsSync(root)) return [];
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isFile() && entry.name === 'app.asar') found.push(full);
      // `*-unpacked/` trees mirror the asar's contents and would double the walk.
      if (entry.isDirectory() && !entry.name.endsWith('.asar.unpacked')) stack.push(full);
    }
  }
  return found.sort();
}

/** Guards against a truncated or corrupt asar producing a bare stack trace. */
const MAX_HEADER_BYTES = 64 * 1024 * 1024;

function readAsarHeader(asarPath) {
  const fd = openSync(asarPath, 'r');
  try {
    const prefix = Buffer.alloc(16);
    if (readSync(fd, prefix, 0, 16, 0) < 16) {
      throw new Error('file is shorter than the 16-byte asar header prefix');
    }
    const jsonSize = prefix.readUInt32LE(12);
    if (jsonSize === 0 || jsonSize > MAX_HEADER_BYTES) {
      throw new Error(
        `implausible asar header length (${jsonSize} bytes) — file is not a valid asar`,
      );
    }
    const json = Buffer.alloc(jsonSize);
    if (readSync(fd, json, 0, jsonSize, 16) < jsonSize) {
      throw new Error(`asar header truncated (wanted ${jsonSize} bytes)`);
    }
    return JSON.parse(json.toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

const searchRoot = process.argv[2];
const label = process.argv[3] ?? searchRoot;

if (!searchRoot) {
  console.error('usage: assert-asar-complete.mjs <search-root> [label]');
  process.exit(2);
}

const asarPaths = findAsars(searchRoot);
if (asarPaths.length === 0) {
  console.error(`::error::${label}: no app.asar found under ${searchRoot}`);
  process.exit(1);
}

let failed = false;

for (const asarPath of asarPaths) {
  const sizeMb = (statSync(asarPath).size / 1024 / 1024).toFixed(1);

  let header;
  try {
    header = readAsarHeader(asarPath);
  } catch (error) {
    console.error(
      `::error::${label}: could not read the asar header of ${asarPath} (${sizeMb} MB): ${error.message}`,
    );
    failed = true;
    continue;
  }

  const top = header.files ?? {};
  const nodeModules = top.node_modules;
  if (nodeModules == null) {
    console.error(
      `::error::${label}: app.asar contains NO node_modules directory — the packaged app ` +
        `cannot start (bare imports fail before app.ready, with no window and no dialog). ` +
        `asar: ${asarPath} (${sizeMb} MB), top-level entries: ${Object.keys(top).sort().join(', ')}`,
    );
    failed = true;
    continue;
  }

  const packages = Object.keys(nodeModules.files ?? {});
  const missing = REQUIRED_PACKAGES.filter((name) => !packages.includes(name));
  if (missing.length > 0) {
    console.error(
      `::error::${label}: app.asar node_modules is missing required package(s): ` +
        `${missing.join(', ')}. Present: ${packages.length} package(s). asar: ${asarPath}`,
    );
    failed = true;
    continue;
  }

  console.log(
    `asar completeness OK (${label}): ${asarPath} (${sizeMb} MB), ` +
      `node_modules with ${packages.length} package(s), required present: ${REQUIRED_PACKAGES.join(', ')}`,
  );
}

if (failed) process.exit(1);

console.log(`asar completeness: ${asarPaths.length} asar(s) checked under ${searchRoot}`);
