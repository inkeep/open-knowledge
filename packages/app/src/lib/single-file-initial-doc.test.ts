import { afterEach, describe, expect, test } from 'bun:test';
import { seedInitialDocHash, seedInitialDocHashFromWindow } from './single-file-initial-doc';

/**
 * Unit coverage for the ephemeral single-file hash seed — the deterministic
 * replacement for the dropped `ok:deep-link` IPC. Drives the pure (config,
 * hash-getter, hash-setter) seam so the "config → hash" half of the cold-start
 * chain is asserted without a browser. The "hash → editor renders doc" half is
 * the existing single-file e2e's job (it navigates to `#/<doc>` and asserts the
 * doc renders); composed, they cover config-injection → seed → NavigationHandler.
 */
describe('seedInitialDocHash', () => {
  function harness(initialDoc: string | null | undefined, startHash: string) {
    let hash = startHash;
    const sets: string[] = [];
    seedInitialDocHash({
      initialDoc,
      getHash: () => hash,
      setHash: (h) => {
        hash = h;
        sets.push(h);
      },
    });
    return { hash, sets };
  }

  test('seeds #/<doc> when the hash is empty', () => {
    const { hash, sets } = harness('todo', '');
    expect(hash).toBe('#/todo');
    expect(sets).toEqual(['#/todo']);
  });

  test('seeds over the bare `#` and content-root `#/` base states', () => {
    expect(harness('todo', '#').hash).toBe('#/todo');
    expect(harness('todo', '#/').hash).toBe('#/todo');
  });

  test('preserves a docName with a space (browser percent-encodes on assignment)', () => {
    // `hashFromDocName` writes the raw name; the browser encodes it and
    // `docNameFromHash` decodes per-segment, so the round-trip holds.
    expect(harness('My Notes', '').hash).toBe('#/My Notes');
  });

  test('no-op when initialDoc is null (every non-ephemeral window)', () => {
    expect(harness(null, '').sets).toEqual([]);
  });

  test('no-op when initialDoc is undefined (absent bridge field)', () => {
    expect(harness(undefined, '').sets).toEqual([]);
  });

  test('does not clobber a hash that already carries a doc target', () => {
    const { hash, sets } = harness('todo', '#/other-doc');
    expect(hash).toBe('#/other-doc');
    expect(sets).toEqual([]);
  });

  test('does not clobber an asset or dialog hash', () => {
    expect(harness('todo', '#/__asset__/img.png').sets).toEqual([]);
    expect(harness('todo', '#settings').sets).toEqual([]);
  });
});

/**
 * The `main.tsx` startup wrapper: read the desktop bridge's
 * `config.initialDoc` and seed the LIVE `window.location.hash`. It reads only
 * `window.okDesktop` + `window.location.hash`, so a plain object stub stands in
 * for the DOM — no jsdom needed. This is the seam the splash bug slipped through
 * (the e2e navigates straight to `#/<doc>` and never exercises config → seed).
 */
describe('seedInitialDocHashFromWindow', () => {
  const original = (globalThis as { window?: unknown }).window;
  afterEach(() => {
    (globalThis as { window?: unknown }).window = original;
  });

  function seedWith(okDesktop: unknown, startHash = ''): string {
    const location = { hash: startHash };
    (globalThis as { window?: unknown }).window = { okDesktop, location };
    seedInitialDocHashFromWindow();
    return location.hash;
  }

  test('seeds the live hash from an ephemeral bridge config', () => {
    expect(seedWith({ config: { initialDoc: 'todo' } })).toBe('#/todo');
  });

  test('no-op when the bridge reports no initialDoc (a normal project window)', () => {
    expect(seedWith({ config: { initialDoc: null } })).toBe('');
  });

  test('no-op when there is no desktop bridge (web/CLI)', () => {
    expect(seedWith(undefined)).toBe('');
  });
});
