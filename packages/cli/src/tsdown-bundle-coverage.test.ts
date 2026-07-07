import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression guard: every runtime JS dep in packages/cli/package.json must
 * appear in tsdown.config.ts `alwaysBundle` (unless it's listed in
 * `neverBundle` for being a native addon).
 *
 * The desktop install ships no `node_modules/` next to dist/cli.mjs, so a
 * bare `import 'X'` in the bundled CLI fails to resolve from the packaged
 * .app's app.asar.unpacked/ — Node's module resolver from a file in
 * app.asar.unpacked/ walks the real filesystem only and can't cross into
 * the sibling app.asar/ for transitive resolution. Forgetting to add a new
 * cli dep to `alwaysBundle` surfaces as ERR_MODULE_NOT_FOUND at runtime in
 * the packaged DMG (caught late, after every other gate has passed).
 */

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

// Strip `//`-prefixed comment lines so a commented-out entry doesn't
// silently pass as covered (a bare `/^pino...` substring would otherwise
// match even inside `// /^pino(\/|$)/,`).
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
      // The alwaysBundle entries are JS regex literals like
      // `/^@octokit\/request(\/|$)/` — note that `/` is escaped as `\/` in the
      // source text. Match `^` + dep name (allowing optional `\` before each
      // `/`) + `(` to anchor at a real entry without false positives.
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

/**
 * The loop above only covers the cli's OWN `package.json` dependencies. The
 * same ERR_MODULE_NOT_FOUND class also bites TRANSITIVE runtime deps that
 * enter the bundle through the inlined `@inkeep/open-knowledge-server` source.
 */
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
