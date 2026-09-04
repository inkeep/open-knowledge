import { describe, expect, test } from 'vitest';
import { readCorpus } from '@/lib/docs-corpus.test-helper';
import { componentNames } from '@/lib/mdx-serializer';
import { DOCS_SERIALIZER_REGISTRY } from '@/lib/mdx-serializer-registry';
import { getMDXComponents } from '@/mdx-components';

const REGISTRY = 'src/lib/mdx-serializer-registry.ts';

const runtimeMapKeys = Object.keys(getMDXComponents());
const corpus = await readCorpus();

const corpusUsage = new Map<string, string>();
for (const page of corpus) {
  for (const name of componentNames(page.source)) {
    if (!corpusUsage.has(name)) corpusUsage.set(name, `content/${page.slug || 'index'}`);
  }
}

const renderable = new Set([...runtimeMapKeys, ...corpusUsage.keys()]);
const registryKeys = new Set(Object.keys(DOCS_SERIALIZER_REGISTRY));

function originOf(name: string): string {
  const page = corpusUsage.get(name);
  if (runtimeMapKeys.includes(name)) {
    return page ? `component map, used in ${page}` : 'component map';
  }
  return `imported by ${page}`;
}

describe('markdown component coverage', () => {
  test('every component a page can render has a disposition', () => {
    const missing = [...renderable]
      .filter((name) => !registryKeys.has(name))
      .sort()
      .map((name) => `<${name}> (${originOf(name)})`);

    expect(
      missing,
      `components with no serializer disposition. Add each to DOCS_SERIALIZER_REGISTRY in ${REGISTRY} as 'flatten', 'drop', or a serializer that renders what it carries. ` +
        "A component that carries no children in source has nothing for 'flatten' to emit, so " +
        'it needs a serializer: that includes anything whose content a remark plugin supplies ' +
        '(a snippet include, a generated type table), because the Markdown rendition reads RAW ' +
        "source and never runs those plugins — 'flatten' there ships the page with the section " +
        'silently absent',
    ).toEqual([]);
  });

  test('every disposition names a component something can render', () => {
    const orphaned = [...registryKeys].filter((name) => !renderable.has(name)).sort();

    expect(
      orphaned,
      `dispositions in ${REGISTRY} for components neither the map nor the corpus has; restore the component or drop the entry`,
    ).toEqual([]);
  });

  test('the component map is read at runtime, spread keys included', () => {
    expect(runtimeMapKeys, 'the component map census is not seeing spread keys').toContain(
      'Callout',
    );
    expect(runtimeMapKeys.length).toBeGreaterThan(40);
  });

  test('the corpus census reaches the published tree', () => {
    expect(corpus.length).toBeGreaterThan(50);
    expect(corpusUsage.size).toBeGreaterThan(10);
  });
});
