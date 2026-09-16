import assert from 'node:assert/strict';
import {
  MarkdownManager,
  resolveInternalHref,
  sharedExtensions,
} from '@inkeep/open-knowledge-core';
import type { JSONContent } from '@tiptap/core';
import { describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { getLogger } from '../logger.ts';
import { extractPageDescription, extractPageTitle, extractPageType } from '../page-identity.ts';
import {
  buildIndexMarkdown,
  createGeneratedIndexWarningScope,
  type IndexEntry,
} from './generate-index.ts';
import { type GeneratedArtifactEnv, writeGeneratedArtifact } from './generated-artifact.ts';
import { planDirectoryIndexRegenerations } from './regenerate-index.ts';

const markdownManager = new MarkdownManager({ extensions: sharedExtensions });

const MARKDOWN_METACHARACTER_CORPUS = [
  'stars *emphasis* and **strong**',
  'underscore _under_',
  'strike ~~gone~~',
  'code `value`',
  'highlight ==marked==',
  'math $x+1$',
  'wiki [[Target]]',
  'HTML <u>raw</u>',
  'comment <!--hidden-->',
  'MDX <Widget />',
  'link [extra](https://example.test)',
  'image ![pixel](https://example.test/pixel.png)',
  'autolink <https://example.test/auto>',
  'entities &amp; and &#65;',
  'backslash \\',
  'brackets [literal]',
  'heading close #',
].join('; ');

const PORTABLE_PATH_CORPUS = 'folder _under_ ~~gone~~ ==marked== $x+1$ [literal]';

const RESIDUAL_CONTROL_CODE_POINTS = [
  ...Array.from({ length: 0x20 }, (_, codePoint) => codePoint).filter(
    (codePoint) => codePoint < 0x09 || codePoint > 0x0d,
  ),
  ...Array.from({ length: 0x21 }, (_, offset) => offset + 0x7f),
];

const RESIDUAL_CONTROL_CORPUS = String.fromCodePoint(...RESIDUAL_CONTROL_CODE_POINTS);

const BIDI_OVERRIDE_PENDING_POLICY = '\u202e';

const ZERO_WIDTH_AND_JOINING_CONTROLS = '\u200b\u200c\u200d';

const CONTROL_BEARING_LITERAL = `Cafe\u0301\t\n\v\f\rLabel${RESIDUAL_CONTROL_CORPUS}`;

const NORMALIZED_CONTROL_LITERAL = `Cafe\u0301 Label${'\ufffd'.repeat(RESIDUAL_CONTROL_CODE_POINTS.length)}`;

const PARSER_RESERVATION_TRACER = {
  literal: 'Note\ue102x',
  normalizedLiteral: 'Note\ufffdx',
};

const ADDITIONAL_MUTATING_PARSER_RESERVATION_CASES = [
  {
    reservation: 'R23 secondary U+E005',
    literal: 'Note\ue005x',
    normalizedLiteral: 'Note\ufffdx',
  },
  {
    reservation: 'R23 secondary U+E006',
    literal: 'Note\ue006x',
    normalizedLiteral: 'Note\ufffdx',
  },
  {
    reservation: 'R23 secondary U+E007',
    literal: 'Note\ue007x',
    normalizedLiteral: 'Note\ufffdx',
  },
  {
    reservation: 'R23 secondary U+E008',
    literal: 'Note\ue008x',
    normalizedLiteral: 'Note\ufffdx',
  },
  {
    reservation: 'R23 secondary U+E009',
    literal: 'Note\ue009x',
    normalizedLiteral: 'Note\ufffdx',
  },
  {
    reservation: 'entity delimiter pair U+E100-U+E101',
    literal: 'Note\ue100amp\ue101x',
    normalizedLiteral: 'Note\ufffdamp\ufffdx',
  },
  {
    reservation: 'typed whitespace U+E103',
    literal: 'Note\ue103x',
    normalizedLiteral: 'Note\ufffdx',
  },
];

const COLLISION_DEFENDED_PARSER_RESERVATION_CORPUS = `before${String.fromCodePoint(
  ...Array.from({ length: 5 }, (_, offset) => 0xe000 + offset),
  ...Array.from({ length: 0xf8ff - 0xe200 + 1 }, (_, offset) => 0xe200 + offset),
)}after`;

const GENERATED_NODE_TYPES = new Set(['doc', 'heading', 'list', 'listItem', 'paragraph', 'text']);
const GENERATED_MARK_TYPES = new Set(['escapeMark', 'link', 'sourceLiteral']);

const GENERATED_ARTIFACT_ORIGIN = Object.freeze({
  source: 'local' as const,
  skipStoreHooks: false,
  context: Object.freeze({ origin: 'generated-index-literal-metadata', paired: true as const }),
});

const GENERATED_ARTIFACT_WRITER: GeneratedArtifactEnv['writer'] = {
  id: 'ok-generator',
  name: 'OpenKnowledge (generated)',
  email: 'ok-generator@openknowledge.local',
};

function walkJson(root: JSONContent): JSONContent[] {
  const nodes: JSONContent[] = [];
  const visit = (node: JSONContent): void => {
    nodes.push(node);
    node.content?.forEach(visit);
  };
  visit(root);
  return nodes;
}

function textContent(root: JSONContent): string {
  if (root.text !== undefined) return root.text;
  return root.content?.map(textContent).join('') ?? '';
}

function hasResidualControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.charCodeAt(0);
    return (
      codePoint <= 0x08 ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    );
  });
}

