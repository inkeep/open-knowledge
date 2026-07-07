import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression guard: logger deps stay inlined in the server bundle.
 *
 * `packages/cli` already inlines its logger deps because the packaged
 * Electron app placed the cli's dist in app.asar.unpacked/ and Node's module
 * resolver couldn't reach sibling node_modules inside the asar archive,
 * surfacing as `ERR_MODULE_NOT_FOUND: Cannot find package 'pino'` at server
 * boot. The packaged Electron app also installs `@inkeep/open-knowledge-server`
 * into node_modules and would hit the same bug class if a future native dep
 * makes electron-builder relocate the server package the same way. Pre-empt
 * by inlining the same logger deps here.
 *
 * Scope is intentionally narrow — only logger deps, not every server dep.
 * OTel / Hocuspocus / Tiptap / Yjs bundling behavior is non-trivial and they
 * are not implicated in the cli bug pattern. Expand only when a new logger-
 * shaped dep is added or another bug-class incident surfaces.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(__dirname, '..');
const tsdownConfigPath = resolve(serverRoot, 'tsdown.config.ts');

const configSource = readFileSync(tsdownConfigPath, 'utf8');

function extractBlock(name: 'alwaysBundle' | 'neverBundle'): string {
  const match = configSource.match(new RegExp(`${name}:\\s*\\[([\\s\\S]*?)\\]`));
  return match?.[1] ?? '';
}

// Strip `//` comments (both whole-line and inline) so a commented-out entry
// doesn't pass as covered. Biome may collapse the alwaysBundle list onto
// one line where inline `//` is the only way to comment out an entry.
function stripLineComments(block: string): string {
  return block
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

const alwaysBundleBlock = stripLineComments(extractBlock('alwaysBundle'));

const MUST_INLINE_DEPS = ['pino', 'pino-pretty'] as const;

describe('tsdown alwaysBundle covers server logger deps', () => {
  test('tsdown.config.ts loads (premise check)', () => {
    expect(alwaysBundleBlock.length).toBeGreaterThan(0);
  });

  for (const dep of MUST_INLINE_DEPS) {
    test(`alwaysBundle covers '${dep}'`, () => {
      const escaped = dep.replace(/[\\^$*+?.()|[\]{}-]/g, '\\$&').replace(/\//g, '\\\\?/');
      const pattern = new RegExp(`\\^${escaped}\\(`);
      expect(
        pattern.test(alwaysBundleBlock),
        `Add /^${dep}(\\/|$)/ to packages/server/tsdown.config.ts \`alwaysBundle\`. ` +
          `Without it, the bundled server keeps a bare \`import '${dep}'\` that ` +
          `would fail to resolve from app.asar.unpacked/ in the packaged DMG ` +
          `(ERR_MODULE_NOT_FOUND) if electron-builder ever relocates this ` +
          `package — same bug class as #1389.`,
      ).toBe(true);
    });
  }
});
