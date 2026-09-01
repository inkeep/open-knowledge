import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(__dirname, '..');
const cliPkgJsonPath = resolve(cliRoot, 'package.json');
const tsdownConfigPath = resolve(cliRoot, 'tsdown.config.ts');

const cliPkg = JSON.parse(readFileSync(cliPkgJsonPath, 'utf8')) as {
  dependencies?: Record<string, string>;
};
const declaredDeps = Object.keys(cliPkg.dependencies ?? {}).sort();

const configSource = readFileSync(tsdownConfigPath, 'utf8');

function extractBlock(name: 'alwaysBundlePureJsDeps' | 'nativeAddonNeverBundle'): string {
  const match = configSource.match(new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\n\\];`));
  return match?.[1] ?? '';
}

function stripLineComments(block: string): string {
  return block
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

const alwaysBundleBlock = stripLineComments(extractBlock('alwaysBundlePureJsDeps'));
const neverBundleBlock = stripLineComments(extractBlock('nativeAddonNeverBundle'));
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

describe('yjs split-bundling policy', () => {
  test('yjs is a declared runtime dependency (library consumers resolve the external import)', () => {
    expect(declaredDeps).toContain('yjs');
  });

  test('standalone build inlines yjs (alwaysBundle covers it)', () => {
    expect(/\^yjs\\?\(/.test(alwaysBundleBlock)).toBe(true);
  });

  test('library build externalizes yjs (its neverBundle lists it)', () => {
    expect(configSource).toMatch(/neverBundle:\s*\[\.\.\.nativeAddonNeverBundle,\s*'yjs'\]/);
  });

  test('library build does not force-inline yjs (alwaysBundle filtered)', () => {
    expect(configSource).toMatch(/alwaysBundlePureJsDeps\.filter\(\(re\) => !re\.test\('yjs'\)\)/);
  });
});

describe('tsdown alwaysBundle covers the file-type transitive closure', () => {
  const fileTypeClosure = [
    '@borewit/text-codec',
    '@tokenizer/inflate',
    '@tokenizer/token',
    'file-type',
    'ieee754',
    'strtok3',
    'token-types',
    'uint8array-extras',
  ];

  for (const dep of fileTypeClosure) {
    test(`alwaysBundle covers transitive dep '${dep}'`, () => {
      const escaped = dep.replace(/[\\^$*+?.()|[\]{}-]/g, '\\$&').replace(/\//g, '\\\\?/');
      const pattern = new RegExp(`\\^${escaped}\\(`);
      expect(
        pattern.test(alwaysBundleBlock),
        `Add /^${dep}(\\/|$)/ to packages/cli/tsdown.config.ts \`alwaysBundle\`. ` +
          `It is a pure-JS transitive dep of file-type (the server's upload ` +
          `MIME-sniff); externalized, it leaves a bare \`import '${dep}'\` that ` +
          `crashes packaged-app uploads with ERR_MODULE_NOT_FOUND.`,
      ).toBe(true);
    });
  }
});

describe('tsdown alwaysBundle covers server/core-inlined transitive deps', () => {
  const serverInlinedClosure = ['sirv', 'just-bash', 'shell-quote', 'picomatch'];

  for (const dep of serverInlinedClosure) {
    test(`alwaysBundle covers transitive dep '${dep}'`, () => {
      const escaped = dep.replace(/[\\^$*+?.()|[\]{}-]/g, '\\$&').replace(/\//g, '\\\\?/');
      const pattern = new RegExp(`\\^${escaped}\\(`);
      expect(
        pattern.test(alwaysBundleBlock),
        `Add /^${dep}(\\/|$)/ to packages/cli/tsdown.config.ts \`alwaysBundle\`. ` +
          `It is a pure-JS transitive dep inlined via @inkeep/open-knowledge-server ` +
          `/ -core (NOT a cli package.json dep); externalized, it leaves a bare ` +
          `\`import '${dep}'\` that crashes the packaged app with ERR_MODULE_NOT_FOUND.`,
      ).toBe(true);
    });
  }
});
