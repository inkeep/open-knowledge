#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readAsarHeader } from './lib/asar-header.mjs';

const REQUIRED_PACKAGES = ['pino', 'electron-updater', 'node-pty'];

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
      if (entry.isDirectory() && !entry.name.endsWith('.asar.unpacked')) stack.push(full);
    }
  }
  return found.sort();
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
