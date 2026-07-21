import { describe, expect, test } from 'vitest';

import {
  buildGraphLinkSignature,
  type GraphDocDisplayState,
  getGraphNodeCanvasRadius,
  getGraphNodePointerRadius,
  getGraphNodeTooltipLabel,
  getGraphNodeVisualState,
  getHashForGraphDocSelection,
  reconcileGraphData,
  resolveGraphNodeClickAction,
} from './graph-view-utils';

type GraphPhysicsFixture = {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  __indexColor?: string;
};

type GraphNodeFixture = {
  id: string;
  label: string;
  cluster?: string | null;
} & GraphPhysicsFixture;

type GraphLinkFixture = {
  source: string | { id: string };
  target: string | { id: string };
  __indexColor?: string;
};

describe('getGraphNodeTooltipLabel', () => {
  test('returns plain label for doc nodes without metadata', () => {
    expect(
      getGraphNodeTooltipLabel({
        kind: 'doc',
        id: 'notes/alpha',
        label: 'Alpha',
        docName: 'notes/alpha',
        anchor: null,
      }),
    ).toBe('Alpha');
  });

  test('falls back to node id when a document label is missing', () => {
    expect(
      getGraphNodeTooltipLabel({
        kind: 'doc',
        id: 'notes/alpha',
        label: undefined as unknown as string,
        docName: 'notes/alpha',
        anchor: null,
      }),
    ).toBe('notes/alpha');
  });

  test('returns full URL for external nodes', () => {
    expect(
      getGraphNodeTooltipLabel({
        kind: 'external',
        id: 'external:https://example.com/path',
        label: 'example.com',
        url: 'https://example.com/path',
      }),
    ).toBe('https://example.com/path');
  });

  test('returns HTML with all metadata fields', () => {
    const html = getGraphNodeTooltipLabel({
      kind: 'doc',
      id: 'notes/rag',
      label: 'RAG Patterns',
      docName: 'notes/rag',
      anchor: null,
      cluster: 'retrieval',
      category: 'method',
      tags: ['rag', 'embeddings', 'search'],
    });
    expect(html).toContain('RAG Patterns');
    expect(html).toContain('retrieval');
    expect(html).toContain('method');
    expect(html).toContain('rag, embeddings, search');
    expect(html).toContain('<div');
  });

  test('returns HTML with only cluster field', () => {
    const html = getGraphNodeTooltipLabel({
      kind: 'doc',
      id: 'notes/x',
      label: 'X Doc',
      docName: 'notes/x',
      anchor: null,
      cluster: 'planning',
    });
    expect(html).toContain('X Doc');
    expect(html).toContain('planning');
    expect(html).not.toContain('category:');
    expect(html).not.toContain('tags:');
  });

  test('returns HTML with only tags field', () => {
    const html = getGraphNodeTooltipLabel({
      kind: 'doc',
      id: 'notes/y',
      label: 'Y Doc',
      docName: 'notes/y',
      anchor: null,
      tags: ['alpha', 'beta'],
    });
    expect(html).toContain('Y Doc');
    expect(html).toContain('alpha, beta');
    expect(html).not.toContain('cluster:');
  });

  test('returns plain label when metadata fields are null', () => {
    expect(
      getGraphNodeTooltipLabel({
        kind: 'doc',
        id: 'notes/z',
        label: 'Z Doc',
        docName: 'notes/z',
        anchor: null,
        cluster: null,
        category: null,
        tags: null,
      }),
    ).toBe('Z Doc');
  });

  test('returns plain label when tags is empty array', () => {
    expect(
      getGraphNodeTooltipLabel({
        kind: 'doc',
        id: 'notes/w',
        label: 'W Doc',
        docName: 'notes/w',
        anchor: null,
        tags: [],
      }),
    ).toBe('W Doc');
  });

  test('escapes HTML characters in metadata values', () => {
    const html = getGraphNodeTooltipLabel({
      kind: 'doc',
      id: 'notes/xss',
      label: '<script>alert("xss")</script>',
      docName: 'notes/xss',
      anchor: null,
      cluster: 'a<b',
      tags: ['x&y'],
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a&lt;b');
    expect(html).toContain('x&amp;y');
  });

  test.each([
    {
      displayState: 'missing' as GraphDocDisplayState,
      heading: 'Broken / uncreated link',
      detail: 'This page does not exist yet. Open it to create it.',
    },
    {
      displayState: 'folder' as GraphDocDisplayState,
      heading: 'Folder target',
      detail: 'This link resolves to a folder view rather than a standalone page.',
    },
  ])('returns status-rich HTML for $displayState doc targets', ({
    displayState,
    heading,
    detail,
  }) => {
    const html = getGraphNodeTooltipLabel(
      {
        kind: 'doc',
        id: 'notes/alpha',
        label: 'Alpha',
        docName: 'notes/alpha',
        anchor: null,
      },
      { displayState },
    );

    expect(html).toContain('<div');
    expect(html).toContain(heading);
    expect(html).toContain(detail);
    expect(html).toContain('Alpha');
  });
});

describe('resolveGraphNodeClickAction', () => {
  test('selects fullscreen document nodes without losing anchor metadata', () => {
    expect(
      resolveGraphNodeClickAction(
        {
          kind: 'doc',
          id: 'notes/alpha',
          label: 'Alpha',
          docName: 'notes/alpha',
          anchor: 'deep-link',
        },
        'select',
      ),
    ).toEqual({
      kind: 'select',
      selection: {
        kind: 'doc',
        id: 'notes/alpha',
        docName: 'notes/alpha',
        label: 'Alpha',
        anchor: 'deep-link',
      },
    });
  });

  test('selects fullscreen document nodes without anchors', () => {
    expect(
      resolveGraphNodeClickAction(
        {
          kind: 'doc',
          id: 'notes/alpha',
          label: 'Alpha',
          docName: 'notes/alpha',
          anchor: null,
        },
        'select',
      ),
    ).toEqual({
      kind: 'select',
      selection: {
        kind: 'doc',
        id: 'notes/alpha',
        docName: 'notes/alpha',
        label: 'Alpha',
        anchor: null,
      },
    });
  });

  test('navigates docked document nodes through fragment anchor hashes', () => {
    expect(
      resolveGraphNodeClickAction(
        {
          kind: 'doc',
          id: 'notes/alpha',
          label: 'Alpha',
          docName: 'notes/alpha',
          anchor: 'deep-link',
        },
        'navigate',
      ),
    ).toEqual({
      kind: 'navigate',
      hash: '#/notes/alpha#deep-link',
    });
  });

  test('keeps external nodes on the new-tab path in both modes', () => {
    const externalNode = {
      kind: 'external' as const,
      id: 'external:https://example.com/docs',
      label: 'example.com',
      url: 'https://example.com/docs',
    };

    expect(resolveGraphNodeClickAction(externalNode, 'navigate')).toEqual({
      kind: 'external',
      url: 'https://example.com/docs',
    });
    expect(resolveGraphNodeClickAction(externalNode, 'select')).toEqual({
      kind: 'select',
      selection: {
        kind: 'external',
        id: 'external:https://example.com/docs',
        label: 'example.com',
        url: 'https://example.com/docs',
      },
    });
  });
});

describe('getGraphNodeVisualState', () => {
  test('distinguishes active, selected, and active-and-selected document states', () => {
    const node = {
      kind: 'doc' as const,
      id: 'notes/alpha',
      label: 'Alpha',
      docName: 'notes/alpha',
      anchor: null,
    };

    expect(
      getGraphNodeVisualState(node, {
        activeDocName: 'notes/current',
        selectedNodeId: null,
      }),
    ).toBe('default');

    expect(
      getGraphNodeVisualState(node, {
        activeDocName: 'notes/alpha',
        selectedNodeId: null,
      }),
    ).toBe('active');

    expect(
      getGraphNodeVisualState(node, {
        activeDocName: 'notes/current',
        selectedNodeId: 'notes/alpha',
      }),
    ).toBe('selected');

    expect(
      getGraphNodeVisualState(node, {
        activeDocName: 'notes/alpha',
        selectedNodeId: 'notes/alpha',
      }),
    ).toBe('active-selected');
  });

  test('keeps external nodes on their own visual path until selected', () => {
    expect(
      getGraphNodeVisualState(
        {
          kind: 'external',
          id: 'external:https://example.com',
          label: 'example.com',
          url: 'https://example.com',
        },
        {
          activeDocName: 'notes/alpha',
          selectedNodeId: null,
        },
      ),
    ).toBe('external');

    expect(
      getGraphNodeVisualState(
        {
          kind: 'external',
          id: 'external:https://example.com',
          label: 'example.com',
          url: 'https://example.com',
        },
        {
          activeDocName: 'notes/alpha',
          selectedNodeId: 'external:https://example.com',
        },
      ),
    ).toBe('external-selected');
  });
});

describe('graph node radii', () => {
  test('keeps canvas radii in sync with the visual node states', () => {
    expect(getGraphNodeCanvasRadius('default')).toBe(5);
    expect(getGraphNodeCanvasRadius('external')).toBe(5);
    expect(getGraphNodeCanvasRadius('external-selected')).toBe(7);
    expect(getGraphNodeCanvasRadius('selected')).toBe(7);
    expect(getGraphNodeCanvasRadius('active')).toBe(8);
    expect(getGraphNodeCanvasRadius('active-selected')).toBe(8);
  });

  test('expands pointer radii to include the visible selection ring', () => {
    expect(getGraphNodePointerRadius('default', 2)).toBe(5);
    expect(getGraphNodePointerRadius('external-selected', 2)).toBe(8);
    expect(getGraphNodePointerRadius('selected', 2)).toBe(8);
    expect(getGraphNodePointerRadius('active', 2)).toBe(9);
    expect(getGraphNodePointerRadius('active-selected', 2)).toBe(9);
  });
});

describe('getHashForGraphDocSelection', () => {
  test('preserves anchors when opening a fullscreen selection', () => {
    expect(
      getHashForGraphDocSelection({
        docName: 'notes/alpha',
        label: 'Alpha',
        anchor: 'deep-link',
      }),
    ).toBe('#/notes/alpha#deep-link');
  });

  test('generates a hash without fragments when anchor is null', () => {
    expect(
      getHashForGraphDocSelection({
        docName: 'notes/alpha',
        label: 'Alpha',
        anchor: null,
      }),
    ).toBe('#/notes/alpha');
  });
});

describe('reconcileGraphData', () => {
  test('preserves settled node physics for unchanged ids while refreshing metadata', () => {
    const previous: {
      nodes: Array<
        {
          kind: 'doc';
          docName: string;
          anchor: null;
        } & GraphNodeFixture
      >;
      links: GraphLinkFixture[];
    } = {
      nodes: [
        {
          kind: 'doc',
          id: 'notes/alpha',
          label: 'Alpha (old)',
          docName: 'notes/alpha',
          anchor: null,
          x: 120,
          y: -40,
          vx: 0.25,
          vy: -0.5,
          fx: null,
          fy: null,
          __indexColor: '#123456',
        },
      ],
      links: [
        {
          source: { id: 'notes/alpha' },
          target: { id: 'notes/beta' },
          __indexColor: '#abcdef',
        },
      ],
    };

    const next = {
      nodes: [
        {
          kind: 'doc' as const,
          id: 'notes/alpha',
          label: 'Alpha (new)',
          docName: 'notes/alpha',
          anchor: null,
          cluster: 'planning',
        },
        {
          kind: 'doc' as const,
          id: 'notes/beta',
          label: 'Beta',
          docName: 'notes/beta',
          anchor: null,
        },
      ],
      links: [{ source: 'notes/alpha', target: 'notes/beta' }],
    };

    const reconciled = reconcileGraphData(
      previous as unknown as Parameters<typeof reconcileGraphData>[0],
      next,
    );
    const alpha = reconciled.nodes[0] as GraphNodeFixture;
    const beta = reconciled.nodes[1] as GraphNodeFixture;
    const link = reconciled.links[0] as unknown as GraphLinkFixture;

    expect(alpha.label).toBe('Alpha (new)');
    expect(alpha.cluster).toBe('planning');
    expect(alpha.x).toBe(120);
    expect(alpha.y).toBe(-40);
    expect(alpha.vx).toBe(0.25);
    expect(alpha.vy).toBe(-0.5);
    expect(alpha.__indexColor).toBe('#123456');
    expect(beta.x).toBeUndefined();
    expect(beta.y).toBeUndefined();
    expect(link.__indexColor).toBe('#abcdef');
  });

  test('does not carry physics state forward for nodes absent from next', () => {
    const previous = {
      nodes: [
        {
          kind: 'doc' as const,
          id: 'notes/alpha',
          label: 'Alpha',
          docName: 'notes/alpha',
          anchor: null,
          x: 10,
          y: 20,
        },
        {
          kind: 'doc' as const,
          id: 'notes/removed',
          label: 'Removed',
          docName: 'notes/removed',
          anchor: null,
          x: 99,
          y: 99,
        },
      ],
      links: [],
    };

    const next = {
      nodes: [
        {
          kind: 'doc' as const,
          id: 'notes/alpha',
          label: 'Alpha',
          docName: 'notes/alpha',
          anchor: null,
        },
        {
          kind: 'doc' as const,
          id: 'notes/new',
          label: 'New',
          docName: 'notes/new',
          anchor: null,
        },
      ],
      links: [],
    };

    const reconciled = reconcileGraphData(
      previous as unknown as Parameters<typeof reconcileGraphData>[0],
      next,
    );

    expect(reconciled.nodes).toHaveLength(2);
    const ids = reconciled.nodes.map((n) => n.id);
    expect(ids).not.toContain('notes/removed');
    const alpha = reconciled.nodes.find((n) => n.id === 'notes/alpha') as GraphNodeFixture;
    expect(alpha.x).toBe(10);
    expect(alpha.y).toBe(20);
    const newNode = reconciled.nodes.find((n) => n.id === 'notes/new') as GraphNodeFixture;
    expect(newNode.x).toBeUndefined();
    expect(newNode.y).toBeUndefined();
  });
});

describe('buildGraphLinkSignature', () => {
  test('normalizes force-graph object endpoints back to stable id signatures', () => {
    expect(
      buildGraphLinkSignature([
        { source: 'notes/alpha', target: 'notes/beta' },
        {
          source: { id: 'notes/beta' },
          target: { id: 'notes/gamma' },
        },
      ] as unknown as Parameters<typeof buildGraphLinkSignature>[0]),
    ).toBe('notes/alpha>notes/beta,notes/beta>notes/gamma');
  });
});

describe('reconcileGraphData — staged entrance (showcase)', () => {
  const doc = (id: string) => ({
    kind: 'doc' as const,
    id,
    label: id,
    docName: id,
    anchor: null,
  });
  const NOW = 1_000_000;
  const entrance = { nodeStepMs: 140, linkExtraMs: 260 };

  test('a clump of new nodes staggers sequentially; links wait for both endpoints', () => {
    const merged = reconcileGraphData(
      { nodes: [doc('hub')], links: [] },
      {
        nodes: [doc('hub'), doc('a'), doc('b'), doc('c')],
        links: [
          { source: 'hub', target: 'a' },
          { source: 'a', target: 'c' },
        ],
      },
      NOW,
      entrance,
    );
    const bornById = new Map(merged.nodes.map((node) => [node.id, node.bornAt]));
    expect(bornById.get('a')).toBe(NOW);
    expect(bornById.get('b')).toBe(NOW + 140);
    expect(bornById.get('c')).toBe(NOW + 280);
    // hub pre-existed with no bornAt → stamped now (no stagger for survivors).
    expect(bornById.get('hub')).toBe(NOW);
    // hub>a waits for a; a>c waits for c (the later endpoint).
    expect(merged.links[0]?.bornAt).toBe(NOW + 260);
    expect(merged.links[1]?.bornAt).toBe(NOW + 280 + 260);
  });

  test('a lone arrival gets no artificial delay', () => {
    const merged = reconcileGraphData(
      { nodes: [doc('hub')], links: [] },
      { nodes: [doc('hub'), doc('solo')], links: [{ source: 'hub', target: 'solo' }] },
      NOW,
      entrance,
    );
    expect(merged.nodes.find((node) => node.id === 'solo')?.bornAt).toBe(NOW);
    expect(merged.links[0]?.bornAt).toBe(NOW + 260);
  });

  test('surviving links keep their original bornAt across staggered applies', () => {
    const first = reconcileGraphData(
      { nodes: [], links: [] },
      { nodes: [doc('a'), doc('b')], links: [{ source: 'a', target: 'b' }] },
      NOW,
      entrance,
    );
    const second = reconcileGraphData(
      first,
      { nodes: [doc('a'), doc('b'), doc('c'), doc('d')], links: [{ source: 'a', target: 'b' }] },
      NOW + 5_000,
      entrance,
    );
    expect(second.links[0]?.bornAt).toBe(first.links[0]?.bornAt);
  });

  test('without entrance options behavior is unchanged (everything born now)', () => {
    const merged = reconcileGraphData(
      { nodes: [], links: [] },
      { nodes: [doc('a'), doc('b')], links: [{ source: 'a', target: 'b' }] },
      NOW,
    );
    expect(merged.nodes.every((node) => node.bornAt === NOW)).toBe(true);
    expect(merged.links[0]?.bornAt).toBe(NOW);
  });
});

describe('reconcileGraphData — instant baseline (pre-build content)', () => {
  const doc = (id: string) => ({
    kind: 'doc' as const,
    id,
    label: id,
    docName: id,
    anchor: null,
  });
  const NOW = 2_000_000;

  test('fresh mount: baseline nodes/links are instantly present; only additions stagger', () => {
    const merged = reconcileGraphData(
      { nodes: [], links: [] },
      {
        nodes: [doc('old-1'), doc('old-2'), doc('new-1'), doc('new-2')],
        links: [
          { source: 'old-1', target: 'old-2' },
          { source: 'new-1', target: 'new-2' },
        ],
      },
      NOW,
      {
        nodeStepMs: 140,
        linkExtraMs: 260,
        instantNodeIds: new Set(['old-1', 'old-2']),
        instantLinkKeys: new Set(['old-1>old-2']),
      },
    );
    const bornById = new Map(merged.nodes.map((node) => [node.id, node.bornAt]));
    expect(bornById.get('old-1')).toBe(0);
    expect(bornById.get('old-2')).toBe(0);
    expect(bornById.get('new-1')).toBe(NOW);
    expect(bornById.get('new-2')).toBe(NOW + 140);
    expect(merged.links[0]?.bornAt).toBe(0);
    expect(merged.links[1]?.bornAt).toBe(NOW + 140 + 260);
  });
});
