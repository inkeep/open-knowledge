import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(__dirname, '..');
const tsdownConfigPath = resolve(serverRoot, 'tsdown.config.ts');

const configSource = readFileSync(tsdownConfigPath, 'utf8');

function extractBlock(name: 'alwaysBundle' | 'neverBundle'): string {
  const match = configSource.match(new RegExp(`${name}:\\s*\\[([\\s\\S]*?)\\]`));
  return match?.[1] ?? '';
}

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
