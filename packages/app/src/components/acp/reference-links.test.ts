import { describe, expect, test } from 'vitest';
import { githubWebBase, referenceRulesKey, remarkReferenceLinks } from './reference-links';

interface Node {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: Node[];
}

const LINEAR = { prefix: 'PRD-', url: 'https://linear.app/inkeep/issue/PRD-<num>' };

function linkify(value: string, autolinks = [LINEAR], githubBase = 'https://github.com'): Node[] {
  const tree: Node = {
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value }] }],
  };
  remarkReferenceLinks({ githubBase, autolinks })(tree);
  return tree.children?.[0]?.children ?? [];
}

const links = (nodes: Node[]) =>
  nodes.filter((n) => n.type === 'link').map((n) => [n.children?.[0]?.value, n.url]);

describe('reference links', () => {
  test('a qualified GitHub reference links to its issue or pull request', () => {
    expect(links(linkify('Merged inkeep/agents-private#4971 today.'))).toEqual([
      ['inkeep/agents-private#4971', 'https://github.com/inkeep/agents-private/issues/4971'],
    ]);
  });

  test('a configured prefix followed by digits links to its template', () => {
    const nodes = linkify('Fixes PRD-8223, see PRD-8011.');
    expect(links(nodes)).toEqual([
      ['PRD-8223', 'https://linear.app/inkeep/issue/PRD-8223'],
      ['PRD-8011', 'https://linear.app/inkeep/issue/PRD-8011'],
    ]);
    expect(nodes.map((n) => (n.type === 'text' ? n.value : '·'))).toEqual([
      'Fixes ',
      '·',
      ', see ',
      '·',
      '.',
    ]);
  });

  test('bare #N, lowercase prefixes, and prefixes inside longer words stay plain text', () => {
    expect(links(linkify('Rule #4 and step #2'))).toEqual([]);
    expect(links(linkify('branch fix/prd-8028-git'))).toEqual([]);
    expect(links(linkify('XPRD-12 and APRD-3'))).toEqual([]);
    expect(links(linkify('see src/foo.ts#L3'))).toEqual([]);
    expect(links(linkify('see packages/app/src/index.ts#12'))).toEqual([]);
  });

  test('a two-segment path ending in #N reads as owner/repo#N, since repository names can hold dots', () => {
    expect(links(linkify('see src/index.ts#12'))).toEqual([
      ['src/index.ts#12', 'https://github.com/src/index.ts/issues/12'],
    ]);
    expect(links(linkify('see inkeep/agents.js#12'))).toEqual([
      ['inkeep/agents.js#12', 'https://github.com/inkeep/agents.js/issues/12'],
    ]);
  });

  test('code and existing links are left alone', () => {
    const tree: Node = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'inlineCode', value: 'PRD-1' },
            {
              type: 'link',
              url: 'https://example.com',
              children: [{ type: 'text', value: 'PRD-2' }],
            },
            { type: 'emphasis', children: [{ type: 'text', value: 'PRD-3' }] },
          ],
        },
        { type: 'code', value: 'PRD-4' },
      ],
    };
    remarkReferenceLinks({ githubBase: 'https://github.com', autolinks: [LINEAR] })(tree);
    const paragraph = tree.children?.[0]?.children ?? [];
    expect(paragraph[0]).toEqual({ type: 'inlineCode', value: 'PRD-1' });
    expect(paragraph[1]).toEqual({
      type: 'link',
      url: 'https://example.com',
      children: [{ type: 'text', value: 'PRD-2' }],
    });
    expect(paragraph[2]?.children?.[0]).toMatchObject({
      type: 'link',
      url: 'https://linear.app/inkeep/issue/PRD-3',
    });
    expect(tree.children?.[1]).toEqual({ type: 'code', value: 'PRD-4' });
  });

  test('with no rules set nothing changes', () => {
    const tree: Node = { type: 'root', children: [{ type: 'text', value: 'PRD-1 a/b#2' }] };
    remarkReferenceLinks(null)(tree);
    expect(tree.children).toEqual([{ type: 'text', value: 'PRD-1 a/b#2' }]);
  });
});

describe('githubWebBase', () => {
  test("uses the origin of the remote's web URL, which the server only reports for GitHub hosts", () => {
    expect(githubWebBase('https://github.com/inkeep/agents-private')).toBe('https://github.com');
    expect(githubWebBase('https://ghe.example.com/team/repo')).toBe('https://ghe.example.com');
  });

  test('falls back to github.com with no remote, a malformed URL, or a non-web scheme', () => {
    expect(githubWebBase(null)).toBe('https://github.com');
    expect(githubWebBase(undefined)).toBe('https://github.com');
    expect(githubWebBase('not a url')).toBe('https://github.com');
    expect(githubWebBase('javascript:alert(1)')).toBe('https://github.com');
  });

  test('the rules key changes when the host or the autolinks change', () => {
    const base = referenceRulesKey({ githubBase: 'https://github.com', autolinks: [LINEAR] });
    expect(
      referenceRulesKey({ githubBase: 'https://ghe.example.com', autolinks: [LINEAR] }),
    ).not.toBe(base);
    expect(referenceRulesKey({ githubBase: 'https://github.com', autolinks: [] })).not.toBe(base);
  });
});
