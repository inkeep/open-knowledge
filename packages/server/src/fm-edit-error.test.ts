import type { FmEditError } from '@inkeep/open-knowledge-core';
import { describe, expect, it } from 'vitest';
import { describeFmEditError } from './fm-edit-error.ts';

const CASES: ReadonlyArray<{ label: string; error: FmEditError; expected: string }> = [
  {
    label: 'invalid_value names the key and the reason',
    error: { kind: 'invalid_value', key: 'allowed-tools', reason: 'expected a list of strings' },
    expected: 'invalid_value (allowed-tools: expected a list of strings)',
  },
  {
    label: 'reserved_key quotes the key',
    error: { kind: 'reserved_key', key: 'name' },
    expected: "reserved_key ('name' is reserved)",
  },
  {
    label: 'unknown_key quotes the key',
    error: { kind: 'unknown_key', key: 'colour' },
    expected: "unknown_key ('colour' is not a recognized key)",
  },
  {
    label: 'duplicate_target quotes the key',
    error: { kind: 'duplicate_target', key: 'description' },
    expected: "duplicate_target ('description' appears more than once)",
  },
  {
    label: 'reorder_mismatch renders expected before got, in order',
    error: { kind: 'reorder_mismatch', expected: ['name', 'description'], got: ['description'] },
    expected: 'reorder_mismatch (expected: name, description; got: description)',
  },
  {
    label: 'region_too_large carries the measured bytes and the limit',
    error: { kind: 'region_too_large', bytes: 70_144, limit: 65_536 },
    expected: 'region_too_large (frontmatter region too large: 70144 > 65536 bytes)',
  },
  {
    label: 'parse_failed carries the parser reason',
    error: { kind: 'parse_failed', reason: 'unexpected end of stream' },
    expected: 'parse_failed (frontmatter region unparseable: unexpected end of stream)',
  },
  {
    label: 'invalid_path joins a populated path with dots',
    error: { kind: 'invalid_path', path: ['metadata', 0, 'id'], reason: 'not a string' },
    expected: 'invalid_path (metadata.0.id: not a string)',
  },
  {
    label: 'invalid_path renders an empty path as __path__',
    error: { kind: 'invalid_path', path: [], reason: 'not an object' },
    expected: 'invalid_path (__path__: not an object)',
  },
];

describe('describeFmEditError', () => {
  for (const { label, error, expected } of CASES) {
    it(label, () => {
      expect(describeFmEditError(error)).toBe(expected);
    });
  }

  it('renders every variant distinctly so a collapsed mapper cannot pass', () => {
    const rendered = CASES.map((entry) => describeFmEditError(entry.error));
    expect(new Set(rendered).size).toBe(CASES.length);
  });

  it('leads every message with the variant kind', () => {
    for (const { error } of CASES) {
      expect(describeFmEditError(error).startsWith(`${error.kind} (`)).toBe(true);
    }
  });
});
