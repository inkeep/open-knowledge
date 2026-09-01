import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const PACKAGES_DIR = fileURLToPath(new URL('../../../', import.meta.url));

const CAPTURE_PRIMITIVE_CALL = /\b(?:mapConsoleLevel|parseStructuredConsoleMessage)\s*\(/;

const SCRUB_CALL = /\b(?:prepareCapturedConsoleMessage|scrubSecrets)\s*\(/;

const DEFINITION_DIR = join('core', 'src', 'logging');

const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'out', 'build', '.turbo']);

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
      continue;
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
