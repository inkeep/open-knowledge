/**
 * Handler-level coverage for `palette`. Pins the three-section
 * payload (markdown-native component forms, themed embed starters, injected
 * tokens), the markdown-vs-jsx authoring split, and the registry grounding —
 * every registry-backed authoring form must name a live canonical descriptor.
 */

import { describe, expect, test } from 'bun:test';
import {
  getAgentCanonicalDescriptors,
  PREVIEW_EMBED_STARTERS,
  PREVIEW_THEME_TOKENS,
} from '@inkeep/open-knowledge-core';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import { register } from './palette.ts';
import type { ServerInstance } from './shared.ts';

const BASE_CONFIG: Config = ConfigSchema.parse({ content: { dir: '.' } });

interface AuthoringComponent {
  id: string;
  displayName: string;
  description: string;
  authoring: 'markdown' | 'jsx';
  example: string;
  guidance: string;
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: {
    version: number;
    components: AuthoringComponent[];
    embedPatterns: Array<{ id: string; title: string; description: string; snippet: string }>;
    tokens: Array<{ name: string; light: string; dark: string }>;
    text?: string;
  };
  isError?: boolean;
}

type ToolHandler = (args: { cwd?: string }) => Promise<ToolResult>;

function captureRegistration(): ToolHandler {
  let captured: ToolHandler | null = null;
  const server = {
    registerTool(_name: string, _config: unknown, handler: ToolHandler) {
      captured = handler;
    },
    tool() {
      throw new Error('legacy tool() should not be called by palette');
    },
  } as unknown as ServerInstance;
  register(server, {
    config: BASE_CONFIG,
    resolveCwd: async () => '/tmp/ok-get-authoring-palette-test',
  });
  if (!captured) throw new Error('tool not registered');
  return captured;
}

describe('palette tool', () => {
  test('returns the three-section payload with a version stamp', async () => {
    const handler = captureRegistration();
    const result = await handler({});
    expect(result.isError).toBeUndefined();
    const body = result.structuredContent;
    expect(body?.version).toBe(1);
    expect(Array.isArray(body?.components)).toBe(true);
    expect(Array.isArray(body?.embedPatterns)).toBe(true);
    expect(Array.isArray(body?.tokens)).toBe(true);
  });

  test('components teach the markdown-native forms, not JSX, where one exists', async () => {
    const handler = captureRegistration();
    const { structuredContent } = await handler({});
    const byId = new Map((structuredContent?.components ?? []).map((c) => [c.id, c]));

    const callout = byId.get('Callout');
    expect(callout?.authoring).toBe('markdown');
    expect(callout?.example).toContain('[!NOTE]');

    const accordion = byId.get('Accordion');
    expect(accordion?.authoring).toBe('markdown');
    expect(accordion?.example).toContain('<details>');

    const mermaid = byId.get('Mermaid');
    expect(mermaid?.authoring).toBe('markdown');
    expect(mermaid?.example).toContain('```mermaid');

    // Tabs is the lone JSX-only canonical.
    const tabs = byId.get('Tabs');
    expect(tabs?.authoring).toBe('jsx');
    expect(tabs?.example).toContain('<Tabs>');
  });

  test('Mermaid entry teaches the grammar sharp edges and the feedback loop', async () => {
    const handler = captureRegistration();
    const { structuredContent } = await handler({});
    const mermaid = structuredContent?.components.find((c) => c.id === 'Mermaid');
    expect(mermaid).toBeDefined();
    // Sequence-family terminators + their escapes, flowchart-label quoting,
    // and the write/edit feedback channel must all be present — agents are
    // told fenced blocks "don't need a fetch", so this entry is the single
    // place the pitfalls live.
    expect(mermaid?.guidance).toContain('`;`');
    expect(mermaid?.guidance).toContain('`#`');
    expect(mermaid?.guidance).toContain('#59;');
    expect(mermaid?.guidance).toContain('#35;');
    expect(mermaid?.guidance).toContain('label (with) punctuation');
    expect(mermaid?.guidance).toContain('mermaid-parse-error');
    // The example demonstrates both sharp-edge families.
    expect(mermaid?.example).toContain('sequenceDiagram');
    expect(mermaid?.example).toContain('#59;');
    expect(mermaid?.example).toContain('"Start (label with punctuation)"');
  });

  test('every registry-backed authoring form names a live canonical descriptor', async () => {
    const handler = captureRegistration();
    const { structuredContent } = await handler({});
    const canonicalNames = new Set(getAgentCanonicalDescriptors().map((d) => d.name));
    // Callout / Accordion / Math / Tabs are registry-backed; their id must
    // still resolve to a canonical so the palette can't advertise a dropped
    // component. (Mermaid + wiki-embed are intentionally not registry-backed.)
    for (const id of ['Callout', 'Accordion', 'Math', 'Tabs']) {
      expect(canonicalNames.has(id)).toBe(true);
      expect(structuredContent?.components.some((c) => c.id === id)).toBe(true);
    }
  });

  test('embedPatterns expose every starter as a ```html preview fence', async () => {
    const handler = captureRegistration();
    const { structuredContent } = await handler({});
    const patterns = structuredContent?.embedPatterns ?? [];
    expect(patterns.map((p) => p.id).sort()).toEqual(
      [...PREVIEW_EMBED_STARTERS].map((s) => s.id).sort(),
    );
    for (const pattern of patterns) {
      expect(pattern.snippet.startsWith('```html preview')).toBe(true);
      expect(pattern.snippet.trimEnd().endsWith('```')).toBe(true);
      // Starters are theme-wired — they must reference the injected tokens.
      expect(pattern.snippet).toContain('var(--');
    }
  });

  test('tokens mirror the injected PREVIEW_THEME_TOKENS subset', async () => {
    const handler = captureRegistration();
    const { structuredContent } = await handler({});
    expect(structuredContent?.tokens).toEqual(
      PREVIEW_THEME_TOKENS.map((t) => ({ name: t.name, light: t.light, dark: t.dark })),
    );
  });

  test('content[0].text mirrors structuredContent as JSON (dual-channel envelope)', async () => {
    const handler = captureRegistration();
    const result = await handler({});
    const parsed = JSON.parse(result.content[0]?.text ?? '{}');
    expect(parsed.version).toBe(1);
    expect(parsed.components.length).toBe(result.structuredContent?.components.length);
    expect(parsed.embedPatterns.length).toBe(PREVIEW_EMBED_STARTERS.length);
  });
});
