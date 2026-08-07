import { describe, expect, test, vi } from 'vitest';
import {
  createWorkspaceSearchCorpus,
  createWorkspaceSearchDocument,
  searchWorkspaceCorpus,
} from './workspace-search.ts';

/**
 * Non-Latin body search (inkeep/open-knowledge#903).
 *
 * Orama's default `english` tokenizer treats every character outside its Latin
 * class as a separator, so non-Latin body content indexed to ZERO tokens and
 * was unsearchable — masked for file NAMES by the lexical ladder, which
 * compares whole strings. These tests search by BODY content behind
 * Latin-named docs, so a hit can only come from the BM25 index and a
 * tokenizer regression cannot hide behind the name ladder.
 */

const docs = [
  createWorkspaceSearchDocument({
    kind: 'page',
    path: 'notes/coal.md',
    title: 'coal notes',
    content: 'הפקת פחם באירופה במאה התשע עשרה',
  }),
  createWorkspaceSearchDocument({
    kind: 'page',
    path: 'notes/access.md',
    title: 'access notes',
    content: '访问控制与权限管理的最佳实践',
  }),
  createWorkspaceSearchDocument({
    kind: 'page',
    path: 'notes/tokyo.md',
    title: 'tokyo notes',
    content: '検索テキストの品質を確認します',
  }),
  createWorkspaceSearchDocument({
    kind: 'page',
    path: 'notes/tenants.md',
    title: 'tenant notes',
    content: 'поиск работает: tenant isolation details',
  }),
  createWorkspaceSearchDocument({
    kind: 'page',
    path: 'notes/thai.md',
    title: 'thai notes',
    content: 'ค้นหาข้อความภาษาไทย',
  }),
  createWorkspaceSearchDocument({
    kind: 'page',
    path: 'notes/korean.md',
    title: 'korean notes',
    content: '검색 품질을 확인합니다',
  }),
  createWorkspaceSearchDocument({
    kind: 'page',
    path: 'notes/avalanche.md',
    title: 'avalanche notes',
    content: 'çığ düştü ve yol kapandı',
  }),
  createWorkspaceSearchDocument({
    kind: 'page',
    path: 'notes/plain.md',
    title: 'plain notes',
    content: 'a plain english document about foxes',
  }),
];

const corpus = createWorkspaceSearchCorpus(docs);

function pathsFor(query: string): string[] {
  return searchWorkspaceCorpus(corpus, query, { intent: 'full_text' }).map(
    (result) => result.document.path,
  );
}

describe('non-Latin body content is searchable', () => {
  test.each([
    ['Hebrew', 'פחם', 'notes/coal.md'],
    ['Chinese', '访问控制', 'notes/access.md'],
    ['Japanese', '検索テキスト', 'notes/tokyo.md'],
    ['Cyrillic', 'поиск работает', 'notes/tenants.md'],
    ['Thai', 'ค้นหา', 'notes/thai.md'],
    ['Korean', '검색', 'notes/korean.md'],
  ])('%s query finds body content', (_script, query, expectedPath) => {
    expect(pathsFor(query)).toContain(expectedPath);
  });

  test('accented Latin outside the default set is searchable', () => {
    // Latin-script letters outside the splitter's kept set (`àèéìòóù`) are
    // separators too. `çığ` is made only of those, so the default tokenizer
    // reduces it to ZERO tokens on both sides and it is unfindable — the same
    // failure as the non-Latin scripts above, in Latin script. Words that keep
    // some fragment (`niño` → `ni`/`o`) stay findable either way, so this
    // all-dropped case is what actually pins the behavior.
    expect(pathsFor('çığ')).toContain('notes/avalanche.md');
  });

  test('mixed-script query uses both halves', () => {
    // The Cyrillic half alone must be able to select the doc: `поиск` appears
    // only in tenants.md, so a tokenizer that silently drops the non-Latin
    // half would still pass a combined-terms assertion — pin the ranking too.
    const paths = pathsFor('поиск isolation');
    expect(paths[0]).toBe('notes/tenants.md');
    expect(pathsFor('поиск')).toContain('notes/tenants.md');
  });

  test('the omnibar call shape (full_text candidates, navigation ranking) finds non-Latin content', () => {
    const results = searchWorkspaceCorpus(corpus, '访问控制', {
      intent: 'full_text',
      ranking: 'navigation',
    });
    expect(results.map((result) => result.document.path)).toContain('notes/access.md');
  });

  test('pure-Latin queries are unaffected', () => {
    expect(pathsFor('foxes')[0]).toBe('notes/plain.md');
  });
});

