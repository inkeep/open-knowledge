import { describe, expect, test } from 'vitest';
import { claudeCandidates, codexCandidates, revalidateFreshness } from './candidates.ts';
import type { ScopeFingerprint } from './types.ts';

const scope: ScopeFingerprint = {
  harness: 'test',
  cliVersion: '1.0.0',
  adapterVersion: '2.0.0',
  endpoint: null,
  account: null,
};

describe('Claude rows', () => {
  const rows = claudeCandidates(
    [
      { value: 'claude-opus-4-8', label: 'Opus 4.8' },
      { value: 'claude-opus-4-8[1m]', label: 'Opus 4.8 (1M)' },
      { value: 'claude-sonnet-5', label: 'Sonnet 5' },
    ],
    scope,
  );

  test('variants of one model share a group', () => {
    const opus = rows.filter((r) => r.group === 'claude-opus-4-8');
    expect(opus.map((r) => r.value)).toEqual(['claude-opus-4-8', 'claude-opus-4-8[1m]']);
  });

  test('a tagged variant carries the window its id encodes', () => {
    const long = rows.find((r) => r.value === 'claude-opus-4-8[1m]');
    expect(long?.context).toEqual({ effectiveTokens: 1_000_000, origin: 'model-variant' });
  });

  test('an untagged variant claims no window rather than inventing one', () => {
    expect(rows.find((r) => r.value === 'claude-opus-4-8')?.context).toBeNull();
  });

  test('every Claude row is applied after the session exists', () => {
    expect(rows.every((r) => r.setPhase === 'acp-post-create')).toBe(true);
  });

  test('advertised rows are marked advertised and live', () => {
    expect(rows.every((r) => r.selectability === 'advertised')).toBe(true);
    expect(rows.every((r) => r.freshness.kind === 'live')).toBe(true);
  });
});

describe('Codex rows', () => {
  const rows = codexCandidates(
    [
      {
        slug: 'gpt-5.6-sol',
        contextWindow: 256_000,
        maxContextWindow: 872_000,
        effectivePercent: 95,
      },
      { slug: 'gpt-5.5', contextWindow: 272_000, maxContextWindow: 272_000, effectivePercent: 95 },
    ],
    scope,
    1_700_000_000_000,
  );

  test('a model with headroom offers both its default and its ceiling', () => {
    expect(rows[0]?.contextChoices).toEqual([256_000, 872_000]);
  });

  test('the shown window is what the ceiling actually grants', () => {
    expect(rows[0]?.context).toEqual({ effectiveTokens: 828_400, origin: 'native-catalog' });
  });

  test('a model with one size offers exactly that', () => {
    expect(rows[1]?.contextChoices).toEqual([272_000]);
    expect(rows[1]?.context?.effectiveTokens).toBe(258_400);
  });

  test('every Codex row is a launch-time choice, not an ACP call', () => {
    expect(rows.every((r) => r.setPhase === 'launch-only')).toBe(true);
  });

  test('catalog rows are candidates, never advertised, and carry their age', () => {
    expect(rows.every((r) => r.selectability === 'candidate')).toBe(true);
    expect(rows[0]?.freshness).toEqual({ kind: 'cached', at: 1_700_000_000_000 });
  });
});

describe('a cached row whose environment changed underneath it', () => {
  const cached = codexCandidates(
    [
      {
        slug: 'gpt-5.6-sol',
        contextWindow: 256_000,
        maxContextWindow: 872_000,
        effectivePercent: 95,
      },
    ],
    scope,
    1_700_000_000_000,
  );

  test('a matching environment leaves the row exactly as it was', () => {
    expect(revalidateFreshness(cached, scope)).toEqual(cached);
  });

  test('a different CLI version marks the row stale, keeping when it was captured', () => {
    const moved = revalidateFreshness(cached, { ...scope, cliVersion: '1.1.0' });
    expect(moved[0]?.freshness).toEqual({ kind: 'stale', at: 1_700_000_000_000 });
  });

  test('a different account marks it stale too', () => {
    const moved = revalidateFreshness(cached, { ...scope, account: 'someone-else' });
    expect(moved[0]?.freshness.kind).toBe('stale');
  });

  test('a stale row is never advertised as selectable', () => {
    const live = claudeCandidates([{ value: 'claude-opus-4-8[1m]' }], scope);
    expect(live[0]?.selectability).toBe('advertised');
    const moved = revalidateFreshness(live, { ...scope, adapterVersion: '3.0.0' });
    expect(moved[0]?.selectability).toBe('candidate');
  });
});

describe('catalog rows the CLI marks hidden', () => {
  const withHidden = codexCandidates(
    [
      {
        slug: 'gpt-5.6-sol',
        visibility: 'list',
        contextWindow: 272_000,
        maxContextWindow: 872_000,
        effectivePercent: 95,
      },
      {
        slug: 'gpt-reserve',
        visibility: 'hide',
        contextWindow: 272_000,
        maxContextWindow: 872_000,
        effectivePercent: 95,
      },
      {
        slug: 'codex-auto-review',
        visibility: 'hide',
        contextWindow: 272_000,
        maxContextWindow: 872_000,
        effectivePercent: 95,
      },
    ],
    scope,
    1,
  );

  test('a hidden row is never offered as a choice', () => {
    expect(withHidden.map((c) => c.value)).toEqual(['gpt-5.6-sol']);
  });

  test('a row with no visibility field is treated as listed', () => {
    const rows = codexCandidates(
      [{ slug: 'x', contextWindow: 100, maxContextWindow: 100, effectivePercent: 95 }],
      scope,
      1,
    );
    expect(rows).toHaveLength(1);
  });
});
