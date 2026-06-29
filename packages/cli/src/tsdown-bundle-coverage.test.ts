import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';


const __dirname = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(__dirname, '..');
const cliPkgJsonPath = resolve(cliRoot, 'package.json');
const tsdownConfigPath = resolve(cliRoot, 'tsdown.config.ts');

const cliPkg = JSON.parse(readFileSync(cliPkgJsonPath, 'utf8')) as {
  dependencies?: Record<string, string>;
};
const declaredDeps = Object.keys(cliPkg.dependencies ?? {}).sort();

const configSource = readFileSync(tsdownConfigPath, 'utf8');

function extractBlock(name: 'alwaysBundle' | 'neverBundle'): string {
  const match = configSource.match(new RegExp(`${name}:\\s*\\[([\\s\\S]*?)\\]`));
  return match?.[1] ?? '';
}

function stripLineComments(block: string): string {
  return block
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

const alwaysBundleBlock = stripLineComments(extractBlock('alwaysBundle'));
const neverBundleBlock = stripLineComments(extractBlock('neverBundle'));
const neverBundleNames = [...neverBundleBlock.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);

describe('tsdown alwaysBundle covers every cli runtime dep', () => {
  test('cli package.json + tsdown.config.ts both load (premise check)', () => {
    expect(declaredDeps.length).toBeGreaterThan(0);
    expect(alwaysBundleBlock.length).toBeGreaterThan(0);
  });

  for (const dep of declaredDeps) {
    test(`alwaysBundle covers '${dep}'`, () => {
      if (neverBundleNames.includes(dep)) return;
      const escaped = dep.replace(/[\\^$*+?.()|[\]{}-]/g, '\\$&').replace(/\//g, '\\\\?/');
      const pattern = new RegExp(`\\^${escaped}\\(`);
      expect(
        pattern.test(alwaysBundleBlock),
        `Add /^${dep}(\\/|$)/ to packages/cli/tsdown.config.ts \`alwaysBundle\`. ` +
          `Without it, the bundled CLI keeps a bare \`import '${dep}'\` that ` +
          `fails to resolve from app.asar.unpacked/ in the packaged DMG ` +
          `(ERR_MODULE_NOT_FOUND).`,
      ).toBe(true);
    });
  }
});
