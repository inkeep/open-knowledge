/**
 * Wire-contract tests for the MCP CRUD-verb shared leaves. The MCP
 * `FrontmatterArg` reuses `FrontmatterValueSchema` from core — a regression in
 * either source widens or narrows what `write` / `edit` / `delete` / `move`
 * accept. These tests pin the wire-level acceptance so a future schema
 * rewrite can't silently re-introduce the "flat-only" contract.
 */
import { describe, expect, test } from 'bun:test';
import { SUPPORTED_DOC_EXTENSIONS } from '../../doc-extensions.ts';
import { DocExtensionArg, FrontmatterArg, resolveSkillFilePath } from './verb-schemas.ts';

describe('FrontmatterArg — recursive value contract (PRD-6947)', () => {
  test('flat scalar values still parse (regression guard for the pre-PRD-6947 contract)', () => {
    const result = FrontmatterArg.safeParse({
      title: 'Q3 Planning',
      done: true,
      score: 0.95,
      tags: ['planning', 'q3'],
    });
    expect(result.success).toBe(true);
  });

  test('nested-object value at a top-level key parses', () => {
    const result = FrontmatterArg.safeParse({
      metadata: { version: '1.0.0', author: 'Inkeep' },
    });
    expect(result.success).toBe(true);
  });

  test('arbitrarily deep nesting (map in map in map) parses', () => {
    const result = FrontmatterArg.safeParse({
      metadata: { outer: { inner: { leaf: 'deep' } } },
    });
    expect(result.success).toBe(true);
  });

  test('array-of-objects value parses; element objects pass through unchanged (NOT String()-coerced)', () => {
    const input = {
      plugins: [
        { name: 'alpha', version: '1.0' },
        { name: 'beta', version: '2.0' },
      ],
    };
    const result = FrontmatterArg.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(input);
    }
  });

  test('top-level null parses (RFC 7396 delete sentinel preserved)', () => {
    const result = FrontmatterArg.safeParse({ metadata: null });
    expect(result.success).toBe(true);
  });

  test('nested null INSIDE a subtree is rejected (D9: wire stays additive, no path syntax)', () => {
    const result = FrontmatterArg.safeParse({ metadata: { version: null } });
    expect(result.success).toBe(false);
  });

  test('mixed flat + nested keys in one patch parse together', () => {
    const result = FrontmatterArg.safeParse({
      title: 'Skill',
      tags: ['demo'],
      metadata: { version: '1.0.0', author: 'Inkeep' },
    });
    expect(result.success).toBe(true);
  });

  test('description text reflects recursive value contract (no stale "flat mapping" claim)', () => {
    // Zod v4 exposes `.describe()` content directly on `.description`. The
    // MCP SDK emits this verbatim into the JSON Schema the model reads, so
    // it is part of the agent-facing wire contract.
    const description = FrontmatterArg.description ?? '';
    expect(description).toContain('nested');
    expect(description).not.toContain('flat key→value');
  });
});

describe('DocExtensionArg — explicit on-create file format', () => {
  test('accepts every supported extension', () => {
    for (const ext of SUPPORTED_DOC_EXTENSIONS) {
      expect(DocExtensionArg.safeParse(ext).success).toBe(true);
    }
  });

  test('rejects unsupported extensions', () => {
    for (const bad of ['.markdown', '.txt', 'mdx', '.MDX', '']) {
      expect(DocExtensionArg.safeParse(bad).success).toBe(false);
    }
  });

  test('enum is single-sourced from SUPPORTED_DOC_EXTENSIONS (no drift)', () => {
    // The wire enum must equal the canonical list the engine writes from, so
    // adding/removing a supported extension can never leave the MCP field stale.
    expect(DocExtensionArg.options).toEqual([...SUPPORTED_DOC_EXTENSIONS]);
  });

  test('description names .mdx + default and is part of the agent-facing wire contract', () => {
    const description = DocExtensionArg.description ?? '';
    expect(description).toContain('.mdx');
    expect(description).toContain('default');
  });
});

describe('resolveSkillFilePath — bundle-file path allowlist', () => {
  test('accepts references/** and scripts/** with a leaf, reporting kind', () => {
    const ref = resolveSkillFilePath('references/tiers.md');
    expect(ref.ok).toBe(true);
    if (ref.ok) {
      expect(ref.path).toBe('references/tiers.md');
      expect(ref.kind).toBe('reference');
    }
    const script = resolveSkillFilePath('scripts/run.sh');
    expect(script.ok).toBe(true);
    if (script.ok) expect(script.kind).toBe('script');
    // Nested one level deeper still resolves (kind from the top segment).
    const nested = resolveSkillFilePath('references/topic/deep.md');
    expect(nested.ok).toBe(true);
    if (nested.ok) expect(nested.kind).toBe('reference');
  });

  test('rejects `..` traversal, absolute paths, and other top-level dirs', () => {
    for (const bad of [
      'references/../../etc/passwd',
      '../escape.md',
      'references/../scripts/../../x',
      '/abs/path.md',
      'C:\\windows\\system32',
      'SKILL.md',
      'notes/x.md',
      'assets/img.png',
    ]) {
      expect(resolveSkillFilePath(bad).ok).toBe(false);
    }
  });

  test('rejects a bare allowed root with no leaf, empty, and NUL', () => {
    expect(resolveSkillFilePath('references').ok).toBe(false);
    expect(resolveSkillFilePath('scripts/').ok).toBe(false);
    expect(resolveSkillFilePath('').ok).toBe(false);
    expect(resolveSkillFilePath('references/a\x00b.md').ok).toBe(false);
  });

  test('normalizes `./` and backslash separators', () => {
    const a = resolveSkillFilePath('./references/x.md');
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.path).toBe('references/x.md');
    const b = resolveSkillFilePath('scripts\\run.sh');
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.path).toBe('scripts/run.sh');
  });
});
