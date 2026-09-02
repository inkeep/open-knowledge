import { readdirSync, readFileSync, type Stats, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { getRegisteredDescriptors } from '../../src/editor/registry/index.ts';

const APP_ROOT = resolve(import.meta.dirname, '../..');
const PACKAGES_ROOT = resolve(APP_ROOT, '..');
const ROOTS = [
  join(APP_ROOT, 'src'),
  join(APP_ROOT, 'tests'),
  ...['core', 'server', 'cli', 'desktop', 'plugin'].flatMap((pkg) => [
    join(PACKAGES_ROOT, pkg, 'src'),
    join(PACKAGES_ROOT, pkg, 'tests'),
  ]),
];
const SELF_FILE = resolve(import.meta.dirname, 'substrate-vocabulary-drift.test.ts');

const TEST_FIXTURE_KNOWN_NONREGISTERED: Record<string, string> = {
  mermaid:
    'Mermaid.tsx — renders MermaidFence compat with substrate-type="mermaid" for DOM targeting',
};

function* walkTestFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      yield* walkTestFiles(full);
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.test.ts') ||
        entry.name.endsWith('.test.tsx') ||
        entry.name.endsWith('.e2e.ts'))
    ) {
      yield full;
    }
  }
}

const COMPONENT_TYPE_LITERAL = /data-component-type="([^"'$]+)"|data-component-type='([^"'$]+)'/g;

describe('substrate vocabulary drift — every test reference must resolve', () => {
  test('every `data-component-type="<name>"` literal is a registered descriptor or a known exception', () => {
    const registered = new Set<string>();
    for (const d of getRegisteredDescriptors()) {
      registered.add(d.name.toLowerCase());
    }
    registered.add('*');

    const violations: Array<{ file: string; line: number; name: string }> = [];

    for (const root of ROOTS) {
      let rootStat: Stats;
      try {
        rootStat = statSync(root);
      } catch {
        continue;
      }
      if (!rootStat.isDirectory()) continue;

      for (const file of walkTestFiles(root)) {
        if (file === SELF_FILE) continue;
        const content = readFileSync(file, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line) continue;
          COMPONENT_TYPE_LITERAL.lastIndex = 0;
          let match: RegExpExecArray | null = COMPONENT_TYPE_LITERAL.exec(line);
          while (match !== null) {
            const name = match[1] ?? match[2];
            if (name && name !== '...') {
              const lower = name.toLowerCase();
              if (!registered.has(lower) && !(lower in TEST_FIXTURE_KNOWN_NONREGISTERED)) {
                violations.push({ file, line: i + 1, name: lower });
              }
            }
            match = COMPONENT_TYPE_LITERAL.exec(line);
          }
        }
      }
    }

    if (violations.length > 0) {
      const lines = violations.map(
        (v) =>
          `  - ${v.file}:${v.line} references data-component-type="${v.name}" — not registered. ` +
          `Resolution: (a) update the test reference to a registered substrate name; ` +
          `(b) add "${v.name}" to TEST_FIXTURE_KNOWN_NONREGISTERED in ` +
          `tests/meta/substrate-vocabulary-drift.test.ts with a comment naming the production source.`,
      );
      throw new Error(
        `Substrate-vocabulary drift detected (${violations.length} reference${
          violations.length === 1 ? '' : 's'
        }):\n${lines.join('\n')}`,
      );
    }

    expect(violations).toHaveLength(0);
  });
});
