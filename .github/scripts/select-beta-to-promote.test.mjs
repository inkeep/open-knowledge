import { describe, expect, test } from 'vitest';
import { parseBetaTags, selectPromotion } from './select-beta-to-promote.mjs';

// Fixed clock so tests never call Date.now().
const NOW = Date.parse('2026-07-08T20:00:00Z');
const SOAK = 86400; // 24h
const SOAKED = '2026-07-07T14:00:00Z'; // 30h before NOW
const FRESH = '2026-07-08T17:00:00Z'; // 3h before NOW

function meta({ isDraft = false, publishedAt = SOAKED, dmg = true, manifest = true } = {}) {
  const assets = [];
  if (dmg) assets.push({ name: 'OpenKnowledge-universal.dmg' });
  if (manifest) assets.push({ name: 'beta-mac.yml' });
  return { isDraft, publishedAt, assets };
}

// Build a fetchReleaseMeta from a tag->meta map. Unknown tag === 404 (null);
// the sentinel "THROW" simulates a non-404 infra error.
function fetcher(map) {
  return (tag) => {
    if (!(tag in map)) return null;
    if (map[tag] === 'THROW') throw new Error('simulated non-404 infra error');
    return map[tag];
  };
}

const shippedNone = () => false;
const shippedIn = (...tags) => {
  const set = new Set(tags);
  return (t) => set.has(t);
};

const select = (over) =>
  selectPromotion({ isAlreadyShipped: shippedNone, soakSeconds: SOAK, nowMs: NOW, ...over });

describe('parseBetaTags', () => {
  test('filters to conforming beta tags, preserving order', () => {
    const raw = 'v0.10.0-beta.6\nv0.10.0\nrandomtag\n\nv0.10.0-beta.5\nv0.9.0-beta.12\n';
    expect(parseBetaTags(raw)).toEqual(['v0.10.0-beta.6', 'v0.10.0-beta.5', 'v0.9.0-beta.12']);
  });
  test('empty input yields no tags', () => {
    expect(parseBetaTags('')).toEqual([]);
  });
});

