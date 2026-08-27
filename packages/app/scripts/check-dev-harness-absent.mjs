#!/usr/bin/env node
/**
 * Production-artifact gate for the DEV-only ACP thread-injection harness.
 *
 * The harness is kept out of shipped code by two independent
 * `import.meta.env.DEV` guards, either of which is enough for the bundler to
 * fold the publish away. That gating lives in source, so it can regress
 * without a single suite going red: every unit, DOM, integration and browser
 * tier runs against source or a dev server, never against an emitted chunk.
 * This reads the emitted `dist/`, which is the bundle a user actually runs —
 * the CLI copies it to `cli/dist/public` and the desktop package ships that as
 * the renderer its packaged window loads. It is the only automatic check that
 * still discriminates once both guards are gone; the sentinel list in
 * `tests/perf/lib/bundle-check.ts` covers the same string but no tier collects
 * it, so it only discriminates when someone runs it by hand.
 *
 * Non-zero on a hit, on a missing build, and on a walk that found nothing to
 * read — an absence check that inspected no bytes is not a pass.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * The global the harness publishes itself on. A property name survives
 * minification verbatim, so it is the one part of the module guaranteed to
 * appear in an emitted chunk if any of it leaks. A DOM test pins that the
 * harness still uses this exact name, so a rename cannot leave this scanning
 * for a string nothing writes any more.
 */
export const DEV_HARNESS_SENTINEL = '__acpThreadHarness';

/** Extensions Vite emits code or markup into. Fonts and images cannot carry it. */
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

// Importers want the sentinel alone; only a direct invocation is the gate.
if (argv[1] !== undefined && resolve(argv[1]) === fileURLToPath(import.meta.url)) {
  exit(main());
}
