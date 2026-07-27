import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { RENDERER_HTML_ENTRIES } from '../../../app/vite.entries';

/**
 * The renderer ships from two builds with different consumers: `packages/app`'s
 * own `vite build` produces what a PACKAGED window loads (`dist/` → the CLI's
 * `dist/public/` → `<Resources>/app/`), while `packages/desktop`'s
 * `electron-vite build` produces the unpackaged-dev fallback at
 * `out/renderer/`. An entry declared in only one of them works in dev and 404s
 * in the shipped app, so the entry set is asserted to match across both.
 */
const appRoot = resolve(fileURLToPath(new URL('../../../app/', import.meta.url)));

type EntryInput = Record<string, string>;

/**
 * Both spellings are read because the two configs are mid-migration: Vite 8
 * renamed `rollupOptions` to `rolldownOptions` and the app config has moved
 * while the electron-vite one has not. Reading either keeps this assertion
 * alive across that rename instead of silently going vacuous.
 */
interface RendererBuild {
  rollupOptions?: { input?: EntryInput };
  rolldownOptions?: { input?: EntryInput };
}

function entryInput(build: RendererBuild | undefined): EntryInput {
  const input = build?.rolldownOptions?.input ?? build?.rollupOptions?.input;
  if (input === undefined) throw new Error('renderer build declares no HTML entry input');
  return input;
}

async function appBuildInput(): Promise<EntryInput> {
  const config: { build?: RendererBuild } = (await import('../../../app/vite.config')).default;
  return entryInput(config.build);
}

async function electronRendererInput(): Promise<EntryInput> {
  const config: { renderer?: { build?: RendererBuild } } = (
    await import('../../electron.vite.config')
  ).default;
  return entryInput(config.renderer?.build);
}

describe('renderer HTML entries', () => {
  test('the uninstall window is a build entry, not an inline document', async () => {
    expect(Object.keys(await appBuildInput())).toContain('uninstall');
    expect(Object.keys(await electronRendererInput())).toContain('uninstall');
  });

  test('both renderer builds declare the same entry set', async () => {
    const expected = Object.fromEntries(
      Object.entries(RENDERER_HTML_ENTRIES).map(([name, file]) => [name, resolve(appRoot, file)]),
    );

    expect(await appBuildInput()).toEqual(expected);
    expect(await electronRendererInput()).toEqual(expected);
  });

  test('every declared entry is a flat sibling at the app root', async () => {
    // Vite emits shared chunks to `<outDir>/assets/`, and each entry HTML gets
    // relative `./assets/…` URLs. Nesting one entry a directory deeper would
    // silently break its asset resolution under `file://`.
    for (const [name, entryPath] of Object.entries(await appBuildInput())) {
      expect(dirname(entryPath), `${name} entry must sit at the app root`).toBe(appRoot);
      expect(existsSync(entryPath), `${name} entry is missing on disk`).toBe(true);
    }
  });
});
