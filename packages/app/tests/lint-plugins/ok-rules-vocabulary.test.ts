/**
 * The `ok` rule corpus carries no vocabulary from the mechanism it replaced.
 *
 * Corpus: `CORPUS_DIRS` and `TEST_DIRS`. Read the constants, not a paraphrase.
 * The conformance property catalogs are in scope because they describe rules
 * in prose and one of them drifted. That package does not ship, so its two
 * entries are the ones in `ABSENT_ON_MIRROR`; every other entry must
 * contribute a scanned file or the corpus test reds with the directory named.
 * The exemption is gated on the PACKAGE root rather than on those leaves,
 * because a leaf that vanishes is the condition being detected.
 *
 * Per precedent #42 (custom lint enforcement is oxlint JS-plugin rules), which
 * names the rule corpus this scans. Two vocabularies are banned and they come
 * from different retirements: `gritql` / `.grit` / `biome-plugins` are the
 * Biome GritQL mechanism precedent #42 was rewritten away from, and `bun run`
 * is Bun syntax retired by the earlier remove-bun migration. `biome-ignore`
 * and `biome check` are deliberately NOT banned: Biome is still a live linter
 * here alongside oxlint.
 *
 * `judgeDemotion` blanks true plugin references in two passes and tests for a
 * demotion between them. Every strip is length-preserving, because two of the
 * checks are bounded-distance patterns and deleting text would pull unrelated
 * words inside a window they were never in.
 *
 *   1. `REAL_PLUGIN_NAMES` — this repo's own plugin directories, read from
 *      disk so a third plugin needs no edit here. This one MUST run first:
 *      the names are kebab-cased, so ``no-comments plugin`` would otherwise
 *      false-fire `DEMOTED_UNAMBIGUOUS`'s kebab-identifier alternative.
 *   2. `DEMOTED_UNAMBIGUOUS` — a rule identifier next to `plugin`, optionally
 *      through an engine qualifier (`<rule> oxlint plugin`), or `plugin test`
 *      / `plugin fixture`. It runs BEFORE the remaining strips because either
 *      of them can span a demotion and delete the token this keys on. Two
 *      pinned cases assert exactly that, by running the same function with
 *      the order inverted.
 *   3. `ENGINE_PLUGINS` then `PLUGIN_AS_MODULE`, then `NEAR_RULE_VOCABULARY`
 *      on what survives. `ENGINE_PLUGINS` is a PHRASE strip rather than a
 *      line verdict: one unrelated engine token must not immunise a real
 *      demotion sitting beside it.
 *
 * `PLUGIN_AS_MODULE` holds module referents (a path, a file name, `plugin`
 * qualified by the module it names), the config key and code identifiers that
 * spell one, and `JS-plugin`, the one sanctioned category term, which about a
 * dozen corpus lines use for the rule mechanism itself.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

const CORPUS_DIRS = [
  'lint-plugins/ok-rules',
  'packages/app/tests/lint-plugins',
  'packages/app/src/lint-plugins',
  'packages/server/src/lint-plugins',
  'packages/md-conformance/src/lint-plugins',
  'packages/md-conformance/src/contracts',
];

const TEST_DIRS = [
  'packages/app/tests/integration',
  'packages/server/src',
  'packages/desktop/tests/integration',
];

const RETIRED = /gritql|\.grit\b|biome-plugins|bun run/i;

const HISTORICAL = /\b(?:retired|replaced|superseded|no longer|used to|formerly|migrat)/i;

const ENGINE_NAMES = ['GritQL', 'biome', 'eslint', 'remark', 'rehype', 'vite', 'babel', 'oxlint'];

const DEMOTED_UNAMBIGUOUS = new RegExp(
  [
    String.raw`\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+ (?:(?:${ENGINE_NAMES.join('|')}) )?plugins?\b`,
    String.raw`\bok/[a-z0-9-]+\b.{0,60}\bplugins?\b`,
    String.raw`\bplugins?\b\s*(?:test|fixture)\b`,
  ].join('|'),
  'i',
);

const ENGINE_PLUGINS = new RegExp(`\\b(?:${ENGINE_NAMES.join('|')})[- ]plugins?\\b`, 'gi');

function pluginDirNames(): string[] {
  const dir = join(REPO_ROOT, 'lint-plugins');
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  if (names.length === 0) {
    throw new Error(
      `ok-rules-vocabulary: ${relative(REPO_ROOT, dir)} lists no plugin directories. An empty ` +
        'alternation would strip every `plugin` token and green the gate.',
    );
  }
  return names;
}

const REAL_PLUGIN_NAMES = new RegExp(
  `\\b(?:${pluginDirNames()
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})\\b[^.]{0,3}(?:(?:${ENGINE_NAMES.join('|')}) )?plugins?\\b`,
  'gi',
);

const PLUGIN_AS_MODULE = new RegExp(
  [
    'lint-plugins',
    'jsPlugins',
    'plugin\\.mjs',
    'plugins\\.html',
    'JS[- ]plugins?',
    'packages/\\{[^}]*plugin[^}]*\\}',
    'packages/plugin',
    'index\\.(?:private\\.)?mjs',
    'lint/plugin/',
    'import plugin',
    'plugin\\.rules',
    '(?:`ok`|`\\.private\\.`) plugins?',
    'PLUGIN_NAME',
  ].join('|'),
  'gi',
);

const NEAR_RULE_VOCABULARY = new RegExp(
  [
    String.raw`\bplugins?\b\s*(?:test|fixture)`,
    String.raw`\b(?:rule|test|fixture)\b.{0,60}\bplugins?\b`,
    String.raw`\bplugins?\b.{0,60}\b(?:fires|must fire|fixture|test)\b`,
  ].join('|'),
  'i',
);

const SELF = 'packages/app/tests/lint-plugins/ok-rules-vocabulary.test.ts';

const MIRROR_ABSENT_PACKAGE_ROOT = 'packages/md-conformance';

const ABSENT_ON_MIRROR = [
  'packages/md-conformance/src/lint-plugins',
  'packages/md-conformance/src/contracts',
];

function ruleStems(): string[] {
  const dir = join(REPO_ROOT, 'lint-plugins/ok-rules/__fixtures__');
  if (!existsSync(dir)) {
    throw new Error(
      `ok-rules-vocabulary: ${relative(REPO_ROOT, dir)} is missing. Every rule's fixture lives ` +
        'there and it ships to the public mirror, so its absence means the corpus definition is ' +
        'wrong rather than that this is a reduced clone.',
    );
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith('.fixture.tsx'))
    .map((f) => f.replace(/\.fixture\.tsx$/, ''));
}

function walkCorpus(onFile: (file: string) => void): void {
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(mjs|ts|tsx|json|md)$/.test(entry)) onFile(full);
    }
  };
  for (const dir of CORPUS_DIRS) {
    const abs = join(REPO_ROOT, dir);
    if (existsSync(abs)) walk(abs);
  }
}

function posixRel(file: string): string {
  return relative(REPO_ROOT, file).split(sep).join('/');
}

function filesPerDir(): Map<string, number> {
  const counts = new Map<string, number>([...CORPUS_DIRS, ...TEST_DIRS].map((d) => [d, 0]));
  const bump = (dirs: readonly string[]) => (file: string) => {
    const rel = posixRel(file);
    if (rel === SELF) return;
    for (const dir of dirs) {
      if (rel.startsWith(`${dir}/`)) counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
  };
  walkCorpus(bump(CORPUS_DIRS));
  const bumpTestDir = bump(TEST_DIRS);
  for (const file of testDirFiles()) bumpTestDir(file);
  return counts;
}

function testDirFiles(): string[] {
  const stems = new Set(ruleStems());
  const found: string[] = [];
  for (const dir of TEST_DIRS) {
    const abs = join(REPO_ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs)) {
      if (!entry.endsWith('.test.ts')) continue;
      if (stems.has(entry.replace(/\.test\.ts$/, ''))) found.push(join(abs, entry));
    }
  }
  return found;
}

function corpusFiles(): string[] {
  const found: string[] = [];
  walkCorpus((file) => found.push(file));
  return [...new Set([...found, ...testDirFiles()])];
}

function readmeLine(startsWith: string): string {
  const lines = readFileSync(join(REPO_ROOT, 'lint-plugins/ok-rules/README.md'), 'utf-8').split(
    '\n',
  );
  const found = lines.filter((l) => l.startsWith(startsWith));
  if (found.length !== 1) {
    throw new Error(
      `ok-rules-vocabulary: expected exactly one README line starting "${startsWith}", found ` +
        `${found.length}. The pinned legitimate case must track a real line, not an index.`,
    );
  }
  return found[0];
}

function blank(line: string, pattern: RegExp): string {
  return line.replace(pattern, (m) => ' '.repeat(m.length));
}

function judgeDemotion(line: string, { demotedFirst = true } = {}): boolean {
  const named = blank(line, REAL_PLUGIN_NAMES);
  if (demotedFirst && DEMOTED_UNAMBIGUOUS.test(named)) return true;
  const residue = blank(blank(named, ENGINE_PLUGINS), PLUGIN_AS_MODULE);
  if (!demotedFirst && DEMOTED_UNAMBIGUOUS.test(residue)) return true;
  return /\bplugins?\b/i.test(residue) && NEAR_RULE_VOCABULARY.test(residue);
}

function scan(judge: (line: string) => boolean): string[] {
  const out: string[] = [];
  for (const file of corpusFiles()) {
    const rel = posixRel(file);
    if (rel === SELF) continue;
    readFileSync(file, 'utf-8')
      .split('\n')
      .forEach((line, i) => {
        if (judge(line)) out.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
  }
  return out;
}

describe('ok-rules corpus vocabulary', () => {
  test('every corpus directory contributes at least one scanned file', () => {
    const counts = filesPerDir();
    const missing = [...counts]
      .filter(([dir, n]) => n === 0 && !ABSENT_ON_MIRROR.includes(dir))
      .map(([dir]) => dir);
    expect(missing).toEqual([]);
  });

  test('every mirror-exempt entry lives under the one package the mirror drops', () => {
    expect(
      ABSENT_ON_MIRROR.filter((dir) => !dir.startsWith(`${MIRROR_ABSENT_PACKAGE_ROOT}/`)),
    ).toEqual([]);
  });

  test('on a full checkout the exempt directories are held to the same standard', () => {
    if (!existsSync(join(REPO_ROOT, MIRROR_ABSENT_PACKAGE_ROOT))) return;
    const counts = filesPerDir();
    expect(ABSENT_ON_MIRROR.filter((dir) => (counts.get(dir) ?? 0) === 0)).toEqual([]);
  });

  test('demotion detection survives an engine name and a spanning phrase', () => {
    const demotions = [
      'The no-hand-rolled-spinner plugin registers exactly 5 diagnostics.',
      'The GritQL era is over; the no-hand-rolled-spinner plugin registers exactly 5 diagnostics.',
      'The GritQL plugins were slow; the no-hand-rolled-spinner plugin fires on its fixture.',
      'The sibling plugin fires twice on that fixture.',
      'what the plugin test counts',
      "the oxlint path-conditional-origin plugin's enforcement target",
      'the ok/no-hand-rolled-spinner oxlint plugin fires on its fixture.',
      'the path-conditional-origin oxlint plugin fires on its fixture.',
    ];
    for (const line of demotions) expect(judgeDemotion(line), line).toBe(true);

    const legitimate = [
      readmeLine('One plugin holding every rule is deliberate'),
      'This rule ships as its own `.private.` plugin rather than inside the `ok` plugin.',
      "describe('no-comments oxlint plugin', () => {",
      ...pluginDirNames().map((name) => `the ${name} plugin fires on that fixture`),
      'the rehype clipboard cleanup plugins (eight strip-* plugins plus a skipper)',
    ];
    for (const line of legitimate) expect(judgeDemotion(line), line).toBe(false);
  });

  test('the stage order is load-bearing, not incidental', () => {
    for (const orderSensitive of [
      'the `ok` plugin test',
      'the ok/no-hand-rolled-spinner oxlint plugin fires on its fixture.',
    ]) {
      expect(judgeDemotion(orderSensitive), orderSensitive).toBe(true);
      expect(judgeDemotion(orderSensitive, { demotedFirst: false }), orderSensitive).toBe(false);
    }
  });

  test('no file names the retired GritQL or Bun mechanism as if it were current', () => {
    expect(scan((line) => RETIRED.test(line) && !HISTORICAL.test(line))).toEqual([]);
  });

  test('no file calls an ok rule a plugin', () => {
    expect(scan(judgeDemotion)).toEqual([]);
  });
});