function linkHrefs(root: JSONContent): string[] {
  return walkJson(root).flatMap((node) =>
    (node.marks ?? [])
      .filter((mark) => mark.type === 'link')
      .map((mark) => String(mark.attrs?.href ?? '')),
  );
}

function expectLiteralThroughEditor(
  markdown: string,
  literal: string,
  intendedHrefs: readonly string[],
): void {
  const parsed = markdownManager.parse(markdown);
  const serializedOnce = markdownManager.serialize(parsed);
  const reparsed = markdownManager.parse(serializedOnce);
  const stages = [
    ['initial parse', parsed],
    ['parse after serialization', reparsed],
  ] as const;

  for (const [stage, document] of stages) {
    const nodes = walkJson(document);
    const unexpectedNodeTypes = [
      ...new Set(
        nodes
          .map((node) => node.type ?? '(missing)')
          .filter((type) => !GENERATED_NODE_TYPES.has(type)),
      ),
    ].toSorted();
    const unexpectedMarkTypes = [
      ...new Set(
        nodes
          .flatMap((node) => node.marks ?? [])
          .map((mark) => mark.type)
          .filter((type) => !GENERATED_MARK_TYPES.has(type)),
      ),
    ].toSorted();

    expect.soft(textContent(document), stage).toContain(literal);
    expect.soft(unexpectedNodeTypes, stage).toEqual([]);
    expect.soft(unexpectedMarkTypes, stage).toEqual([]);
    expect
      .soft([...new Set(linkHrefs(document))].toSorted(), stage)
      .toEqual([...new Set(intendedHrefs)].toSorted());
  }

  expect(markdownManager.serialize(reparsed)).toBe(serializedOnce);
}

function expectInitialEditorStability(
  markdown: string,
  expectedMarkdown: string,
  literal: string,
  intendedHrefs: readonly string[],
): void {
  expectLiteralThroughEditor(markdown, literal, intendedHrefs);
  expect(markdown).toBe(expectedMarkdown);
  expect(markdownManager.serialize(markdownManager.parse(markdown))).toBe(expectedMarkdown);
}

interface ParsedSection {
  level: number;
  heading: string;
  hrefs: string[];
}

function parsedSections(root: JSONContent): ParsedSection[] {
  const sections: ParsedSection[] = [];
  let current: ParsedSection | undefined;

  for (const node of root.content ?? []) {
    if (node.type === 'heading') {
      current = {
        level: Number(node.attrs?.level),
        heading: textContent(node),
        hrefs: [],
      };
      sections.push(current);
      continue;
    }
    current?.hrefs.push(...linkHrefs(node));
  }

  return sections;
}

function expectGroupingThroughEditor(
  markdown: string,
  expectedSections: readonly ParsedSection[],
  intendedHrefs: readonly string[],
): void {
  const parsed = markdownManager.parse(markdown);
  const serializedOnce = markdownManager.serialize(parsed);
  const reparsed = markdownManager.parse(serializedOnce);
  const stages = [
    ['initial parse', parsed],
    ['parse after serialization', reparsed],
  ] as const;

  for (const [stage, document] of stages) {
    const nodes = walkJson(document);
    const unexpectedNodeTypes = [
      ...new Set(
        nodes
          .map((node) => node.type ?? '(missing)')
          .filter((type) => !GENERATED_NODE_TYPES.has(type)),
      ),
    ].toSorted();
    const unexpectedMarkTypes = [
      ...new Set(
        nodes
          .flatMap((node) => node.marks ?? [])
          .map((mark) => mark.type)
          .filter((type) => !GENERATED_MARK_TYPES.has(type)),
      ),
    ].toSorted();

    expect.soft(parsedSections(document), stage).toEqual(expectedSections);
    expect.soft(unexpectedNodeTypes, stage).toEqual([]);
    expect.soft(unexpectedMarkTypes, stage).toEqual([]);
    expect
      .soft([...new Set(linkHrefs(document))].toSorted(), stage)
      .toEqual([...new Set(intendedHrefs)].toSorted());
  }

  expect(markdownManager.serialize(reparsed)).toBe(serializedOnce);
}

