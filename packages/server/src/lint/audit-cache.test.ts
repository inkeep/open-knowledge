/**
 * Behavioral tests for the audit result cache: key composition (every input a
 * doc's diagnostics derive from), entry isolation from caller mutation, and
 * LRU eviction under both the entry and byte bounds.
 */

import type { LintDiagnostic, LinterConfig } from '@inkeep/open-knowledge-core';
import { DEFAULT_LINTER_CONFIG } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { AuditCache } from './audit-cache.ts';

function diagnostic(code: string): LintDiagnostic {
  return {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    severity: 'warning',
    source: 'markdownlint',
    code,
    message: `${code} fired`,
  };
}

const BASE_KEY = {
  contentDir: '/kb',
  docRelPath: 'notes/a.md',
  mtimeMs: 1_700_000_000_000,
  size: 512,
  configFingerprint: 'fp-1',
};

function withMarkdownlint(rules: Record<string, unknown>): LinterConfig {
  const config = structuredClone(DEFAULT_LINTER_CONFIG);
  config.plugins.markdownlint.enabled = true;
  config.plugins.markdownlint.rules = rules as LinterConfig['plugins']['markdownlint']['rules'];
  return config;
}

describe('AuditCache.fingerprintConfig', () => {
  test('is stable for equal configs and differs when a rule changes', () => {
    const a = AuditCache.fingerprintConfig(withMarkdownlint({ MD013: true }));
    const b = AuditCache.fingerprintConfig(withMarkdownlint({ MD013: true }));
    const toggledOff = AuditCache.fingerprintConfig(withMarkdownlint({ MD013: false }));
    expect(a).toBe(b);
    expect(toggledOff).not.toBe(a);
  });

  test('differs when a rule OPTION changes, not just its enablement', () => {
    const at80 = AuditCache.fingerprintConfig(withMarkdownlint({ MD013: { line_length: 80 } }));
    const at120 = AuditCache.fingerprintConfig(withMarkdownlint({ MD013: { line_length: 120 } }));
    expect(at120).not.toBe(at80);
  });

  test('differs when a plugin is enabled', () => {
    const off = AuditCache.fingerprintConfig(DEFAULT_LINTER_CONFIG);
    const on = AuditCache.fingerprintConfig(withMarkdownlint({}));
    expect(on).not.toBe(off);
  });
});

describe('AuditCache.key', () => {
  test('every component participates — changing any one yields a fresh key', () => {
    const base = AuditCache.key(BASE_KEY);
    const variants = [
      { ...BASE_KEY, contentDir: '/other-kb' },
      { ...BASE_KEY, docRelPath: 'notes/b.md' },
      { ...BASE_KEY, mtimeMs: BASE_KEY.mtimeMs + 1 },
      { ...BASE_KEY, size: BASE_KEY.size + 1 },
      { ...BASE_KEY, configFingerprint: 'fp-2' },
    ];
    for (const variant of variants) {
      expect(AuditCache.key(variant)).not.toBe(base);
    }
    expect(AuditCache.key({ ...BASE_KEY })).toBe(base);
  });
});

describe('AuditCache', () => {
  test('a miss reports null and a stored entry reads back', () => {
    const cache = new AuditCache();
    const key = AuditCache.key(BASE_KEY);
    expect(cache.get(key)).toBeNull();
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 1, entries: 0 });

    cache.set(key, [diagnostic('MD010')]);
    expect(cache.get(key)).toEqual([diagnostic('MD010')]);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, entries: 1 });
  });

  test('a caller mutating what it received cannot corrupt the entry', () => {
    const cache = new AuditCache();
    const key = AuditCache.key(BASE_KEY);
    cache.set(key, [diagnostic('MD010'), diagnostic('MD012')]);

    const first = cache.get(key);
    expect(first).not.toBeNull();
    // The audit merges and sorts the array it gets back, in place.
    first?.splice(0, 1);
    first?.push(diagnostic('INJECTED'));

    expect(cache.get(key)).toEqual([diagnostic('MD010'), diagnostic('MD012')]);
  });

  test('re-setting a key replaces rather than double-counting its bytes', () => {
    const cache = new AuditCache();
    const key = AuditCache.key(BASE_KEY);
    cache.set(key, [diagnostic('MD010')]);
    const afterFirst = cache.stats().bytes;
    cache.set(key, [diagnostic('MD010')]);
    expect(cache.stats()).toMatchObject({ entries: 1, bytes: afterFirst });
  });

  test('evicts least-recently-used first once the entry bound is exceeded', () => {
    const cache = new AuditCache({ maxEntries: 2 });
    const keyFor = (doc: string) => AuditCache.key({ ...BASE_KEY, docRelPath: doc });
    cache.set(keyFor('a.md'), [diagnostic('A')]);
    cache.set(keyFor('b.md'), [diagnostic('B')]);
    // Touch `a` so `b` becomes the least recently used.
    expect(cache.get(keyFor('a.md'))).not.toBeNull();
    cache.set(keyFor('c.md'), [diagnostic('C')]);

    expect(cache.stats().entries).toBe(2);
    expect(cache.get(keyFor('b.md'))).toBeNull();
    expect(cache.get(keyFor('a.md'))).not.toBeNull();
    expect(cache.get(keyFor('c.md'))).not.toBeNull();
  });

  test('evicts under the byte bound even when the entry count is small', () => {
    // One diagnostic already exceeds this, so every insert forces eviction.
    const cache = new AuditCache({ maxBytes: 40 });
    const keyFor = (doc: string) => AuditCache.key({ ...BASE_KEY, docRelPath: doc });
    cache.set(keyFor('a.md'), [diagnostic('A')]);
    cache.set(keyFor('b.md'), [diagnostic('B')]);

    // The bound is honored down to a floor of one entry — the most recent
    // insert is always retained, so a single oversized doc still caches.
    expect(cache.stats().entries).toBe(1);
    expect(cache.get(keyFor('b.md'))).not.toBeNull();
    expect(cache.get(keyFor('a.md'))).toBeNull();
  });

  test('clear drops entries and counters', () => {
    const cache = new AuditCache();
    cache.set(AuditCache.key(BASE_KEY), [diagnostic('MD010')]);
    cache.clear();
    expect(cache.stats()).toEqual({ hits: 0, misses: 0, entries: 0, bytes: 0 });
  });
});
