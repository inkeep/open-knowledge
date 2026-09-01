import { describe, expect, test, vi } from 'vitest';
import {
  createWorkspaceSearchCorpus,
  createWorkspaceSearchDocument,
  searchWorkspaceCorpus,
} from './workspace-search.ts';

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
    expect(pathsFor('çığ')).toContain('notes/avalanche.md');
  });

  test('mixed-script query uses both halves', () => {
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
      content: '防问控制与权限管理',
    }),
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

  const cyrillic = createWorkspaceSearchCorpus([
    createWorkspaceSearchDocument({
      kind: 'page',
      path: 'notes/russian.md',
      title: 'russian notes',
      content: 'поиск работает хорошо',
    }),
  ]);

  test('a one-letter Cyrillic typo still finds the document', () => {
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
    expect(topScoreFor('École normale')).toBe(topScoreFor('école normale'));
  });

  test('a runtime without Intl.Segmenter degrades instead of failing module load', async () => {
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
