import {
  DEFAULT_LINTER_CONFIG,
  type LinterConfig,
  lintDocument,
} from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { computeBrokenOutboundLinks } from '../backlink-index.ts';
import { buildIndexMarkdown, type IndexEntry } from './generate-index.ts';

const OKF_LINT_CONFIG: LinterConfig = {
  ...DEFAULT_LINTER_CONFIG,
  enabled: true,
  plugins: { ...DEFAULT_LINTER_CONFIG.plugins, okf: { enabled: true } },
};

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

    const findings = await lintDocument(markdown, OKF_LINT_CONFIG, 'index.md');
    const detail = findings
      .map((f) => `${f.code} @ ${f.range.start.line + 1} — ${f.message}`)
      .join('; ');

    expect(findings, `generated root index produced okf findings: ${detail}`).toEqual([]);
  });

  test('a generated non-root index produces zero okf findings', async () => {
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
    const withFolderLink = ['# concept', '', '* [concepts/](./concepts/) - a folder', ''].join(
      '\n',
    );
    const broken = computeBrokenOutboundLinks(withFolderLink, 'index', ADMITTED);

    expect(broken.map((b) => b.href)).toEqual(['./concepts/']);
  });
});

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
    const readmeOnly = buildIndexMarkdown(
      [{ path: 'testing/README.md', title: 'Testing', type: 'Index' }],
      { isRoot: false, directory: 'testing' },
    );

    expect(await findingCodes(readmeOnly, 'testing/index.md')).toEqual([]);
  });

  test('an Index document type alongside other typed sections is clean under markdownlint defaults', async () => {
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
    const duplicateHeading = ['# Index', '', '## Index', '', '* [Testing](./README.md)', ''];

    expect(await findingCodes(duplicateHeading.join('\n'), 'testing/index.md')).toEqual([
      expect.stringContaining('MD024'),
    ]);
  });

  test('level-one sections would be caught — the guard is not vacuous', async () => {
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
    const noTitle = ['## concept', '', '* [Bounded Context](./concepts/bounded-context.md)', ''];

    expect(await findingCodes(noTitle.join('\n'), 'concepts/index.md')).toEqual([
      expect.stringContaining('MD041'),
    ]);
  });
});

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

  test.each([
    ['Index'],
    ['Index #'],
    ['Index   ##'],
    ['<b></b>Index'],
    ['Index<!--x-->'],
    ['Index<!-- a>b -->'],
    ['Index<a href="x>y">'],
  ])('a type reducing to the title merges into it: %j', async (type) => {
    const markdown = withType(type);

    expect(mdOnly(await findingCodes(markdown, 'index.md')), `emitted:\n${markdown}`).toEqual([]);
    expect(markdown, `emitted:\n${markdown}`).toContain('](./readme.md)');
  });

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
    expect(codes.some((code) => code.includes('MD033'))).toBe(true);
  });

  test('a duplicate reached through an ATX closer would be caught — the guard is not vacuous', async () => {
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
