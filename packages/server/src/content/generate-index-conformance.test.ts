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

  test('an Index document type is clean under markdownlint defaults', async () => {
    // `Index` is an ordinary OKF type — a folder README that indexes its folder
    // declares it — and it lands in the same heading namespace as the
    // generator's own title. MD024 compares heading CONTENT across levels, so
    // the title and a `type`-derived section collide even at different levels.
    const readmeOnly = buildIndexMarkdown(
      [{ path: 'testing/README.md', title: 'Testing', type: 'Index' }],
      { isRoot: false, directory: 'testing' },
    );

    expect(await findingCodes(readmeOnly, 'testing/index.md')).toEqual([]);
  });

  test('an Index document type alongside other typed sections is clean under markdownlint defaults', async () => {
    // The collision is not a property of README-only directories. A directory
    // carrying several typed sections plus one `Index`-typed document collides
    // just the same, so a fix that only holds for the single-entry shape
    // under-covers the contract.
    const multiSection = buildIndexMarkdown(
      [
        { path: 'auth/README.md', title: 'Auth', type: 'Index' },
        { path: 'auth/login-flow.md', title: 'Login flow', type: 'Flow' },
        { path: 'auth/sso.md', title: 'SSO', type: 'Feature Doc' },
      ],
      { isRoot: false, directory: 'auth' },
    );

    expect(await findingCodes(multiSection, 'auth/index.md')).toEqual([]);
  });

  test('a root index with an Index document type is clean under markdownlint defaults', async () => {
    // The root branch renders the same headings behind frontmatter, so it
    // carries the collision independently of the non-root branch.
    const markdown = buildIndexMarkdown(
      [
        { path: 'README.md', title: 'Knowledge base', type: 'Index' },
        { path: 'welcome.md', title: 'Welcome', type: 'note' },
      ],
      { isRoot: true },
    );

    expect(await findingCodes(markdown, 'index.md')).toEqual([]);
  });

  test('a duplicate heading would be caught — the guard is not vacuous', async () => {
    // The third leg of the squeeze, alongside MD025 and MD041 below. Proving
    // MD024 fires on the shape the generator must avoid is what keeps the
    // assertions above from passing under a linter that silently stopped
    // running markdownlint, or a generator that emits no sections at all.
    const duplicateHeading = ['# Index', '', '## Index', '', '* [Testing](./README.md)', ''];

    expect(await findingCodes(duplicateHeading.join('\n'), 'testing/index.md')).toEqual([
      expect.stringContaining('MD024'),
    ]);
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

// The generator decides which sections share a bucket by mirroring the identity
// MD024 compares headings by. That mirror is a coupling to another tool's
// internals, so it is pinned from the outside rather than trusted: this suite
// runs `type` values through the real generator and the real linter and fails if
// the two ever disagree about whether a collision exists.
describe('generated index — heading-identity agreement with MD024', () => {
  const mdOnly = (codes: string[]): string[] => codes.filter((code) => code.includes('MD024'));

  const withType = (type: string): string =>
    buildIndexMarkdown(
      [
        { path: 'readme.md', title: 'Overview', description: undefined, type },
        { path: 'flow.md', title: 'Login flow', description: undefined, type: 'Flow' },
      ],
      { isRoot: false, directory: '' },
    );

  // Values that reduce to the title's content without being the title's string.
  // Each is conformant frontmatter, since `type` is constrained only to be
  // non-blank.
  test.each([
    ['Index'],
    ['Index #'],
    ['Index   ##'],
    ['<b></b>Index'],
    ['Index<!--x-->'],
    // Raw HTML may legally contain `>` inside a comment or a quoted attribute
    // value (CommonMark §6.6). A `<[^>]*>` strip stops at the first one and
    // leaves behind text the rule discards — narrowing, which reopens the
    // duplicate rather than merely costing a section.
    ['Index<!-- a>b -->'],
    ['Index<a href="x>y">'],
  ])('a type reducing to the title merges into it: %j', async (type) => {
    const markdown = withType(type);

    expect(mdOnly(await findingCodes(markdown, 'index.md')), `emitted:\n${markdown}`).toEqual([]);
    expect(markdown, `emitted:\n${markdown}`).toContain('](./readme.md)');
  });

  // `index` and `INDEX` matter because MD024's comparison is case sensitive, so
  // folding them would merge documents the linter is content to see side by side.
  //
  // The two HTML-wrapped `#` values belong here rather than above: the `#` sits
  // inside an element, so it is never a closing sequence, and the heading text
  // keeps it. They read as near-misses and are not — which is why they are worth
  // pinning on this side, where over-merging would be the failure.
  test.each([
    ['index'],
    ['INDEX'],
    ['Indexes'],
    ['Index Notes'],
    ['Flow'],
    ['Index <b>#</b>'],
    ['Index<b> #</b>'],
  ])('a type distinct from the title keeps its own section: %j', async (type) => {
    const markdown = withType(type);

    expect(markdown, `emitted:\n${markdown}`).toContain(`## ${type}`);
    expect(mdOnly(await findingCodes(markdown, 'index.md')), `emitted:\n${markdown}`).toEqual([]);
  });

  test.each([
    [['#', '##']],
    [['#', '<b></b>']],
    [['<b></b>', '<i></i>']],
  ])('types whose rendered heading text is empty merge with each other: %j', async (pair) => {
    // A heading of only hashes or only HTML has no text, and the rule compares
    // those to each other and calls them duplicates. Giving them a bucket each
    // emits two headings it flags, so the empty identity has to collapse like
    // any other. Nothing is invented by merging: the spelling is chosen by the
    // same reduction every bucket uses.
    const markdown = buildIndexMarkdown(
      [
        { path: 'a.md', title: 'A', description: undefined, type: pair[0] },
        { path: 'b.md', title: 'B', description: undefined, type: pair[1] },
      ],
      { isRoot: false, directory: '' },
    );

    expect(mdOnly(await findingCodes(markdown, 'index.md')), `emitted:\n${markdown}`).toEqual([]);
    expect(markdown).toContain('](./a.md)');
    expect(markdown).toContain('](./b.md)');

    // The heading has to be one of the colliding types. Without this the rows
    // pass against a generator that never merges and instead routes an
    // empty-reducing `type` to `Other` — a natural-looking simplification whose
    // outcome is two documents filed as untyped when neither is, in a file the
    // author cannot hand-edit. The sibling suite pins the other direction, that
    // a blank `type` IS absent, so both classifications stay pinned.
    const sections = (markdown.match(/^## .+$/gm) ?? []).map((line) => line.slice(3));
    expect(sections, `emitted:\n${markdown}`).toHaveLength(1);
    expect(pair, `emitted:\n${markdown}`).toContain(sections[0]);
  });

  test('two derived sections reducing to the same content merge with each other', async () => {
    const markdown = buildIndexMarkdown(
      [
        { path: 'a.md', title: 'A', description: undefined, type: 'Flow' },
        { path: 'b.md', title: 'B', description: undefined, type: 'Flow #' },
      ],
      { isRoot: false, directory: '' },
    );

    expect(mdOnly(await findingCodes(markdown, 'index.md')), `emitted:\n${markdown}`).toEqual([]);
    expect(markdown).toContain('](./a.md)');
    expect(markdown).toContain('](./b.md)');
  });

  test('two empty headings would be caught — the guard is not vacuous', async () => {
    // The third reduction needs its own leg for the same reason the other two
    // do. After the merge, an empty-reducing pair emits a single heading and the
    // rule has nothing to compare, so those rows hold whether or not it treats
    // two empty headings as duplicates. Only a hand-built pair keeps both to the
    // comparison, which is what makes the merge a fix rather than a coincidence.
    const handBuilt = [
      '# Index',
      '',
      '* [Overview](./readme.md)',
      '',
      '## #',
      '',
      '* [A](./a.md)',
      '',
      '## <b></b>',
      '',
      '* [B](./b.md)',
      '',
    ].join('\n');

    expect(mdOnly(await findingCodes(handBuilt, 'index.md')), `emitted:\n${handBuilt}`).toEqual([
      expect.stringContaining('MD024'),
    ]);
  });

  test('a duplicate reached through inline HTML would be caught — the guard is not vacuous', async () => {
    // The identity makes two reductions and each needs its own leg. The corpus
    // rows cannot supply this one: the generator merges an HTML-bearing type
    // into the title's bucket before the linter sees it, so the emitted file has
    // a single heading and MD024 has nothing to compare — the row then passes
    // whether the merge was necessary or not. Hand-building both headings is
    // what proves the linter really does drop `htmlText` when comparing, and so
    // that the merge closes a live failure rather than an imagined one.
    const handBuilt = [
      '# Index',
      '',
      '* [Overview](./readme.md)',
      '',
      '## <b></b>Index',
      '',
      '* [Other](./other.md)',
      '',
    ].join('\n');

    const codes = await findingCodes(handBuilt, 'index.md');

    expect(mdOnly(codes), `emitted:\n${handBuilt}`).toEqual([expect.stringContaining('MD024')]);
    // MD033 rides along on the same line, which is the class tracked separately.
    // Asserting it here keeps this leg honest about what the fixture really is.
    expect(codes.some((code) => code.includes('MD033'))).toBe(true);
  });

  test('a duplicate reached through an ATX closer would be caught — the guard is not vacuous', async () => {
    // Proves the linter really does reduce `## Index #` to `Index` and flag it,
    // so the merges asserted above close a live failure rather than one this
    // profile never reported in the first place.
    const handBuilt = [
      '# Index',
      '',
      '* [Overview](./readme.md)',
      '',
      '## Index #',
      '',
      '* [Other](./other.md)',
      '',
    ].join('\n');

    expect(mdOnly(await findingCodes(handBuilt, 'index.md'))).toEqual([
      expect.stringContaining('MD024'),
    ]);
  });
});
