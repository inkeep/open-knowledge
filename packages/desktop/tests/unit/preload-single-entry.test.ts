import { existsSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * A sandboxed preload's `require` is a polyfill over an allowlist of module
 * NAMES (`electron` plus a few node builtins) and cannot resolve a relative
 * path, so every preload bundle must be a single self-contained file.
 *
 * That makes the preload build's entry count load-bearing. A second entry makes
 * rolldown hoist whatever the two share into `chunks/`, and rolldown offers no
 * per-entry inlining knob (`codeSplitting: false` is rejected outright for
 * multi-input builds) — so BOTH preloads then die on the relative `require`,
 * `window.okDesktop` goes undefined, and the editor falls into web mode with no
 * build error to show for it. The self-uninstall window's bridge therefore
 * ships inside the one entry and is selected at exposure time.
 *
 * The smoke (`tests/smoke/uninstall-ipc-bridge.e2e.ts`) catches the same
 * regression at full fidelity but is opt-in and needs a build; this is the
 * always-on tripwire.
 */

const desktopRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));

interface PreloadBuild {
  rollupOptions?: { input?: Record<string, string> };
}

async function preloadInput(): Promise<Record<string, string>> {
  const config: { preload?: { build?: PreloadBuild } } = (
    await import('../../electron.vite.config')
  ).default;
  const input = config.preload?.build?.rollupOptions?.input;
  if (input === undefined) throw new Error('preload build declares no entry input');
  return input;
}

describe('preload bundle self-containment', () => {
  test('the preload build declares exactly one entry', async () => {
    expect(Object.keys(await preloadInput())).toEqual(['index']);
  });

  test('the built preload requires only specifiers the sandbox can resolve', () => {
    const built = resolve(desktopRoot, 'out', 'preload', 'index.js');
    if (!existsSync(built)) {
      // Unbuilt tree — the entry-count assertion above still guards the cause.
      return;
    }
    const requires = [...readFileSync(built, 'utf-8').matchAll(/require\(["']([^"']+)["']\)/g)].map(
      (match) => match[1],
    );
    expect(requires.length).toBeGreaterThan(0);
    // A bare workspace specifier is as fatal as a relative path and less
    // obvious: `import { X } from '@inkeep/open-knowledge-core'` looks
    // identical to the type-only imports beside it, but a VALUE import emits a
    // runtime `require()` the sandbox allowlist does not carry. The throw
    // precedes `exposeInMainWorld`, so the symptom is the whole bridge missing
    // rather than one broken field. Allowlist the resolvable names instead of
    // only rejecting `./`.
    expect(
      requires.filter(
        (specifier) => specifier !== undefined && specifier !== 'electron' && !isBuiltin(specifier),
      ),
    ).toEqual([]);
  });
});