function generatedArtifactEnv(
  document: Y.Doc | undefined,
  captureDiskMarkdown: (markdown: string) => void,
): GeneratedArtifactEnv {
  return {
    origin: GENERATED_ARTIFACT_ORIGIN,
    writer: GENERATED_ARTIFACT_WRITER,
    isConflict: () => false,
    getDocument: () => document,
    writeDisk: (_absPath, markdown) => captureDiskMarkdown(markdown),
    registerWrite: () => undefined,
    noteFileIndex: () => undefined,
    signalFiles: () => undefined,
    attribute: () => Promise.resolve(),
  };
}

const metadataSource = [
  '---',
  `title: '${MARKDOWN_METACHARACTER_CORPUS}'`,
  `description: '${MARKDOWN_METACHARACTER_CORPUS}'`,
  `type: '${MARKDOWN_METACHARACTER_CORPUS}'`,
  '---',
  '',
  '# Fallback',
  '',
].join('\n');

const extractedTitle = extractPageTitle(metadataSource, 'fallback');
const extractedDescription = extractPageDescription(metadataSource);
const extractedType = extractPageType(metadataSource);

const FIELD_CASES: Array<{ field: string; entry: IndexEntry }> = [
  {
    field: 'title',
    entry: {
      path: 'guides/entry.md',
      title: extractedTitle,
      description: 'Plain description',
      type: 'Guide',
    },
  },
  {
    field: 'description',
    entry: {
      path: 'guides/entry.md',
      title: 'Plain title',
      description: extractedDescription,
      type: 'Guide',
    },
  },
  {
    field: 'type',
    entry: {
      path: 'guides/entry.md',
      title: 'Plain title',
      description: 'Plain description',
      type: extractedType,
    },
  },
];

interface LiteralSurfaceCase {
  surface: string;
  render: (literal: string) => { markdown: string; hrefs: string[] };
  expected: (literal: string, pathLiteral: string) => string;
}

const LITERAL_SURFACE_CASES: LiteralSurfaceCase[] = [
  {
    surface: 'title metadata',
    render: (literal) => ({
      markdown: buildIndexMarkdown(
        [{ path: 'guides/entry.md', title: literal, description: 'Plain', type: 'Guide' }],
        { warningScope: false, isRoot: false, directory: 'guides' },
      ),
      hrefs: ['./entry.md'],
    }),
    expected: (literal) => `# Index\n\n## Guide\n\n* [${literal}](./entry.md) - Plain\n`,
  },
  {
    surface: 'description metadata',
    render: (literal) => ({
      markdown: buildIndexMarkdown(
        [{ path: 'guides/entry.md', title: 'Plain', description: literal, type: 'Guide' }],
        { warningScope: false, isRoot: false, directory: 'guides' },
      ),
      hrefs: ['./entry.md'],
    }),
    expected: (literal) => `# Index\n\n## Guide\n\n* [Plain](./entry.md) - ${literal}\n`,
  },
  {
    surface: 'type metadata',
    render: (literal) => ({
      markdown: buildIndexMarkdown(
        [{ path: 'guides/entry.md', title: 'Plain', description: 'Plain', type: literal }],
        { warningScope: false, isRoot: false, directory: 'guides' },
      ),
      hrefs: ['./entry.md'],
    }),
    expected: (literal) => `# Index\n\n## ${literal}\n\n* [Plain](./entry.md) - Plain\n`,
  },
  {
    surface: 'derived folder label',
    render: (literal) => {
      const guides = planDirectoryIndexRegenerations({
        warningScope: false,
        docs: [[`guides/${literal}/entry`, { title: 'Entry', type: 'Guide' }]],
        docExtension: () => '.md',
        currentMarkdownFor: () => null,
      }).find((decision) => decision.directory === 'guides');
      assert(guides);
      return {
        markdown: guides.markdown,
        hrefs: [`./${encodeURIComponent(literal)}/index.md`],
      };
    },
    expected: (literal, pathLiteral) =>
      `# Index\n\n## Subdirectories\n\n* [${literal}](./${encodeURIComponent(pathLiteral)}/index.md)\n`,
  },
];

