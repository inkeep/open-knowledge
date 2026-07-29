/**
 * Structural guard — every renderer-console capture site scrubs credentials.
 *
 * A capture site is any module that turns raw browser `console` text into a log
 * record. Every one of them necessarily calls the capture primitives this
 * directory exports (`mapConsoleLevel` / `parseStructuredConsoleMessage`), so
 * the sweep discovers sites by that call rather than from a hand-maintained
 * list: a capture site added anywhere under `packages/<pkg>/src` is picked up by
 * the commit that adds it, and fails here if it does not scrub.
 *
 * Raw console strings bypass pino's path-keyed `redact` entirely — a site that
 * skips the scrub writes live credentials into a local log file that the
 * bug-report bundle then reads, so the scrub has to happen at capture time.
 *
 * Why a source sweep rather than a runtime test: the sites live in
 * `packages/desktop` and `packages/app`, neither of which `core` may import
 * (the dependency edge points the other way), so no single test process can
 * reach them all to drive a planted secret through. Each site carries its own
 * planted-credential behavioral test; this sweep is what makes the coverage
 * structural instead of per-site.
 *
 * `POST /api/client-logs` is deliberately not a capture site: it ingests
 * already-captured, schema-validated entries from the web forwarder (which
 * scrubs at capture) and calls none of these primitives.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/** `…/packages/core/src/logging/` → `…/packages/`. */
const PACKAGES_DIR = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * A CALL of a capture primitive, not a mention: `renderer-log.ts` declares
 * them and `schemas/api/client-logs.ts` names them in prose, and neither is a
 * capture site.
 */
const CAPTURE_PRIMITIVE_CALL = /\b(?:mapConsoleLevel|parseStructuredConsoleMessage)\s*\(/;

/** The canonical scrub, whether taken via the combined helper or directly. */
const SCRUB_CALL = /\b(?:prepareCapturedConsoleMessage|scrubSecrets)\s*\(/;

/** Where the primitives are declared — excluded so the module isn't its own site. */
const DEFINITION_DIR = join('core', 'src', 'logging');

const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'out', 'build', '.turbo']);

/**
 * Sites known to exist today. Asserted as a lower bound so a walk that silently
 * stops finding files (a renamed directory, a tightened skip list) fails here
 * instead of passing with an empty sweep.
 */
const KNOWN_CAPTURE_SITES = [
  'app/src/lib/install-client-log-forwarder.ts',
  'desktop/src/main/renderer-console-capture.ts',
];

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listSourceFiles(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.(?:test|test-helper|e2e|private\.test)\.tsx?$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

function findCaptureSites(): string[] {
  const sites: string[] = [];
  for (const pkg of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!pkg.isDirectory() || SKIP_DIR_NAMES.has(pkg.name)) continue;
    const srcDir = join(PACKAGES_DIR, pkg.name, 'src');
    try {
      if (!statSync(srcDir).isDirectory()) continue;
    } catch {
      continue; // package without a `src/` (fixtures, generated output)
    }
    for (const file of listSourceFiles(srcDir)) {
      const rel = relative(PACKAGES_DIR, file);
      if (rel.startsWith(DEFINITION_DIR) || rel.includes(join('/', DEFINITION_DIR))) continue;
      if (CAPTURE_PRIMITIVE_CALL.test(readFileSync(file, 'utf8'))) {
        sites.push(rel.split(/[\\/]/).join('/'));
      }
    }
  }
  return sites.sort();
}

describe('renderer-console capture sites', () => {
  test('the sweep finds the capture sites that exist today', () => {
    expect(findCaptureSites()).toEqual(expect.arrayContaining(KNOWN_CAPTURE_SITES));
  });

  test('every capture site scrubs the console text before it reaches a sink', () => {
    const unscrubbed = findCaptureSites().filter(
      (rel) => !SCRUB_CALL.test(readFileSync(join(PACKAGES_DIR, rel), 'utf8')),
    );
    expect(unscrubbed).toEqual([]);
  });
});
