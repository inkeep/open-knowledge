
import { describe, expect, test } from 'bun:test';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { mdxFromMarkdown } from 'mdast-util-mdx';
import { mdx } from 'micromark-extension-mdx';
import {
  getAgentCanonicalDescriptors,
  getCanonicalDescriptors,
  projectFull,
  projectLite,
  renderInventoryFooter,
} from './projection.ts';

const PARSE_EXTENSIONS = [mdx()];
const PARSE_MDAST_EXTENSIONS = [mdxFromMarkdown()];

describe('getCanonicalDescriptors (broad filter)', () => {
  test('returns 14 canonicals (matches built-ins snapshot)', () => {
    const canonicals = getCanonicalDescriptors();
    expect(canonicals.length).toBe(14);
  });

  test('excludes compat surfaces', () => {
    for (const d of getCanonicalDescriptors()) {
      expect(d.surface).toBe('canonical');
    }
  });

  test('excludes wildcard descriptor', () => {
    for (const d of getCanonicalDescriptors()) {
      expect(d.name).not.toBe('*');
    }
  });

  test('MermaidFence is in the broad set (it is canonical for the parse pipeline)', () => {
    const names = new Set(getCanonicalDescriptors().map((d) => d.name));
    expect(names.has('MermaidFence')).toBe(true);
  });
});

describe('getAgentCanonicalDescriptors (JSX-only agent surface)', () => {
  test('returns 13 canonicals — broad set minus fence-kind', () => {
    expect(getAgentCanonicalDescriptors().length).toBe(13);
  });

  test('excludes MermaidFence (no JSX form exists; agents author the fence directly)', () => {
    const names = new Set(getAgentCanonicalDescriptors().map((d) => d.name));
    expect(names.has('MermaidFence')).toBe(false);
  });

  test('every entry is jsx-block or jsx-void — no fence-kind leaks through', () => {
    for (const d of getAgentCanonicalDescriptors()) {
      const lite = projectLite(d);
      expect(['jsx-block', 'jsx-void']).toContain(lite.kind);
    }
  });

  test('broad set minus agent set equals exactly the fence-kind names', () => {
    const broad = new Set(getCanonicalDescriptors().map((d) => d.name));
    const agent = new Set(getAgentCanonicalDescriptors().map((d) => d.name));
    const divergence = new Set([...broad].filter((name) => !agent.has(name)));
    expect(divergence).toEqual(new Set(['MermaidFence']));
  });
});

describe('projectLite — 4 fields per entry', () => {
  test('every lite entry carries id / displayName / description / kind', () => {
    for (const d of getCanonicalDescriptors()) {
      const lite = projectLite(d);
      expect(lite.id).toBe(d.name);
      expect(lite.displayName.length).toBeGreaterThan(0);
      expect(lite.description.length).toBeGreaterThan(0);
      expect(['jsx-block', 'jsx-void', 'fence']).toContain(lite.kind);
    }
  });

  test('MermaidFence is the one fence-kind canonical in the broad set (but excluded from the agent surface)', () => {
    const lite = getCanonicalDescriptors().map(projectLite);
    const fences = lite.filter((entry) => entry.kind === 'fence');
    expect(fences.length).toBe(1);
    expect(fences[0].id).toBe('MermaidFence');
  });
});

describe('projectFull — example + form-aware params (FR-11)', () => {
  test('every canonical has a non-empty example string', () => {
    for (const d of getCanonicalDescriptors()) {
      const full = projectFull(d);
      expect(full.example.length).toBeGreaterThan(0);
    }
  });

  test('every canonical example parses back to the expected mdast kind', () => {
    for (const d of getCanonicalDescriptors()) {
      const full = projectFull(d);
      const tree = fromMarkdown(full.example, {
        extensions: PARSE_EXTENSIONS,
        mdastExtensions: PARSE_MDAST_EXTENSIONS,
      });
      expect(tree.children.length).toBeGreaterThan(0);
      const first = tree.children[0];
      if (full.kind === 'fence') {
        expect(first.type).toBe('code');
        expect((first as { lang?: string }).lang).toBe('mermaid');
      } else {
        expect(first.type).toBe('mdxJsxFlowElement');
        expect((first as { name?: string }).name).toBe(d.name);
      }
    }
  });

  test('params filter hidden:true; reactnode (children) surfaces so agents know the body slot exists; enum carries values', () => {
    const callout = getCanonicalDescriptors().find((d) => d.name === 'Callout');
    expect(callout).toBeDefined();
    const full = projectFull(callout as Parameters<typeof projectFull>[0]);
    const paramNames = full.params.map((p) => p.name);
    expect(paramNames).toContain('children');
    const childrenParam = full.params.find((p) => p.name === 'children');
    expect(childrenParam?.type).toBe('reactnode');
    const typeParam = full.params.find((p) => p.name === 'type');
    expect(typeParam?.type).toBe('enum');
    expect(typeParam?.values).toBeDefined();
    expect((typeParam?.values ?? []).length).toBeGreaterThan(0);
  });

  test('example for jsx-void components contains no body text', () => {
    const img = getCanonicalDescriptors().find((d) => d.name === 'img');
    expect(img).toBeDefined();
    const full = projectFull(img as Parameters<typeof projectFull>[0]);
    expect(full.example).toContain('<img');
    expect(full.example).toContain('/>');
  });

  test('MermaidFence example synthesis still works (defensive — caller could project it directly)', () => {
    const mermaid = getCanonicalDescriptors().find((d) => d.name === 'MermaidFence');
    expect(mermaid).toBeDefined();
    const full = projectFull(mermaid as Parameters<typeof projectFull>[0]);
    expect(full.example.startsWith('```mermaid')).toBe(true);
  });

  test('example for Tabs nests the compositional `<Tab>` children from exampleBody', () => {
    const tabs = getCanonicalDescriptors().find((d) => d.name === 'Tabs');
    expect(tabs).toBeDefined();
    const full = projectFull(tabs as Parameters<typeof projectFull>[0]);
    expect(full.example).toContain('<Tab');
    expect(full.example).toContain('</Tabs>');
  });
});

describe('renderInventoryFooter (FR-1)', () => {
  test('mentions every agent-facing canonical id', () => {
    const text = renderInventoryFooter();
    for (const d of getAgentCanonicalDescriptors()) {
      expect(text).toContain(`\`${d.name}\``);
    }
  });

  test('does NOT list MermaidFence (fence-kind excluded from agent surface)', () => {
    const text = renderInventoryFooter();
    expect(text).not.toContain('`MermaidFence`');
  });

  test('carries the look-up pointer to palette', () => {
    const text = renderInventoryFooter();
    expect(text).toContain('palette');
  });

  test('mentions fenced code blocks as a separate authoring path (not a component)', () => {
    const text = renderInventoryFooter();
    expect(text).toContain('Fenced code blocks');
  });

  test('carries the wildcard tolerance contract for no-canonical-fits authoring', () => {
    const text = renderInventoryFooter();
    expect(text).toContain('<TagName>');
  });

  test('stays under 3.5KB at N=11 (NFR performance bound — extra ~600 bytes covers the fenced-code-block authoring guidance + the Embed→video-block steer for YouTube/Vimeo/Loom URLs added per PRD-7069)', () => {
    const text = renderInventoryFooter();
    expect(text.length).toBeLessThan(3584);
  });

  test('mentions the `html preview` fence affordance for interactive content', () => {
    const text = renderInventoryFooter();
    expect(text).toContain('```html preview');
  });
});
