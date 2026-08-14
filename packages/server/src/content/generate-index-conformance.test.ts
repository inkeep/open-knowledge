/**
 * The acceptance harness for the generator: whatever it emits must satisfy the
 * `okf` plugin that checks for it, and every link it writes must resolve.
 *
 * Both halves matter independently. The lint half proves the output conforms to
 * the format; the link half proves it conforms to THIS substrate — a bare folder
 * href passes every OKF rule while reading as broken to our own validator,
 * which is exactly the trap the hand-written seeded index fell into.
 */

import {
  DEFAULT_LINTER_CONFIG,
  type LinterConfig,
  lintDocument,
} from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { computeBrokenOutboundLinks } from '../backlink-index.ts';
import { buildIndexMarkdown, type IndexEntry } from './generate-index.ts';

// Only `okf` is on: this suite is about OKF conformance, and folding in
// markdownlint or frontmatter findings would blur which contract regressed.
const OKF_LINT_CONFIG: LinterConfig = {
  ...DEFAULT_LINTER_CONFIG,
  enabled: true,
  plugins: { ...DEFAULT_LINTER_CONFIG.plugins, okf: { enabled: true } },
};

/** A bundle broad enough to exercise every branch the formatter has. */
const ENTRIES: IndexEntry[] = [
  {
    path: 'welcome.md',
    title: 'Welcome',
    description: 'what this knowledge base is and how it is organized',
    type: 'note',
  },
  {
    path: 'concepts/bounded-context.md',
    title: 'Bounded Context',
    description: 'where a model stops applying',
    type: 'concept',
  },
  {
    path: 'concepts/ubiquitous-language.md',
    title: 'Ubiquitous Language',
    description: undefined,
    type: 'concept',
  },
  { path: 'scratch.md', title: 'Scratch', description: undefined, type: undefined },
];

const ADMITTED = ['index', ...ENTRIES.map((e) => e.path.replace(/\.md$/, ''))];

describe('generated index — OKF conformance', () => {
  test('the generated root index produces zero okf findings', async () => {
    const markdown = buildIndexMarkdown(ENTRIES, { isRoot: true });

    // Lint under the reserved name, since index-shape, frontmatter-root-index
    // and reserved-casing are all name-scoped — linting it as any other doc
    // would silently skip the rules this output has to satisfy.
    const findings = await lintDocument(markdown, OKF_LINT_CONFIG, 'index.md');
    const detail = findings
      .map((f) => `${f.code} @ ${f.range.start.line + 1} — ${f.message}`)
      .join('; ');

    expect(findings, `generated root index produced okf findings: ${detail}`).toEqual([]);
  });

  test('a generated non-root index produces zero okf findings', async () => {
    // Not generated today (scope is root-only), but the formatter already takes
    // isRoot and the rule that governs a nested index is stricter than the
    // root's: frontmatter-reserved-index pins maxProperties 0, so a stray
    // okf_version here would warn. Pin it now, while the branch is cheap.
    const markdown = buildIndexMarkdown(ENTRIES, { isRoot: false });
    const findings = await lintDocument(markdown, OKF_LINT_CONFIG, 'concepts/index.md');

    expect(findings.map((f) => f.code)).toEqual([]);
  });

  test('an empty bundle still yields a conformant root index', async () => {
    const markdown = buildIndexMarkdown([], { isRoot: true });
    const findings = await lintDocument(markdown, OKF_LINT_CONFIG, 'index.md');
    expect(findings.map((f) => f.code)).toEqual([]);
  });

  test('every link in the generated index resolves', () => {
    const markdown = buildIndexMarkdown(ENTRIES, { isRoot: true });
    const broken = computeBrokenOutboundLinks(markdown, 'index', ADMITTED);

    expect(
      broken,
      `generated index emitted unresolvable links: ${broken.map((b) => b.href).join(', ')}`,
    ).toEqual([]);
  });

  test('a bare folder href would be caught — the guard is not vacuous', () => {
    // The discriminating check: prove computeBrokenOutboundLinks actually fires
    // on the form we deliberately avoid. Without this, the assertion above
    // passes just as well against a generator that emits nothing at all.
    const withFolderLink = ['# concept', '', '* [concepts/](./concepts/) - a folder', ''].join(
      '\n',
    );
    const broken = computeBrokenOutboundLinks(withFolderLink, 'index', ADMITTED);

    expect(broken.map((b) => b.href)).toEqual(['./concepts/']);
  });
});

