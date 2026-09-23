import { describe, expect, test } from 'vitest';
import type { Workspace } from '@/lib/workspace-paths';
import { buildDocPathResolver, remarkDocPathLinks, setDocPathResolver } from './doc-path-links';

const workspace: Workspace = {
  contentDir: '/Users/abraham/repo/public/open-knowledge',
  pathSeparator: '/',
};

const windowsWorkspace: Workspace = {
  contentDir: 'C:\\Users\\abraham\\repo\\public\\open-knowledge',
  pathSeparator: '\\',
};

describe('buildDocPathResolver', () => {
  test('null when the workspace is unknown', () => {
    expect(
      buildDocPathResolver({ workspace: null, pages: new Set(['reports/foo/REPORT']) }),
    ).toBeNull();
  });

  test('null when the page set is empty (page list not authoritative yet)', () => {
    expect(buildDocPathResolver({ workspace, pages: new Set() })).toBeNull();
  });

  test('try 1: absolute path with contentDir prefix resolves to docName', () => {
    const resolve = buildDocPathResolver({
      workspace,
      pages: new Set(['reports/foo/REPORT']),
    });
    expect(resolve).not.toBeNull();
    expect(resolve?.('/Users/abraham/repo/public/open-knowledge/reports/foo/REPORT.md')).toBe(
      'reports/foo/REPORT',
    );
  });

  test('try 2: repo-root-relative path composes onto contentDir', () => {
    const resolve = buildDocPathResolver({
      workspace,
      pages: new Set(['reports/foo/REPORT']),
    });
    expect(resolve?.('public/open-knowledge/reports/foo/REPORT.md')).toBe('reports/foo/REPORT');
  });

  test('try 3a: bare-tail path resolves via exact match against the page set', () => {
    const resolve = buildDocPathResolver({
      workspace,
      pages: new Set(['reports/foo/REPORT']),
    });
    expect(resolve?.('reports/foo/REPORT.md')).toBe('reports/foo/REPORT');
  });

  test('.mdx path resolves via exact match — Fumadocs trees are common under docs/', () => {
    const resolve = buildDocPathResolver({
      workspace,
      pages: new Set(['docs/intro']),
    });
    expect(resolve?.('docs/intro.mdx')).toBe('docs/intro');
  });

  test('try 3b: suffix-match resolves an in-subtree tail', () => {
    const resolve = buildDocPathResolver({
      workspace,
      pages: new Set(['some/deep/place/notes', 'reports/foo/REPORT']),
    });
    expect(resolve?.('place/notes.md')).toBe('some/deep/place/notes');
  });

  test('try 3 rejects ambiguous suffix matches — two candidates → no link', () => {
    const resolve = buildDocPathResolver({
      workspace,
      pages: new Set(['a/foo/README', 'b/foo/README']),
    });
    expect(resolve?.('foo/README.md')).toBeNull();
    expect(resolve?.('README.md')).toBeNull();
  });

  test('missing doc → null even when the path parses cleanly', () => {
    const resolve = buildDocPathResolver({
      workspace,
      pages: new Set(['reports/foo/REPORT']),
    });
    expect(resolve?.('reports/foo/DOES-NOT-EXIST.md')).toBeNull();
    expect(
      resolve?.('/Users/abraham/repo/public/open-knowledge/reports/foo/DOES-NOT-EXIST.md'),
    ).toBeNull();
  });

  test('non-markdown paths never link — the editor cannot open them', () => {
    const resolve = buildDocPathResolver({
      workspace,
      pages: new Set(['reports/foo/REPORT']),
    });
    expect(resolve?.('reports/foo/REPORT.ts')).toBeNull();
    expect(resolve?.('reports/foo/REPORT.txt')).toBeNull();
    expect(resolve?.('reports/foo/README')).toBeNull();
  });

  test('a leading @ is stripped before resolution — agents mention paths that way', () => {
    const resolve = buildDocPathResolver({
      workspace,
      pages: new Set(['reports/foo/REPORT']),
    });
    expect(resolve?.('@reports/foo/REPORT.md')).toBe('reports/foo/REPORT');
  });

  test('trailing #anchor is stripped before resolution', () => {
    const resolve = buildDocPathResolver({
      workspace,
      pages: new Set(['reports/foo/REPORT']),
    });
    expect(resolve?.('reports/foo/REPORT.md#somewhere')).toBe('reports/foo/REPORT');
  });

  test('dot-segment paths link when they are in the tracked page set (.changeset/, .github/, …)', () => {
    const resolve = buildDocPathResolver({
      workspace,
      pages: new Set(['.changeset/some-fix', '.github/CONTRIBUTING']),
    });
    expect(resolve?.('.changeset/some-fix.md')).toBe('.changeset/some-fix');
    expect(resolve?.('@.changeset/some-fix.md')).toBe('.changeset/some-fix');
    expect(resolve?.('.github/CONTRIBUTING.md')).toBe('.github/CONTRIBUTING');
  });

  test('Windows-style separators normalize to forward slashes', () => {
    const resolve = buildDocPathResolver({
      workspace: windowsWorkspace,
      pages: new Set(['reports/foo/REPORT']),
    });
    expect(
      resolve?.('C:\\Users\\abraham\\repo\\public\\open-knowledge\\reports\\foo\\REPORT.md'),
    ).toBe('reports/foo/REPORT');
  });
});

interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MdastNode[];
}

function makeTree(children: MdastNode[]): MdastNode {
  return { type: 'root', children };
}

describe('remarkDocPathLinks', () => {
  const resolve = buildDocPathResolver({
    workspace,
    pages: new Set(['reports/foo/REPORT']),
  });

  test('null resolver is a no-op — no walk, no allocations', () => {
    const tree = makeTree([
      { type: 'paragraph', children: [{ type: 'text', value: 'see reports/foo/REPORT.md ok' }] },
    ]);
    setDocPathResolver(null);
    remarkDocPathLinks()()(tree);
    expect(tree.children?.[0]?.children?.[0]).toEqual({
      type: 'text',
      value: 'see reports/foo/REPORT.md ok',
    });
  });

  test('a leading @ in a text node is matched and linked — the visible link text keeps the @', () => {
    const tree = makeTree([
      {
        type: 'paragraph',
        children: [{ type: 'text', value: 'see @reports/foo/REPORT.md for details' }],
      },
    ]);
    setDocPathResolver(resolve);
    remarkDocPathLinks()()(tree);
    const kids = tree.children?.[0]?.children ?? [];
    expect(kids).toHaveLength(3);
    expect(kids[1]).toMatchObject({
      type: 'link',
      url: '#/reports/foo/REPORT',
      children: [{ type: 'text', value: '@reports/foo/REPORT.md' }],
    });
  });

  test('splits a text node around a matched .mdx path — three code paths handle mdx (regex, stripMarkdownExt, plugin walk)', () => {
    const resolveForMdx = buildDocPathResolver({
      workspace,
      pages: new Set(['docs/intro']),
    });
    setDocPathResolver(resolveForMdx);
    const tree = makeTree([
      {
        type: 'paragraph',
        children: [{ type: 'text', value: 'edited docs/intro.mdx successfully' }],
      },
    ]);
    remarkDocPathLinks()()(tree);
    const kids = tree.children?.[0]?.children ?? [];
    expect(kids).toHaveLength(3);
    expect(kids[1]).toMatchObject({
      type: 'link',
      url: '#/docs/intro',
      children: [{ type: 'text', value: 'docs/intro.mdx' }],
    });
  });

  test('splits a text node around a matched path and wraps it in a link', () => {
    const tree = makeTree([
      {
        type: 'paragraph',
        children: [{ type: 'text', value: 'Written to reports/foo/REPORT.md (458 lines)' }],
      },
    ]);
    setDocPathResolver(resolve);
    remarkDocPathLinks()()(tree);
    const kids = tree.children?.[0]?.children ?? [];
    expect(kids).toHaveLength(3);
    expect(kids[0]).toEqual({ type: 'text', value: 'Written to ' });
    expect(kids[1]).toMatchObject({
      type: 'link',
      url: '#/reports/foo/REPORT',
      children: [{ type: 'text', value: 'reports/foo/REPORT.md' }],
    });
    expect(kids[2]).toEqual({ type: 'text', value: ' (458 lines)' });
  });

  test('wraps a whole-value inlineCode path in a link so backticked paths click through', () => {
    const tree = makeTree([
      {
        type: 'paragraph',
        children: [
          { type: 'text', value: 'see ' },
          { type: 'inlineCode', value: 'reports/foo/REPORT.md' },
        ],
      },
    ]);
    setDocPathResolver(resolve);
    remarkDocPathLinks()()(tree);
    const kids = tree.children?.[0]?.children ?? [];
    expect(kids).toHaveLength(2);
    expect(kids[1]).toMatchObject({
      type: 'link',
      url: '#/reports/foo/REPORT',
      children: [{ type: 'inlineCode', value: 'reports/foo/REPORT.md' }],
    });
  });

  test('leaves inlineCode alone when its value does not resolve', () => {
    const tree = makeTree([
      {
        type: 'paragraph',
        children: [{ type: 'inlineCode', value: 'const x = 1;' }],
      },
    ]);
    setDocPathResolver(resolve);
    remarkDocPathLinks()()(tree);
    expect(tree.children?.[0]?.children?.[0]).toEqual({
      type: 'inlineCode',
      value: 'const x = 1;',
    });
  });

  test('leaves existing links alone — no double-wrap, no linking inside', () => {
    const tree = makeTree([
      {
        type: 'paragraph',
        children: [
          {
            type: 'link',
            url: 'https://example.com',
            children: [{ type: 'text', value: 'reports/foo/REPORT.md' }],
          },
        ],
      },
    ]);
    setDocPathResolver(resolve);
    remarkDocPathLinks()()(tree);
    const kids = tree.children?.[0]?.children ?? [];
    expect(kids).toHaveLength(1);
    expect(kids[0]?.url).toBe('https://example.com');
    expect(kids[0]?.children?.[0]).toEqual({
      type: 'text',
      value: 'reports/foo/REPORT.md',
    });
  });

  test('ambiguous paths stay plain text — the resolver returned null', () => {
    const ambiguous = buildDocPathResolver({
      workspace,
      pages: new Set(['a/foo/README', 'b/foo/README']),
    });
    const tree = makeTree([
      {
        type: 'paragraph',
        children: [{ type: 'text', value: 'see foo/README.md for details' }],
      },
    ]);
    setDocPathResolver(ambiguous);
    remarkDocPathLinks()()(tree);
    expect(tree.children?.[0]?.children).toEqual([
      { type: 'text', value: 'see foo/README.md for details' },
    ]);
  });

  test('half-arrived path mid-stream (no extension yet) does not match', () => {
    const tree = makeTree([
      {
        type: 'paragraph',
        children: [{ type: 'text', value: 'writing to reports/foo/REPOR' }],
      },
    ]);
    setDocPathResolver(resolve);
    remarkDocPathLinks()()(tree);
    expect(tree.children?.[0]?.children).toEqual([
      { type: 'text', value: 'writing to reports/foo/REPOR' },
    ]);
  });

  test('handles multiple matches in a single text node', () => {
    const resolveMany = buildDocPathResolver({
      workspace,
      pages: new Set(['a/one', 'b/two']),
    });
    const tree = makeTree([
      {
        type: 'paragraph',
        children: [{ type: 'text', value: 'moved a/one.md into b/two.md' }],
      },
    ]);
    setDocPathResolver(resolveMany);
    remarkDocPathLinks()()(tree);
    const kids = tree.children?.[0]?.children ?? [];
    expect(kids).toHaveLength(4);
    expect(kids[0]).toEqual({ type: 'text', value: 'moved ' });
    expect(kids[1]?.url).toBe('#/a/one');
    expect(kids[2]).toEqual({ type: 'text', value: ' into ' });
    expect(kids[3]?.url).toBe('#/b/two');
  });

  test('a link the agent wrote to a doc path becomes an in-app link, text untouched', () => {
    for (const href of [
      'public/open-knowledge/reports/foo/REPORT.md',
      '/Users/abraham/repo/public/open-knowledge/reports/foo/REPORT.md',
      'file:///Users/abraham/repo/public/open-knowledge/reports/foo/REPORT.md',
      'public/open-knowledge/reports/foo/REPORT%2Emd',
    ]) {
      const tree = makeTree([
        {
          type: 'paragraph',
          children: [{ type: 'link', url: href, children: [{ type: 'text', value: 'REPORT.md' }] }],
        },
      ]);
      setDocPathResolver(resolve);
      remarkDocPathLinks()()(tree);
      const link = tree.children?.[0]?.children?.[0];
      expect(link?.url, href).toBe('#/reports/foo/REPORT');
      expect(link?.children?.[0]).toEqual({ type: 'text', value: 'REPORT.md' });
    }
  });

  test('a link to a doc that is not in the workspace is left exactly as written', () => {
    for (const href of [
      'public/open-knowledge/reports/nope/REPORT.md',
      'mailto:someone@example.com',
      'javascript:alert(1)',
      'javascript%3Aalert(1)',
      '//example.com/reports/foo/REPORT.md',
      '#/already/in-app',
    ]) {
      const tree = makeTree([
        {
          type: 'paragraph',
          children: [{ type: 'link', url: href, children: [{ type: 'text', value: 'x' }] }],
        },
      ]);
      setDocPathResolver(resolve);
      remarkDocPathLinks()()(tree);
      expect(tree.children?.[0]?.children?.[0]?.url, href).toBe(href);
    }
  });

  test('a scheme-shaped href never resolves, encoded or not, even when a page would match it', () => {
    const resolveOdd = buildDocPathResolver({
      workspace,
      pages: new Set(['myapp:reports/foo/REPORT']),
    });
    for (const href of ['myapp:reports/foo/REPORT.md', 'myapp%3Areports/foo/REPORT.md']) {
      const tree = makeTree([
        {
          type: 'paragraph',
          children: [{ type: 'link', url: href, children: [{ type: 'text', value: 'x' }] }],
        },
      ]);
      setDocPathResolver(resolveOdd);
      remarkDocPathLinks()()(tree);
      expect(tree.children?.[0]?.children?.[0]?.url, href).toBe(href);
    }
  });

  test('a link fragment rides along onto the in-app route', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['reports/foo/REPORT.md#findings', '#/reports/foo/REPORT#findings'],
      ['public/open-knowledge/reports/foo/REPORT.md#root-cause', '#/reports/foo/REPORT#root-cause'],
      ['reports/foo/REPORT.md#', '#/reports/foo/REPORT'],
    ];
    for (const [href, expected] of cases) {
      const tree = makeTree([
        {
          type: 'paragraph',
          children: [{ type: 'link', url: href, children: [{ type: 'text', value: 'x' }] }],
        },
      ]);
      setDocPathResolver(resolve);
      remarkDocPathLinks()()(tree);
      expect(tree.children?.[0]?.children?.[0]?.url, href).toBe(expected);
    }
  });

  test('a fragment on a backticked or prose path rides along too', () => {
    const tree = makeTree([
      {
        type: 'paragraph',
        children: [
          { type: 'text', value: 'see reports/foo/REPORT.md#findings and ' },
          { type: 'inlineCode', value: 'reports/foo/REPORT.md#root-cause' },
          { type: 'text', value: ' or reports/foo/REPORT.md# alone' },
        ],
      },
    ]);
    setDocPathResolver(resolve);
    remarkDocPathLinks()()(tree);
    const kids = tree.children?.[0]?.children ?? [];
    expect(kids.map((k) => k.type)).toEqual([
      'text',
      'link',
      'text',
      'link',
      'text',
      'link',
      'text',
    ]);
    expect(kids[1]?.url).toBe('#/reports/foo/REPORT#findings');
    expect(kids[1]?.children?.[0]).toEqual({
      type: 'text',
      value: 'reports/foo/REPORT.md#findings',
    });
    expect(kids[3]?.url).toBe('#/reports/foo/REPORT#root-cause');
    expect(kids[3]?.children?.[0]?.type).toBe('inlineCode');
    expect(kids[5]?.url).toBe('#/reports/foo/REPORT');
    expect(kids[6]).toEqual({ type: 'text', value: '# alone' });
  });

  test('a Windows path in a link reaches the resolver instead of reading as a scheme', () => {
    const resolveWindows = buildDocPathResolver({
      workspace: windowsWorkspace,
      pages: new Set(['reports/foo/REPORT']),
    });
    for (const href of [
      'C:\\Users\\abraham\\repo\\public\\open-knowledge\\reports\\foo\\REPORT.md',
      'file:///C:/Users/abraham/repo/public/open-knowledge/reports/foo/REPORT.md',
    ]) {
      const tree = makeTree([
        {
          type: 'paragraph',
          children: [{ type: 'link', url: href, children: [{ type: 'text', value: 'x' }] }],
        },
      ]);
      setDocPathResolver(resolveWindows);
      remarkDocPathLinks()()(tree);
      expect(tree.children?.[0]?.children?.[0]?.url, href).toBe('#/reports/foo/REPORT');
    }
  });

  test('a reference-style link resolves through its definition', () => {
    const tree = makeTree([
      {
        type: 'paragraph',
        children: [{ type: 'linkReference', children: [{ type: 'text', value: 'the report' }] }],
      },
      { type: 'definition', url: 'public/open-knowledge/reports/foo/REPORT.md', title: null },
    ]);
    setDocPathResolver(resolve);
    remarkDocPathLinks()()(tree);
    expect(tree.children?.[1]?.url).toBe('#/reports/foo/REPORT');
    expect(tree.children?.[0]?.children?.[0]?.type).toBe('linkReference');
  });

  test('a malformed percent-escape is taken literally, and later links still resolve', () => {
    const resolveLiteral = buildDocPathResolver({
      workspace,
      pages: new Set(['reports/100%/REPORT', 'reports/foo/REPORT']),
    });
    const link = (url: string): MdastNode => ({
      type: 'link',
      url,
      children: [{ type: 'text', value: 'x' }],
    });
    const tree = makeTree([
      {
        type: 'paragraph',
        children: [
          link('reports/100%/REPORT.md'),
          link('reports/foo%zz/REPORT.md'),
          link('reports/foo/REPORT.md'),
        ],
      },
    ]);
    setDocPathResolver(resolveLiteral);
    remarkDocPathLinks()()(tree);
    const kids = tree.children?.[0]?.children ?? [];
    expect(kids[0]?.url).toBe('#/reports/100%25/REPORT');
    expect(kids[1]?.url).toBe('reports/foo%zz/REPORT.md');
    expect(kids[2]?.url).toBe('#/reports/foo/REPORT');
  });
});