describe('dense scripts do not take edit-distance tolerance', () => {
  // Now that these scripts tokenize at all, the `full_text` tolerance of 1
  // reaches them for the first time. A word there is a few characters long, so
  // one edit is a different word, not a typo — and BM25 can float that
  // near-miss above the exact hit.
  const cjk = createWorkspaceSearchCorpus([
    createWorkspaceSearchDocument({
      kind: 'page',
      path: 'notes/access.md',
      title: 'access notes',
      content: '访问控制与权限管理',
    }),
    createWorkspaceSearchDocument({
      kind: 'page',
      path: 'notes/variant.md',
      title: 'variant notes',
      // `防问控制` — one character off, and not a word.
      content: '防问控制与权限管理',
    }),
    // A genuinely related doc. It legitimately ranks first (shorter, and it
    // really does contain 访问 + 控制), and its presence is what shifts the
    // corpus statistics far enough for the near-miss to beat the exact hit.
    createWorkspaceSearchDocument({
      kind: 'page',
      path: 'notes/controller.md',
      title: 'controller notes',
      content: '访问控制器的配置说明',
    }),
  ]);

  test('a one-character variant does not outrank the exact match', () => {
    const paths = searchWorkspaceCorpus(cjk, '访问控制', { intent: 'full_text' }).map(
      (result) => result.document.path,
    );
    expect(paths.indexOf('notes/access.md')).toBeLessThan(paths.indexOf('notes/variant.md'));
  });

  // Hangul is space-separated, so it is NOT an unspaced script — but a syllable
  // block carries as much as a whole Latin word, so it fails the same way:
  // `검색` (search) vs `검토` (review) vs `검사` (inspection) are pairwise one
  // edit apart and mean different things.
  const hangul = createWorkspaceSearchCorpus([
    createWorkspaceSearchDocument({
      kind: 'page',
      path: 'notes/search.md',
      title: 'search notes',
      content: '검색 품질을 확인합니다',
    }),
    createWorkspaceSearchDocument({
      kind: 'page',
      path: 'notes/review.md',
      title: 'review notes',
      content: '검토 품질을 확인합니다',
    }),
    createWorkspaceSearchDocument({
      kind: 'page',
      path: 'notes/inspection.md',
      title: 'inspection notes',
      content: '검사 결과를 확인합니다',
    }),
  ]);

  test('a one-syllable Hangul variant does not outrank the exact match', () => {
    const paths = searchWorkspaceCorpus(hangul, '검색 품질', { intent: 'full_text' }).map(
      (result) => result.document.path,
    );
    expect(paths[0]).toBe('notes/search.md');
  });

  // The other half of the contract: alphabetic non-Latin scripts must KEEP
  // tolerance, so widening the dense-script ranges over them is caught. The
  // recall tests above all query exact terms and would survive that widening.
  const cyrillic = createWorkspaceSearchCorpus([
    createWorkspaceSearchDocument({
      kind: 'page',
      path: 'notes/russian.md',
      title: 'russian notes',
      content: 'поиск работает хорошо',
    }),
  ]);

  test('a one-letter Cyrillic typo still finds the document', () => {
    // `поиек` (е for с) appears nowhere in the corpus — only tolerance finds it.
    expect(
      searchWorkspaceCorpus(cyrillic, 'поиек', { intent: 'full_text' }).map(
        (result) => result.document.path,
      ),
    ).toContain('notes/russian.md');
  });
});

describe('input the base tokenizer already handles stays untouched', () => {
  function topScoreFor(content: string): number {
    const single = createWorkspaceSearchCorpus([
      createWorkspaceSearchDocument({
        kind: 'page',
        path: 'notes/school.md',
        title: 'school notes',
        content,
      }),
    ]);
    const results = searchWorkspaceCorpus(single, 'ecole', { intent: 'full_text' });
    expect(results).not.toHaveLength(0);
    return results[0].score;
  }

  test('capitalizing an accented word does not change its score', () => {
    // Capitalization is not a script difference: the base lowercases before it
    // splits, so `École` and `école` yield the same base tokens (`ecole`,
    // diacritic-folded). Treating `É` as dropped would append a second,
    // unfolded `école` to the capitalized doc only — same hits, but a longer
    // field and therefore a different BM25 score.
    expect(topScoreFor('École normale')).toBe(topScoreFor('école normale'));
  });

  test('a runtime without Intl.Segmenter degrades instead of failing module load', async () => {
    // This module is imported by the command palette and the wiki-link
    // suggestion extension, so an unguarded constructor would take down the
    // app bundle's module evaluation, not just non-Latin search.
    const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');
    Reflect.deleteProperty(Intl, 'Segmenter');
    vi.resetModules();
    try {
      const mod = await import('./workspace-search.ts');
      const fallbackCorpus = mod.createWorkspaceSearchCorpus([
        mod.createWorkspaceSearchDocument({
          kind: 'page',
          path: 'notes/plain.md',
          title: 'plain notes',
          content: 'a plain english document about foxes',
        }),
      ]);
      const paths = mod
        .searchWorkspaceCorpus(fallbackCorpus, 'foxes', { intent: 'full_text' })
        .map((result) => result.document.path);
      expect(paths).toContain('notes/plain.md');
    } finally {
      if (descriptor) Object.defineProperty(Intl, 'Segmenter', descriptor);
      vi.resetModules();
    }
  });
});
