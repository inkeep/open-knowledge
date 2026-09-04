import { type LinterConfig, lintDocument } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { partitionFrontmatterProblems } from './useFrontmatterDiagnostics.ts';

const DOC_NAME = 'usability-sessions/kenny/notes/serafin';

const config: LinterConfig = {
  enabled: true,
  plugins: {
    markdownlint: { enabled: true, rules: {} },
    frontmatter: { enabled: true, schemas: [] },
    okf: { enabled: true },
  },
};

const TAGS_MUST_BE_ARRAY = 'Frontmatter property "tags" must be array';

describe('partitionFrontmatterProblems over real OKF diagnostics', () => {
  test('routes an OKF missing-required diagnostic to `missing`', async () => {
    const text = '---\ntitle: Serafin\ndescription: Session notes\ntags: []\n---\n\nSome notes.\n';
    const diagnostics = await lintDocument(text, config, DOC_NAME);

    const produced = diagnostics.find(
      (d) => d.source === 'okf' && d.code === 'frontmatter-required',
    );
    expect(produced?.frontmatterScope).toBe('missing');
    expect(produced?.frontmatterProperty).toBe('type');

    const { missing, invalid } = partitionFrontmatterProblems(diagnostics);
    expect(missing.map((d) => d.frontmatterProperty)).toEqual(['type']);
    expect(invalid).toHaveLength(0);
  });

  test('routes an OKF invalid-scope diagnostic to `invalid`', async () => {
    const text = '---\ntype: Note\ntags: not-a-list\n---\n\nSome notes.\n';
    const diagnostics = await lintDocument(text, config, DOC_NAME);

    const produced = diagnostics.find(
      (d) => d.source === 'okf' && d.frontmatterScope === 'invalid',
    );
    expect(produced?.message).toContain('tags');

    const { missing, invalid } = partitionFrontmatterProblems(diagnostics);
    expect(missing).toHaveLength(0);
    expect(invalid.some((d) => d.source === 'okf' && d.message.includes('tags'))).toBe(true);
  });

  test('two producers requiring `type` count as one property to add', async () => {
    const alsoRequiresType: LinterConfig = {
      ...config,
      plugins: {
        ...config.plugins,
        frontmatter: {
          enabled: true,
          schemas: [
            {
              appliesTo: '**',
              file: 'notes.json',
              schema: {
                type: 'object',
                required: ['type'],
                properties: { type: { type: 'string' } },
              },
            },
          ],
        },
      },
    };
    const text = '---\ntitle: Serafin\n---\n\nSome notes.\n';
    const diagnostics = await lintDocument(text, alsoRequiresType, DOC_NAME);

    const producers = diagnostics
      .filter((d) => d.frontmatterScope === 'missing' && d.frontmatterProperty === 'type')
      .map((d) => d.source);
    expect(new Set(producers)).toEqual(new Set(['okf', 'frontmatter']));

    const { missing } = partitionFrontmatterProblems(diagnostics);
    expect(missing.map((d) => d.frontmatterProperty)).toEqual(['type']);
  });

  test('two producers stating one `tags` fault count as one problem', async () => {
    const alsoPinsTags: LinterConfig = {
      ...config,
      plugins: {
        ...config.plugins,
        frontmatter: {
          enabled: true,
          schemas: [
            {
              appliesTo: '**',
              file: 'notes.json',
              schema: {
                type: 'object',
                properties: { tags: { type: 'array', items: { type: 'string' } } },
              },
            },
          ],
        },
      },
    };
    const text = '---\ntype: Note\ntags: not-a-list\n---\n\nSome notes.\n';
    const diagnostics = await lintDocument(text, alsoPinsTags, DOC_NAME);

    const tagsFault = diagnostics.filter(
      (d) => d.frontmatterScope === 'invalid' && d.message === TAGS_MUST_BE_ARRAY,
    );
    expect(new Set(tagsFault.map((d) => d.source))).toEqual(new Set(['okf', 'frontmatter']));

    const { invalid } = partitionFrontmatterProblems(diagnostics);
    expect(invalid.filter((d) => d.message === TAGS_MUST_BE_ARRAY)).toHaveLength(1);
  });

  test('excludes scope-less diagnostics (OKF body rules, markdownlint) from both buckets', async () => {
    const text = '---\ntype: Note\n---\n\nSee [[Wiki Target]]\there.\n';
    const diagnostics = await lintDocument(text, config, DOC_NAME);

    expect(diagnostics.some((d) => d.source === 'okf' && d.code === 'no-wiki-links')).toBe(true);
    expect(diagnostics.every((d) => d.code !== 'frontmatter-required')).toBe(true);

    const { missing, invalid } = partitionFrontmatterProblems(diagnostics);
    expect(missing).toHaveLength(0);
    expect(invalid).toHaveLength(0);
  });
});
