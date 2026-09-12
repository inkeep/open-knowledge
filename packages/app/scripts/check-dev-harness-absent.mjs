#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

export const DEV_HARNESS_SENTINEL = '__acpThreadHarness';

const SCANNED_EXTENSIONS = ['.js', '.mjs', '.cjs', '.css', '.html', '.map'];

const APP_ROOT = join(fileURLToPath(import.meta.url), '..', '..');

function parseDistArg() {
  const flag = argv.indexOf('--dist');
  return flag === -1 ? join(APP_ROOT, 'dist') : argv[flag + 1];
}

function listScannableFiles(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (SCANNED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) found.push(path);
    }
  };
  walk(dir);
  return found;
}

function main() {
  const distDir = parseDistArg();
  if (distDir === undefined) {
    stderr.write('check-dev-harness-absent: --dist needs a directory\n');
    return 1;
  }

  let dist;
  try {
    dist = statSync(distDir);
  } catch {
    stderr.write(
      `check-dev-harness-absent: no build at ${distDir}\n` +
        '  This gate reads the emitted artifact, so it cannot run before `pnpm run build`.\n',
    );
    return 1;
  }
  if (!dist.isDirectory()) {
    stderr.write(`check-dev-harness-absent: ${distDir} is not a directory\n`);
    return 1;
  }

  const files = listScannableFiles(distDir);
  if (files.length === 0) {
    stderr.write(
      `check-dev-harness-absent: nothing to scan under ${distDir}\n` +
        `  Expected emitted ${SCANNED_EXTENSIONS.join('/')} assets. A build that emits none, or a\n` +
        '  layout this walk no longer understands, would otherwise report a clean pass.\n',
    );
    return 1;
  }

  const hits = files.filter((path) => readFileSync(path, 'utf8').includes(DEV_HARNESS_SENTINEL));
  if (hits.length > 0) {
    stderr.write(
      `check-dev-harness-absent: '${DEV_HARNESS_SENTINEL}' reached the production build\n` +
        `${hits.map((path) => `  ${path}\n`).join('')}` +
        '  Two `import.meta.env.DEV` guards keep it out, and folding either one is enough\n' +
        '  on its own: the branch around the installer call in\n' +
        '  src/components/acp/AgentThreadClientBinder.tsx, and the early return opening\n' +
        '  installAcpThreadHarness in src/lib/acp/dev-thread-harness.ts. Reaching an\n' +
        '  emitted chunk means neither folded, so check both rather than just the import.\n',
    );
    return 1;
  }

  stdout.write(
    `check-dev-harness-absent: '${DEV_HARNESS_SENTINEL}' absent from ${files.length} assets\n`,
  );
  return 0;
}

if (argv[1] !== undefined && resolve(argv[1]) === fileURLToPath(import.meta.url)) {
  exit(main());
}