describe('selectPromotion', () => {
  test('reaches back to the latest soaked beta when the head is under-soaked', () => {
    const r = select({
      betaTags: ['v0.10.0-beta.6', 'v0.10.0-beta.5'],
      fetchReleaseMeta: fetcher({
        'v0.10.0-beta.6': meta({ publishedAt: FRESH }),
        'v0.10.0-beta.5': meta({ publishedAt: SOAKED }),
      }),
    });
    expect(r).toEqual({ kind: 'select', target: 'v0.10.0-beta.5', tier: 'soak' });
  });

  test('selects the head when the head itself is soaked', () => {
    const r = select({
      betaTags: ['v0.10.0-beta.6', 'v0.10.0-beta.5'],
      fetchReleaseMeta: fetcher({
        'v0.10.0-beta.6': meta({ publishedAt: SOAKED }),
        'v0.10.0-beta.5': meta({ publishedAt: SOAKED }),
      }),
    });
    expect(r).toEqual({ kind: 'select', target: 'v0.10.0-beta.6', tier: 'soak' });
  });

  test('selects the newest soaked UNSHIPPED beta, even across a version boundary', () => {
    // Catch-up shape: a fresh head, then several soaked betas spanning two X.Y.Z
    // lines, none shipped yet -> pick the newest soaked (promote-stable batches
    // the whole changeset delta over the latest stable into one bump).
    const r = select({
      betaTags: ['v0.31.0-beta.1', 'v0.31.0-beta.0', 'v0.30.1-beta.8'],
      fetchReleaseMeta: fetcher({
        'v0.31.0-beta.1': meta({ publishedAt: FRESH }),
        'v0.31.0-beta.0': meta({ publishedAt: SOAKED }),
        'v0.30.1-beta.8': meta({ publishedAt: SOAKED }),
      }),
    });
    expect(r).toEqual({ kind: 'select', target: 'v0.31.0-beta.0', tier: 'soak' });
  });

  test('stops at the first already-shipped beta and never reaches an older cycle', () => {
    const r = select({
      betaTags: ['v0.10.0-beta.6', 'v0.9.0-beta.3'],
      isAlreadyShipped: shippedIn('v0.10.0-beta.6'), // beta.6 is contained in the latest stable
      fetchReleaseMeta: fetcher({
        'v0.9.0-beta.3': meta({ publishedAt: SOAKED }), // soaked but must NOT be chosen
      }),
    });
    expect(r).toEqual({ kind: 'none' });
  });

  test('skips a draft head and promotes the older soaked beta', () => {
    const r = select({
      betaTags: ['v0.10.0-beta.6', 'v0.10.0-beta.5'],
      fetchReleaseMeta: fetcher({
        'v0.10.0-beta.6': meta({ isDraft: true, publishedAt: SOAKED }),
        'v0.10.0-beta.5': meta({ publishedAt: SOAKED }),
      }),
    });
    expect(r).toEqual({ kind: 'select', target: 'v0.10.0-beta.5', tier: 'soak' });
  });

  test('skips a head missing the DMG asset', () => {
    const r = select({
      betaTags: ['v0.10.0-beta.6', 'v0.10.0-beta.5'],
      fetchReleaseMeta: fetcher({
        'v0.10.0-beta.6': meta({ dmg: false }),
        'v0.10.0-beta.5': meta(),
      }),
    });
    expect(r.target).toBe('v0.10.0-beta.5');
  });

  test('skips a head missing the mac.yml manifest', () => {
    const r = select({
      betaTags: ['v0.10.0-beta.6', 'v0.10.0-beta.5'],
      fetchReleaseMeta: fetcher({
        'v0.10.0-beta.6': meta({ manifest: false }),
        'v0.10.0-beta.5': meta(),
      }),
    });
    expect(r.target).toBe('v0.10.0-beta.5');
  });

  test('treats a 404 (null) as no-release-yet and considers the next-older beta', () => {
    const r = select({
      betaTags: ['v0.10.0-beta.6', 'v0.10.0-beta.5'],
      fetchReleaseMeta: fetcher({
        // beta.6 unknown -> 404 -> null
        'v0.10.0-beta.5': meta(),
      }),
    });
    expect(r.target).toBe('v0.10.0-beta.5');
  });

  test('returns none when nothing is soaked', () => {
    const r = select({
      betaTags: ['v0.10.0-beta.2', 'v0.10.0-beta.1'],
      fetchReleaseMeta: fetcher({
        'v0.10.0-beta.2': meta({ publishedAt: FRESH }),
        'v0.10.0-beta.1': meta({ publishedAt: FRESH }),
      }),
    });
    expect(r).toEqual({ kind: 'none' });
  });

  test('propagates a non-404 infra error instead of skipping the candidate (fail loud)', () => {
    expect(() =>
      select({
        betaTags: ['v0.10.0-beta.6', 'v0.10.0-beta.5'],
        fetchReleaseMeta: fetcher({
          'v0.10.0-beta.6': 'THROW', // auth/network/rate-limit on the newest candidate
          'v0.10.0-beta.5': meta(), // would otherwise be wrongly promoted as latest
        }),
      }),
    ).toThrow(/infra error/);
  });
});

