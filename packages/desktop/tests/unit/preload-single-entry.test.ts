import { existsSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

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
      return;
    }
    const requires = [...readFileSync(built, 'utf-8').matchAll(/require\(["']([^"']+)["']\)/g)].map(
      (match) => match[1],
    );
    expect(requires.length).toBeGreaterThan(0);
    expect(
      requires.filter(
        (specifier) => specifier !== undefined && specifier !== 'electron' && !isBuiltin(specifier),
      ),
    ).toEqual([]);
  });
});
