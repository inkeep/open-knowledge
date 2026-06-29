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
    expect(slugifyTabId('Web app  (Linux)')).toBe('web-app-linux');
  });

  test('drops middle-dot and other Unicode separators (PRD-7162 trigger label)', () => {
    expect(slugifyTabId('Web app (Linux · Intel Mac)')).toBe('web-app-linux-intel-mac');
  });

  test('strips combining diacritics via NFKD decomposition (café → cafe)', () => {
    expect(slugifyTabId('Café')).toBe('cafe');
  });

  test('trims leading and trailing dashes', () => {
    expect(slugifyTabId('  hello  ')).toBe('hello');
    expect(slugifyTabId('!!?weird??!!')).toBe('weird');
  });

  test('returns empty string for all-non-alphanumeric input', () => {
    expect(slugifyTabId('!!!')).toBe('');
    expect(slugifyTabId('···')).toBe('');
    expect(slugifyTabId('')).toBe('');
  });

  test('preserves digits and mixes them with letters', () => {
    expect(slugifyTabId('v1.2.3 release')).toBe('v1-2-3-release');
  });

  test('idempotent — slugify(slugify(x)) === slugify(x)', () => {
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
    expect(composeTabId('macOS app', 'My Install')).toBe('my-install-macos-app');
  });

  test('label missing or unslugable → null (caller falls back to positional id)', () => {
    expect(composeTabId(undefined, 'ok-install')).toBeNull();
    expect(composeTabId('', 'ok-install')).toBeNull();
    expect(composeTabId('   ', 'ok-install')).toBeNull();
    expect(composeTabId('!!!', 'ok-install')).toBeNull();
  });

  test('groupId that slugs to empty falls back to bare label (not "-label")', () => {
    expect(composeTabId('macOS app', '!!!')).toBe('macos-app');
  });

  test('idempotent — composeTabId(composeTabId(label), groupId) preserves the result when re-fed', () => {
    const composed = composeTabId('macOS app', 'ok-install');
    expect(composed).toBe('ok-install-macos-app');
    expect(slugifyTabId(composed ?? '')).toBe(composed);
  });
});