describe('fast tier (FR5a) — DMG-smoke-gated early promotion', () => {
  // Two under-soaked betas over one soaked one. Without the fast tier the
  // evaluator descends past both and picks beta.4; with it, an under-soaked
  // beta can be promoted early, but only on a passing DMG smoke.
  const TAGS = ['v0.10.0-beta.6', 'v0.10.0-beta.5', 'v0.10.0-beta.4'];
  const metas = fetcher({
    'v0.10.0-beta.6': meta({ publishedAt: FRESH }),
    'v0.10.0-beta.5': meta({ publishedAt: FRESH }),
    'v0.10.0-beta.4': meta({ publishedAt: SOAKED }),
  });
  const fastTierOn = () => true;

  function run(over = {}) {
    const logs = [];
    const smokeCalls = [];
    const result = select({
      betaTags: TAGS,
      fetchReleaseMeta: metas,
      log: (m) => logs.push(m),
      ...over,
      smokeBeta: over.smokeBeta
        ? (tag) => {
            smokeCalls.push(tag);
            return over.smokeBeta(tag);
          }
        : undefined,
    });
    return { result, logs, smokeCalls };
  }

  test('is inert by default: same selection as today, and the smoke is never invoked', () => {
    const { result, smokeCalls } = run({ smokeBeta: () => 'pass' });
    // No predicate supplied -> nothing qualifies -> descends to the soaked beta.
    expect(result).toEqual({ kind: 'select', target: 'v0.10.0-beta.4', tier: 'soak' });
    expect(smokeCalls).toEqual([]);
  });

  test('a passing DMG smoke promotes the under-soaked head on the fast tier', () => {
    const { result, smokeCalls } = run({
      qualifiesForFastTier: fastTierOn,
      smokeBeta: () => 'pass',
    });
    expect(result).toEqual({ kind: 'select', target: 'v0.10.0-beta.6', tier: 'fast' });
    expect(smokeCalls).toEqual(['v0.10.0-beta.6']);
  });

  test('a failing DMG smoke refuses the fast tier and leaves the 24h outcome untouched', () => {
    const { result, logs } = run({
      qualifiesForFastTier: fastTierOn,
      smokeBeta: () => 'fail',
    });
    const withoutFastTier = select({ betaTags: TAGS, fetchReleaseMeta: metas });
    expect(result).toEqual(withoutFastTier);
    expect(result).toEqual({ kind: 'select', target: 'v0.10.0-beta.4', tier: 'soak' });
    expect(logs.join('\n')).toContain('failed the smoke subset');
  });

  test('an infrastructure error refuses the fast tier and is distinguishable from a fail', () => {
    const failLogs = run({ qualifiesForFastTier: fastTierOn, smokeBeta: () => 'fail' }).logs;
    const errorLogs = run({ qualifiesForFastTier: fastTierOn, smokeBeta: () => 'error' }).logs;
    expect(errorLogs.join('\n')).toContain('infrastructure error');
    expect(errorLogs.join('\n')).not.toContain('failed the smoke subset');
    expect(failLogs.join('\n')).not.toContain('infrastructure error');
  });

  test('a thrown smoke never fails the job — it degrades to an error refusal', () => {
    // FR5a: the selection gate must never block a release. Unlike
    // fetchReleaseMeta, whose non-404 throws must propagate.
    const { result, logs } = run({
      qualifiesForFastTier: fastTierOn,
      smokeBeta: () => {
        throw new Error('runner exploded');
      },
    });
    expect(result).toEqual({ kind: 'select', target: 'v0.10.0-beta.4', tier: 'soak' });
    expect(logs.join('\n')).toContain('runner exploded');
  });

  test('an unrecognised verdict is treated as an error, never as a pass', () => {
    const { result } = run({ qualifiesForFastTier: fastTierOn, smokeBeta: () => 'probably fine' });
    expect(result.tier).toBe('soak');
  });

  test('the predicate can qualify one beta and not another', () => {
    const { result, smokeCalls } = run({
      qualifiesForFastTier: (tag) => tag === 'v0.10.0-beta.5',
      smokeBeta: () => 'pass',
    });
    expect(result).toEqual({ kind: 'select', target: 'v0.10.0-beta.5', tier: 'fast' });
    expect(smokeCalls).toEqual(['v0.10.0-beta.5']);
  });

  test('the fast tier never reaches back across an already-shipped boundary', () => {
    const { result, smokeCalls } = run({
      isAlreadyShipped: shippedIn('v0.10.0-beta.6'),
      qualifiesForFastTier: fastTierOn,
      smokeBeta: () => 'pass',
    });
    expect(result).toEqual({ kind: 'none' });
    expect(smokeCalls).toEqual([]);
  });
});