// Kept separate from the okf-only config above rather than folded into it: which
// contract a finding belongs to stays legible, and these are different claims.
// The okf suite asks whether the output conforms to the FORMAT; this one asks
// whether it conforms to the LINT PROFILE the author is running, which is what
// decides if a generated file they cannot hand-edit shows up in their Problems
// list. Conforming to one does not imply the other — multiple level-one section
// headings satisfy every okf rule and are MD025.
const DEFAULT_PROFILE_LINT_CONFIG: LinterConfig = {
  ...DEFAULT_LINTER_CONFIG,
  enabled: true,
  plugins: {
    ...DEFAULT_LINTER_CONFIG.plugins,
    markdownlint: { ...DEFAULT_LINTER_CONFIG.plugins.markdownlint, enabled: true },
    okf: { enabled: true },
  },
};

async function findingCodes(markdown: string, docName: string): Promise<string[]> {
  const findings = await lintDocument(markdown, DEFAULT_PROFILE_LINT_CONFIG, docName);
  return findings.map((f) => `${f.code} @ ${f.range.start.line + 1} — ${f.message}`);
}

describe('generated index — default lint profile', () => {
  test('the generated root index is clean under markdownlint defaults', async () => {
    expect(await findingCodes(buildIndexMarkdown(ENTRIES, { isRoot: true }), 'index.md')).toEqual(
      [],
    );
  });

  test('a generated non-root index is clean under markdownlint defaults', async () => {
    expect(
      await findingCodes(buildIndexMarkdown(ENTRIES, { isRoot: false }), 'concepts/index.md'),
    ).toEqual([]);
  });

  test('an empty bundle is clean under markdownlint defaults', async () => {
    expect(await findingCodes(buildIndexMarkdown([], { isRoot: true }), 'index.md')).toEqual([]);
  });

  test('a Subdirectories document type plus a child directory is clean under markdownlint defaults', async () => {
    const markdown = buildIndexMarkdown(
      [
        {
          path: 'concepts/directory-notes.md',
          title: 'Directory notes',
          type: 'Subdirectories',
        },
      ],
      {
        isRoot: false,
        directory: 'concepts',
        subdirectories: [{ path: 'concepts/nested/index.md', title: 'nested' }],
      },
    );

    expect(await findingCodes(markdown, 'concepts/index.md')).toEqual([]);
  });

  test('level-one sections would be caught — the guard is not vacuous', async () => {
    // The shape this generator used to emit. Proving it still fires is what
    // keeps the assertions above from passing under a linter that silently
    // stopped running markdownlint at all — the exact way this gap went unseen.
    const levelOneSections = [
      '---',
      'okf_version: "0.2"',
      '---',
      '',
      '# concept',
      '',
      '* [Bounded Context](./concepts/bounded-context.md) - where a model stops applying',
      '',
      '# note',
      '',
      '* [Welcome](./welcome.md) - what this knowledge base is',
      '',
    ].join('\n');

    expect(await findingCodes(levelOneSections, 'index.md')).toEqual([
      expect.stringContaining('MD025'),
    ]);
  });

  test('demoting sections without a title would be caught too', async () => {
    // The other half of the squeeze: sections at level two and no level-one
    // heading trips MD041 instead. Pinning both is what makes the title and the
    // section level jointly load-bearing rather than one arbitrary choice.
    const noTitle = ['## concept', '', '* [Bounded Context](./concepts/bounded-context.md)', ''];

    expect(await findingCodes(noTitle.join('\n'), 'concepts/index.md')).toEqual([
      expect.stringContaining('MD041'),
    ]);
  });
});
