/**
 * The badge partition composed with the REAL lint engine over the REAL OKF
 * registry — the sibling unit test feeds `partitionFrontmatterProblems` only
 * hand-built diagnostics, so it cannot notice when a real producer's output is
 * dropped wholesale.
 *
 * The contract under test: a diagnostic carrying `frontmatterScope` reports on
 * the frontmatter affordances regardless of producing plugin (`missing` → the
 * Add-properties button, `invalid` → the property panel's count), while a
 * scope-less diagnostic — an OKF body rule, a markdownlint finding — belongs to
 * neither bucket. Plugin identity is not a proxy for frontmatter-ness: the OKF
 * plugin produces both kinds.
 */

import { type LinterConfig, lintDocument } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { partitionFrontmatterProblems } from './useFrontmatterDiagnostics.ts';

// A concept-scoped doc name (anything but a reserved `index`/`log` filename).
const DOC_NAME = 'usability-sessions/kenny/notes/serafin';

// OKF on; the frontmatter plugin on with no authored schemas (the shape a
// project has right after enabling OKF); markdownlint on so its scope-less
// findings are available to the exclusion tests below.
const config: LinterConfig = {
  enabled: true,
  plugins: {
    markdownlint: { enabled: true, rules: {} },
    frontmatter: { enabled: true, schemas: [] },
    okf: { enabled: true },
  },
};

// The sentence both a `type: array` OKF recommendation and a `type: array`
// project schema produce for a scalar `tags` — the two are indistinguishable to
// a reader, which is what makes the second one a restatement.
const TAGS_MUST_BE_ARRAY = 'Frontmatter property "tags" must be array';

describe('partitionFrontmatterProblems over real OKF diagnostics', () => {
  test('routes an OKF missing-required diagnostic to `missing`', async () => {
    const text = '---\ntitle: Serafin\ndescription: Session notes\ntags: []\n---\n\nSome notes.\n';
    const diagnostics = await lintDocument(text, config, DOC_NAME);

    // Producer half of the contract (already upheld): the OKF plugin emits the
    // violation with full badge metadata.
    const produced = diagnostics.find(
      (d) => d.source === 'okf' && d.code === 'frontmatter-required',
    );
    expect(produced?.frontmatterScope).toBe('missing');
    expect(produced?.frontmatterProperty).toBe('type');

    // Consumer half: the Add-properties badge must count it.
    const { missing, invalid } = partitionFrontmatterProblems(diagnostics);
    expect(missing.map((d) => d.frontmatterProperty)).toEqual(['type']);
    expect(invalid).toHaveLength(0);
  });

  test('routes an OKF invalid-scope diagnostic to `invalid`', async () => {
    // `type` present (conformance floor met); `tags` authored as a string where
    // the OKF recommended schema pins an array — a present-but-wrong property.
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
    // The shape a project takes on when it adopts OKF over an existing
    // `contentRules.frontmatter` schema: both require `type` and both report it,
    // so a per-diagnostic count would put 2 on the Add-properties badge and list
    // the same add twice in its tooltip, while clicking stages one row.
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

    // Both producers really do report it — otherwise the dedupe below is vacuous.
    const producers = diagnostics
      .filter((d) => d.frontmatterScope === 'missing' && d.frontmatterProperty === 'type')
      .map((d) => d.source);
    expect(new Set(producers)).toEqual(new Set(['okf', 'frontmatter']));

    const { missing } = partitionFrontmatterProblems(diagnostics);
    expect(missing.map((d) => d.frontmatterProperty)).toEqual(['type']);
  });

  test('two producers stating one `tags` fault count as one problem', async () => {
    // The `invalid` counterpart of the dedupe above, and the same adoption
    // shape: OKF's recommended schema pins `tags` as an array, and a project
    // schema that pins it the same way makes both state one sentence about one
    // existing row. The property panel counts and lists those sentences.
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

    // Both producers really do state it, verbatim — otherwise the collapse below
    // is vacuous.
    const tagsFault = diagnostics.filter(
      (d) => d.frontmatterScope === 'invalid' && d.message === TAGS_MUST_BE_ARRAY,
    );
    expect(new Set(tagsFault.map((d) => d.source))).toEqual(new Set(['okf', 'frontmatter']));

    const { invalid } = partitionFrontmatterProblems(diagnostics);
    expect(invalid.filter((d) => d.message === TAGS_MUST_BE_ARRAY)).toHaveLength(1);
  });

  test('excludes scope-less diagnostics (OKF body rules, markdownlint) from both buckets', async () => {
    // Conformant frontmatter; the body trips the OKF `no-wiki-links` body rule
    // and markdownlint's hard-tab rule. Neither carries `frontmatterScope`, so
    // neither belongs on a frontmatter affordance.
    const text = '---\ntype: Note\n---\n\nSee [[Wiki Target]]\there.\n';
    const diagnostics = await lintDocument(text, config, DOC_NAME);

    expect(diagnostics.some((d) => d.source === 'okf' && d.code === 'no-wiki-links')).toBe(true);
    expect(diagnostics.every((d) => d.code !== 'frontmatter-required')).toBe(true);

    const { missing, invalid } = partitionFrontmatterProblems(diagnostics);
    expect(missing).toHaveLength(0);
    expect(invalid).toHaveLength(0);
  });
});
