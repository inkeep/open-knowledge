/**
 * Unit tests for the URL-hash contract the docs Tabs deep-link feature
 * emits — `slugifyTabId` (the per-segment rule) and `composeTabId` (the
 * groupId-prefix composition).
 *
 * A regression in either renames every existing inbound link (someone
 * pasted a docs URL into Slack with `#macos-app`; if the slug rule starts
 * producing `#macos_app`, OR the composition drops the `groupId` prefix and
 * starts emitting bare `#macos-app` for a `groupId="ok-install"` block, the
 * recipient's tab fails to activate). Pin every observable rule with a
 * name that explains why it's load-bearing.
 */

import { describe, expect, test } from 'bun:test';
import { composeTabId, slugifyTabId } from './tabs.tsx';

describe('slugifyTabId', () => {
  test('lowercases ASCII letters', () => {
    expect(slugifyTabId('MacOS')).toBe('macos');
  });

  test('replaces a single space with a dash', () => {
    expect(slugifyTabId('macOS app')).toBe('macos-app');
  });

  test('collapses runs of non-alphanumeric chars into a single dash', () => {
    // Two spaces, mixed punctuation, parens — every run flattens to one
    // dash so the slug stays readable instead of accumulating `--`s.
    expect(slugifyTabId('Web app  (Linux)')).toBe('web-app-linux');
  });

  test('drops middle-dot and other Unicode separators (PRD-7162 trigger label)', () => {
    // The slug rule's Unicode-separator case (a middle-dot label): `'Web app (Linux · Intel Mac)'`
    // — the middle-dot (U+00B7) is the canonical shape this slug rule
    // ships against. If this expectation changes, every existing /
    // future link to `#web-app-linux-intel-mac` breaks.
    expect(slugifyTabId('Web app (Linux · Intel Mac)')).toBe('web-app-linux-intel-mac');
  });

  test('strips combining diacritics via NFKD decomposition (café → cafe)', () => {
    // The é is U+00E9 → NFKD decomposes to U+0065 U+0301; the combining
    // mark (U+0301) lives in [̀-ͯ] and gets stripped, leaving plain `e`.
    expect(slugifyTabId('Café')).toBe('cafe');
  });

  test('trims leading and trailing dashes', () => {
    expect(slugifyTabId('  hello  ')).toBe('hello');
    expect(slugifyTabId('!!?weird??!!')).toBe('weird');
  });

  test('returns empty string for all-non-alphanumeric input', () => {
    // The wrapper falls back to `tab-${n}` when this happens, so the URL
    // never contains a bare `#`. The empty return value is the signal.
    expect(slugifyTabId('!!!')).toBe('');
    expect(slugifyTabId('···')).toBe('');
    expect(slugifyTabId('')).toBe('');
  });

  test('preserves digits and mixes them with letters', () => {
    expect(slugifyTabId('v1.2.3 release')).toBe('v1-2-3-release');
  });

  test('idempotent — slugify(slugify(x)) === slugify(x)', () => {
    // Pin idempotence so a future round-trip (e.g. a build step that
    // normalizes URLs in MDX) doesn't drift the slug on the second pass.
    const cases = [
      'macOS app',
      'Web app (Linux · Intel Mac)',
      'Café',
      'v1.2.3 release',
      '  edge case  ',
    ];
    for (const c of cases) {
      const once = slugifyTabId(c);
      expect(slugifyTabId(once)).toBe(once);
    }
  });
});

describe('composeTabId (groupId-prefix URL composition)', () => {
  test('groupId + label → prefixed slug (the docs quickstart shape)', () => {
    // The literal URL the docs quickstart emits today. If this expectation
    // changes, every Slack-pasted `#ok-install-macos-app` link breaks.
    expect(composeTabId('macOS app', 'ok-install')).toBe('ok-install-macos-app');
    expect(composeTabId('Web app (Linux, Windows, Intel Mac)', 'ok-install')).toBe(
      'ok-install-web-app-linux-windows-intel-mac',
    );
  });

  test('no groupId → bare label slug (no leading dash, no prefix)', () => {
    expect(composeTabId('macOS app', undefined)).toBe('macos-app');
    expect(composeTabId('macOS app', '')).toBe('macos-app');
  });

  test('groupId itself is slugified before prefixing', () => {
    // `My Install` (with space) must become `my-install`, then prefix —
    // otherwise the URL would contain a raw space + uppercase letter.
    expect(composeTabId('macOS app', 'My Install')).toBe('my-install-macos-app');
  });

  test('label missing or unslugable → null (caller falls back to positional id)', () => {
    // The wrapper's positional fallback (`tab-${index+1}`) depends on this
    // signal. A non-null return value here that happens to be an empty
    // string (e.g. `''` from a future bug) would result in `#`-only URLs.
    expect(composeTabId(undefined, 'ok-install')).toBeNull();
    expect(composeTabId('', 'ok-install')).toBeNull();
    expect(composeTabId('   ', 'ok-install')).toBeNull();
    expect(composeTabId('!!!', 'ok-install')).toBeNull();
  });

  test('groupId that slugs to empty falls back to bare label (not "-label")', () => {
    // `'!!!'` slugifies to `''`; the composition treats that as no-prefix
    // and emits the bare label slug, NOT a leading-dash artifact.
    expect(composeTabId('macOS app', '!!!')).toBe('macos-app');
  });

  test('idempotent — composeTabId(composeTabId(label), groupId) preserves the result when re-fed', () => {
    // Pin idempotence so an unintended round-trip on URLs (e.g. a build
    // step that re-derives ids from MDX) doesn't drift the hash. Feeding
    // the composed slug back through `slugifyTabId` should be a no-op.
    const composed = composeTabId('macOS app', 'ok-install');
    expect(composed).toBe('ok-install-macos-app');
    expect(slugifyTabId(composed ?? '')).toBe(composed);
  });
});