describe('generated index literal metadata', () => {
  test.each([
    {
      kind: 'control',
      folderLabel: 'control\u007ffolder',
      message: 'generated index metadata contained a Cc control; replaced it with U+FFFD',
    },
    {
      kind: 'parser-reservation',
      folderLabel: `parser${PARSER_RESERVATION_TRACER.literal}folder`,
      message:
        'generated index metadata contained a parser-reserved private-use code point; replaced it with U+FFFD',
    },
  ])(
    '$kind substitution attributes and rearms the source folder label',
    ({ kind, folderLabel, message }) => {
      const warn = vi.spyOn(getLogger('generated-index'), 'warn').mockImplementation(() => {});
      const warningScope = createGeneratedIndexWarningScope('/projects/folder-label/content');
      const sourceDirectory = `guides/${folderLabel}`;
      const corruptDocs = [
        [`${sourceDirectory}/entry`, { title: 'Entry', type: 'Guide' }],
      ] as const;
      const cleanDocs = [['guides/clean-folder/entry', { title: 'Entry', type: 'Guide' }]] as const;
      const plan = (docs: typeof corruptDocs | typeof cleanDocs) =>
        planDirectoryIndexRegenerations({
          docs,
          docExtension: () => '.md',
          currentMarkdownFor: () => null,
          warningScope,
        });

      try {
        plan(corruptDocs);
        plan(corruptDocs);
        expect(warn).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(
          {
            contentDir: '/projects/folder-label/content',
            path: sourceDirectory,
            field: 'folder-label',
            kind,
          },
          message,
        );

        plan(cleanDocs);
        plan(corruptDocs);
        expect(warn).toHaveBeenCalledTimes(2);
      } finally {
        warn.mockRestore();
      }
    },
  );

  test('content-directory scopes isolate both warning kinds and their clean episodes', () => {
    const warn = vi.spyOn(getLogger('generated-index'), 'warn').mockImplementation(() => {});
    const scopeA = createGeneratedIndexWarningScope('/projects/a/content');
    const scopeB = createGeneratedIndexWarningScope('/projects/b/content');
    const path = 'guides/shared-warning.md';
    const corruptEntry: IndexEntry = {
      path,
      title: `Title\u0000${PARSER_RESERVATION_TRACER.literal}`,
      description: 'Plain',
      type: 'Guide',
    };
    const cleanEntry = { ...corruptEntry, title: 'Clean title' };
    const render = (warningScope: typeof scopeA, entry: IndexEntry) =>
      buildIndexMarkdown([entry], {
        isRoot: false,
        directory: 'guides',
        warningScope,
      });

    try {
      render(scopeA, corruptEntry);
      render(scopeB, corruptEntry);
      expect(warn).toHaveBeenCalledTimes(4);

      for (const contentDir of ['/projects/a/content', '/projects/b/content']) {
        expect(warn).toHaveBeenCalledWith(
          { contentDir, path, field: 'title', kind: 'control' },
          'generated index metadata contained a Cc control; replaced it with U+FFFD',
        );
        expect(warn).toHaveBeenCalledWith(
          { contentDir, path, field: 'title', kind: 'parser-reservation' },
          'generated index metadata contained a parser-reserved private-use code point; replaced it with U+FFFD',
        );
      }

      render(scopeA, cleanEntry);
      render(scopeB, corruptEntry);
      expect(warn).toHaveBeenCalledTimes(4);

      render(scopeA, corruptEntry);
      expect(warn).toHaveBeenCalledTimes(6);

      render(scopeA, { ...corruptEntry, title: PARSER_RESERVATION_TRACER.literal });
      render(scopeA, corruptEntry);
      expect(warn).toHaveBeenCalledTimes(7);
      expect(
        warn.mock.calls.filter(
          ([payload, message]) =>
            payload.contentDir === '/projects/a/content' &&
            message === 'generated index metadata contained a Cc control; replaced it with U+FFFD',
        ),
      ).toHaveLength(3);
      expect(
        warn.mock.calls.filter(
          ([payload, message]) =>
            payload.contentDir === '/projects/a/content' &&
            message ===
              'generated index metadata contained a parser-reserved private-use code point; replaced it with U+FFFD',
        ),
      ).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  test('control substitution warns once per source path and metadata field', () => {
    const warn = vi.spyOn(getLogger('generated-index'), 'warn').mockImplementation(() => {});
    const warningScope = createGeneratedIndexWarningScope('/projects/control/content');
    const entry: IndexEntry = {
      path: 'guides/control-warning.md',
      title: 'Title\u0000',
      description: 'Description\u0001',
      type: 'Type\u0002',
    };

    try {
      buildIndexMarkdown([entry], { isRoot: false, directory: 'guides', warningScope });
      expect(warn).toHaveBeenCalledTimes(3);
      for (const field of ['title', 'description', 'type']) {
        expect(warn).toHaveBeenCalledWith(
          {
            contentDir: '/projects/control/content',
            path: 'guides/control-warning.md',
            field,
            kind: 'control',
          },
          'generated index metadata contained a Cc control; replaced it with U+FFFD',
        );
      }

      buildIndexMarkdown([entry], { isRoot: false, directory: 'guides', warningScope });
      expect(warn).toHaveBeenCalledTimes(3);

      buildIndexMarkdown(
        [
          {
            ...entry,
            title: 'Clean title',
            description: 'Clean description',
            type: 'Clean type',
          },
        ],
        { isRoot: false, directory: 'guides', warningScope },
      );
      buildIndexMarkdown([entry], { isRoot: false, directory: 'guides', warningScope });
      expect(warn).toHaveBeenCalledTimes(6);
    } finally {
      warn.mockRestore();
    }
  });

  test('parser-reservation substitution warns once per source path and metadata field', () => {
    const warn = vi.spyOn(getLogger('generated-index'), 'warn').mockImplementation(() => {});
    const warningScope = createGeneratedIndexWarningScope('/projects/parser-reservation/content');
    const entry: IndexEntry = {
      path: 'guides/parser-reservation-warning.md',
      title: PARSER_RESERVATION_TRACER.literal,
      description: 'Plain',
      type: 'Guide',
    };

    try {
      buildIndexMarkdown([entry], { isRoot: false, directory: 'guides', warningScope });
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        {
          contentDir: '/projects/parser-reservation/content',
          path: 'guides/parser-reservation-warning.md',
          field: 'title',
          kind: 'parser-reservation',
        },
        'generated index metadata contained a parser-reserved private-use code point; replaced it with U+FFFD',
      );

      buildIndexMarkdown([entry], { isRoot: false, directory: 'guides', warningScope });
      expect(warn).toHaveBeenCalledOnce();

      buildIndexMarkdown([{ ...entry, title: 'Clean title' }], {
        isRoot: false,
        directory: 'guides',
        warningScope,
      });
      buildIndexMarkdown([entry], { isRoot: false, directory: 'guides', warningScope });
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  test('generation snapshots rearm warnings for metadata sources that disappear', () => {
    const warn = vi.spyOn(getLogger('generated-index'), 'warn').mockImplementation(() => {});
    const warningScope = createGeneratedIndexWarningScope('/projects/snapshot/content');
    const corruptDocs = [
      [
        'guides/removed-description',
        { title: 'Present', description: 'Description\u0000', type: 'Guide' },
      ],
      ['guides/removed-document', { title: PARSER_RESERVATION_TRACER.literal, type: 'Guide' }],
    ] as const;
    const cleanDocs = [
      ['guides/removed-description', { title: 'Present', type: 'Guide' }],
    ] as const;
    const plan = (docs: typeof corruptDocs | typeof cleanDocs) =>
      planDirectoryIndexRegenerations({
        docs,
        docExtension: () => '.md',
        currentMarkdownFor: () => null,
        warningScope,
      });

    try {
      plan(corruptDocs);
      plan(corruptDocs);
      expect(warn).toHaveBeenCalledTimes(2);

      plan(cleanDocs);
      plan(corruptDocs);
      expect(warn).toHaveBeenCalledTimes(4);
      expect(
        warn.mock.calls.filter(
          ([, message]) =>
            message === 'generated index metadata contained a Cc control; replaced it with U+FFFD',
        ),
      ).toHaveLength(2);
      expect(
        warn.mock.calls.filter(
          ([, message]) =>
            message ===
            'generated index metadata contained a parser-reserved private-use code point; replaced it with U+FFFD',
        ),
      ).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  test.each(LITERAL_SURFACE_CASES)(
    '$surface neutralizes the parser reservation tracer before its first editor cycle',
    ({ render, expected }) => {
      const { markdown, hrefs } = render(PARSER_RESERVATION_TRACER.literal);
      const expectedMarkdown = expected(
        PARSER_RESERVATION_TRACER.normalizedLiteral,
        PARSER_RESERVATION_TRACER.literal,
      );

      expect(markdown).toContain(PARSER_RESERVATION_TRACER.normalizedLiteral);
      expectInitialEditorStability(
        markdown,
        expectedMarkdown,
        PARSER_RESERVATION_TRACER.normalizedLiteral,
        hrefs,
      );
    },
  );

  test.each(ADDITIONAL_MUTATING_PARSER_RESERVATION_CASES)(
    'title metadata neutralizes $reservation before its first editor cycle',
    ({ literal, normalizedLiteral }) => {
      const { markdown, hrefs } = LITERAL_SURFACE_CASES[0].render(literal);
      const expectedMarkdown = LITERAL_SURFACE_CASES[0].expected(normalizedLiteral, literal);

      expect(markdown).toContain(normalizedLiteral);
      expectInitialEditorStability(markdown, expectedMarkdown, normalizedLiteral, hrefs);
    },
  );

  test('title metadata preserves collision-defended parser reservations', () => {
    const { markdown, hrefs } = LITERAL_SURFACE_CASES[0].render(
      COLLISION_DEFENDED_PARSER_RESERVATION_CORPUS,
    );
    const expectedMarkdown = LITERAL_SURFACE_CASES[0].expected(
      COLLISION_DEFENDED_PARSER_RESERVATION_CORPUS,
      COLLISION_DEFENDED_PARSER_RESERVATION_CORPUS,
    );

    expectInitialEditorStability(
      markdown,
      expectedMarkdown,
      COLLISION_DEFENDED_PARSER_RESERVATION_CORPUS,
      hrefs,
    );
  });

  test.each(LITERAL_SURFACE_CASES)(
    '$surface replaces residual C0, DEL, and C1 controls after whitespace folding',
    ({ render, expected }) => {
      const { markdown, hrefs } = render(CONTROL_BEARING_LITERAL);
      const expectedMarkdown = expected(NORMALIZED_CONTROL_LITERAL, CONTROL_BEARING_LITERAL);

      expect.soft(hasResidualControl(markdown)).toBe(false);
      expectInitialEditorStability(markdown, expectedMarkdown, NORMALIZED_CONTROL_LITERAL, hrefs);
    },
  );

  test.each(LITERAL_SURFACE_CASES)(
    '$surface currently preserves the bidi override pending policy',
    ({ render, expected }) => {
      const literal = `before${BIDI_OVERRIDE_PENDING_POLICY}after`;
      const { markdown, hrefs } = render(literal);
      const expectedMarkdown = expected(literal, literal);

      expect(markdown).toContain(literal);
      expectInitialEditorStability(markdown, expectedMarkdown, literal, hrefs);
    },
  );

  test.each(LITERAL_SURFACE_CASES)(
    '$surface preserves zero-width and joining controls',
    ({ render, expected }) => {
      const literal = `before${ZERO_WIDTH_AND_JOINING_CONTROLS}after`;
      const { markdown, hrefs } = render(literal);
      const expectedMarkdown = expected(literal, literal);

      expect(markdown).toContain(literal);
      expectInitialEditorStability(markdown, expectedMarkdown, literal, hrefs);
    },
  );

  test('control normalization preserves NFC type grouping and first-cycle stability', () => {
    const entries: IndexEntry[] = [
      { path: 'guides/composed.md', title: 'Composed', type: 'Café\tGuide\u0000' },
      { path: 'guides/decomposed.md', title: 'Decomposed', type: 'Cafe\u0301\nGuide\u009b' },
    ];
    const build = (orderedEntries: readonly IndexEntry[]) =>
      buildIndexMarkdown(orderedEntries, {
        warningScope: false,
        isRoot: false,
        directory: 'guides',
      });
    const forward = build(entries);
    const reversed = build(entries.toReversed());
    const expectedHrefs = ['./composed.md', './decomposed.md'];
    const expectedMarkdown =
      '# Index\n\n## Cafe\u0301 Guide�\n\n* [Composed](./composed.md)\n* [Decomposed](./decomposed.md)\n';

    expect(forward).toBe(expectedMarkdown);
    expect(reversed).toBe(expectedMarkdown);

    for (const markdown of [forward, reversed]) {
      const parsed = markdownManager.parse(markdown);
      const sections = parsedSections(parsed);

      expect(hasResidualControl(markdown)).toBe(false);
      expect(markdownManager.serialize(parsed)).toBe(expectedMarkdown);
      expect(sections).toHaveLength(2);
      expect(sections[0]).toEqual({ level: 1, heading: 'Index', hrefs: [] });
      expect(sections[1]?.level).toBe(2);
      expect(sections[1]?.heading.normalize('NFC')).toBe('Café Guide�');
      expect(sections[1]?.hrefs).toEqual(expectedHrefs);
    }
  });

  test.each(FIELD_CASES)(
    '$field metadata remains literal through the editor Markdown pipeline',
    ({ entry }) => {
      const markdown = buildIndexMarkdown([entry], {
        warningScope: false,
        isRoot: false,
        directory: 'guides',
      });

      expectLiteralThroughEditor(markdown, MARKDOWN_METACHARACTER_CORPUS, ['./entry.md']);
    },
  );

  test.each([
    {
      source: 'first H1',
      title: extractPageTitle(`# ${MARKDOWN_METACHARACTER_CORPUS}\n`, 'fallback'),
      literal: MARKDOWN_METACHARACTER_CORPUS,
    },
    {
      source: 'filename fallback',
      title: extractPageTitle('Plain body without a heading.\n', PORTABLE_PATH_CORPUS),
      literal: PORTABLE_PATH_CORPUS,
    },
  ])('$source titles remain literal through the editor Markdown pipeline', ({ title, literal }) => {
    const markdown = buildIndexMarkdown(
      [{ path: 'guides/entry.md', title, description: 'Plain description', type: 'Guide' }],
      { warningScope: false, isRoot: false, directory: 'guides' },
    );

    expectLiteralThroughEditor(markdown, literal, ['./entry.md']);
  });

  test.each([
    { cycle: 'initial', currentMarkdown: null },
    { cycle: 'incremental', currentMarkdown: '# Stale index\n' },
  ])(
    '$cycle planning keeps a derived subdirectory label literal and its target resolvable',
    ({ currentMarkdown }) => {
      const guides = planDirectoryIndexRegenerations({
        warningScope: false,
        docs: [[`guides/${PORTABLE_PATH_CORPUS}/entry`, { title: 'Entry', type: 'Guide' }]],
        docExtension: () => '.md',
        currentMarkdownFor: () => currentMarkdown,
      }).find((decision) => decision.directory === 'guides');

      expect(guides).toBeDefined();
      expect(guides?.changed).toBe(true);
      expectLiteralThroughEditor(guides?.markdown ?? '', PORTABLE_PATH_CORPUS, [
        `./${encodeURIComponent(PORTABLE_PATH_CORPUS)}/index.md`,
      ]);

      const href = linkHrefs(markdownManager.parse(guides?.markdown ?? ''))[0] ?? '';
      expect(resolveInternalHref(href, 'guides/index')?.docName).toBe(
        `guides/${PORTABLE_PATH_CORPUS}/index`,
      );
    },
  );

  test.each([
    { destination: 'disk', loaded: false },
    { destination: 'loaded document', loaded: true },
  ])('$destination artifacts preserve generated metadata semantics', async ({ loaded }) => {
    const markdown = buildIndexMarkdown(
      [
        {
          path: 'guides/entry.md',
          title: extractedTitle,
          description: 'Plain description',
          type: 'Guide',
        },
      ],
      { warningScope: false, isRoot: false, directory: 'guides' },
    );
    const document = loaded ? new Y.Doc() : undefined;
    let diskMarkdown = '';
    const outcome = await writeGeneratedArtifact(
      {
        docName: 'guides/index',
        absPath: '/project/content/guides/index.md',
        markdown,
        currentMarkdown: null,
      },
      generatedArtifactEnv(document, (written) => {
        diskMarkdown = written;
      }),
    );
    const storedMarkdown = document?.getText('source').toString() ?? diskMarkdown;

    expect(outcome).toBe(loaded ? 'document' : 'disk');
    expect(storedMarkdown).toBe(markdown);
    expectLiteralThroughEditor(storedMarkdown, MARKDOWN_METACHARACTER_CORPUS, ['./entry.md']);
  });

  test('generated headings, lists, link ordering, and directory-relative targets remain meaningful', () => {
    const markdown = buildIndexMarkdown(
      [
        { path: 'guides/zeta.md', title: 'Zeta', description: 'Last', type: 'Guide' },
        { path: 'guides/alpha.md', title: 'Alpha', description: 'First', type: 'Guide' },
      ],
      {
        warningScope: false,
        isRoot: false,
        directory: 'guides',
        subdirectories: [{ directory: 'guides/nested', title: 'Nested' }],
      },
    );
    const document = markdownManager.parse(
      markdownManager.serialize(markdownManager.parse(markdown)),
    );
    const topLevel = document.content ?? [];
    const headings = topLevel
      .filter((node) => node.type === 'heading')
      .map((node) => ({ level: node.attrs?.level, text: textContent(node) }));
    const links = walkJson(document)
      .filter((node) => node.text !== undefined && node.marks?.some((mark) => mark.type === 'link'))
      .map((node) => ({ href: linkHrefs(node)[0], text: node.text }));

    expect(topLevel.map((node) => node.type)).toEqual([
      'heading',
      'heading',
      'list',
      'heading',
      'list',
    ]);
    expect(headings).toEqual([
      { level: 1, text: 'Index' },
      { level: 2, text: 'Guide' },
      { level: 2, text: 'Subdirectories' },
    ]);
    expect(links).toEqual([
      { href: './alpha.md', text: 'Alpha' },
      { href: './zeta.md', text: 'Zeta' },
      { href: './nested/index.md', text: 'Nested' },
    ]);
  });

  test('literal type labels keep distinct buckets while exact owned labels retain their behavior', () => {
    const entries: IndexEntry[] = [
      { path: 'guides/exact-index.md', title: 'Exact index', type: 'Index' },
      { path: 'guides/emphasis-index.md', title: 'Emphasis index', type: '*Index*' },
      { path: 'guides/index-closer.md', title: 'Index closer', type: 'Index #' },
      { path: 'guides/exact-other.md', title: 'Exact other', type: 'Other' },
      { path: 'guides/untyped.md', title: 'Untyped' },
      { path: 'guides/strong-other.md', title: 'Strong other', type: '**Other**' },
      { path: 'guides/html-other.md', title: 'HTML other', type: '<b></b>Other' },
      {
        path: 'guides/exact-subdirectories.md',
        title: 'Exact subdirectories',
        type: 'Subdirectories',
      },
      {
        path: 'guides/link-subdirectories.md',
        title: 'Link subdirectories',
        type: '[Subdirectories](./x)',
      },
      { path: 'guides/guide.md', title: 'Plain guide', type: 'Guide' },
      { path: 'guides/emphasis-guide.md', title: 'Emphasis guide', type: '*Guide*' },
    ];
    const subdirectories = [{ directory: 'guides/nested', title: 'Nested' }];
    const build = (orderedEntries: readonly IndexEntry[]) =>
      buildIndexMarkdown(orderedEntries, {
        warningScope: false,
        isRoot: false,
        directory: 'guides',
        subdirectories,
      });
    const forward = build(entries);
    const reversed = build(entries.toReversed());

    expect(reversed).toBe(forward);
    expectGroupingThroughEditor(
      forward,
      [
        { level: 1, heading: 'Index', hrefs: ['./exact-index.md'] },
        { level: 2, heading: '**Other**', hrefs: ['./strong-other.md'] },
        { level: 2, heading: '*Guide*', hrefs: ['./emphasis-guide.md'] },
        { level: 2, heading: '*Index*', hrefs: ['./emphasis-index.md'] },
        { level: 2, heading: '<b></b>Other', hrefs: ['./html-other.md'] },
        {
          level: 2,
          heading: '[Subdirectories](./x)',
          hrefs: ['./link-subdirectories.md'],
        },
        { level: 2, heading: 'Guide', hrefs: ['./guide.md'] },
        { level: 2, heading: 'Index #', hrefs: ['./index-closer.md'] },
        { level: 2, heading: 'Other', hrefs: ['./exact-other.md', './untyped.md'] },
        {
          level: 2,
          heading: 'Subdirectories',
          hrefs: ['./exact-subdirectories.md', './nested/index.md'],
        },
      ],
      [
        './emphasis-guide.md',
        './emphasis-index.md',
        './exact-index.md',
        './exact-other.md',
        './exact-subdirectories.md',
        './guide.md',
        './html-other.md',
        './index-closer.md',
        './link-subdirectories.md',
        './nested/index.md',
        './strong-other.md',
        './untyped.md',
      ],
    );
  });

  test('type bucket identity retains whitespace and NFC normalization independent of input order', () => {
    const entries: IndexEntry[] = [
      { path: 'guides/composed.md', title: 'Composed', type: 'Café   Guide' },
      { path: 'guides/decomposed.md', title: 'Decomposed', type: 'Café\nGuide' },
    ];
    const build = (orderedEntries: readonly IndexEntry[]) =>
      buildIndexMarkdown(orderedEntries, {
        warningScope: false,
        isRoot: false,
        directory: 'guides',
      });
    const forward = build(entries);
    const reversed = build(entries.toReversed());
    const expectedHrefs = ['./composed.md', './decomposed.md'];

    expect(reversed).toBe(forward);

    for (const markdown of [forward, reversed]) {
      const parsed = markdownManager.parse(markdown);
      const serializedOnce = markdownManager.serialize(parsed);
      const reparsed = markdownManager.parse(serializedOnce);

      for (const document of [parsed, reparsed]) {
        const sections = parsedSections(document);
        expect(sections).toHaveLength(2);
        expect(sections[0]).toEqual({ level: 1, heading: 'Index', hrefs: [] });
        expect(sections[1]?.level).toBe(2);
        expect(sections[1]?.heading.normalize('NFC')).toBe('Café Guide');
        expect(sections[1]?.hrefs).toEqual(expectedHrefs);
        expect([...new Set(linkHrefs(document))].toSorted()).toEqual(expectedHrefs);
      }

      expect(markdownManager.serialize(reparsed)).toBe(serializedOnce);
    }
  });
});
