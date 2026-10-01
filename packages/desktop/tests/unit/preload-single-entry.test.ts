import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PreloadConfigFactory, type PreloadViteConfig } from 'electron-vite';
import { build } from 'vite';
import { describe, expect, test } from 'vitest';

const desktopRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/* UPSTREAM(electron@44.5.1): a sandboxed preload's require resolves only the module names that
   lib/sandboxed_renderer/init.ts maps, and lib/sandboxed_renderer/preload.ts throws
   "module not found" for any other name, Node builtins such as fs included. */
const SANDBOXED_PRELOAD_MODULES = new Set([
  'electron',
  'electron/common',
  'electron/renderer',
  'events',
  'node:events',
  'timers',
  'node:timers',
  'url',
  'node:url',
]);

function requiredModules(source: string): string[] {
  return [...source.matchAll(/require\(["']([^"']+)["']\)/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

function unresolvableInSandbox(source: string): string[] {
  return requiredModules(source).filter((name) => !SANDBOXED_PRELOAD_MODULES.has(name));
}

async function preloadConfig(): Promise<PreloadViteConfig> {
  const config: { preload?: PreloadViteConfig } = (await import('../../electron.vite.config'))
    .default;
  if (config.preload === undefined) throw new Error('electron.vite.config declares no preload');
  return config.preload;
}

async function buildPreloadForProduction(): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), 'ok-preload-bundle-'));
  const environment = { ...process.env };
  process.env.NODE_ENV = 'production';
  process.env.NODE_ENV_ELECTRON_VITE = 'production';
  try {
    const preload = await new PreloadConfigFactory(
      await preloadConfig(),
      { configFile: false, logLevel: 'warn', mode: 'production' },
      { root: desktopRoot },
    ).build();
    await build({ ...preload, build: { ...preload.build, outDir, emptyOutDir: true } });
    return readFileSync(join(outDir, 'index.js'), 'utf-8');
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in environment)) delete process.env[key];
    }
    Object.assign(process.env, environment);
    rmSync(outDir, { recursive: true, force: true });
  }
}

describe('preload bundle self-containment', () => {
  test('the preload build declares exactly one entry', async () => {
    const input = (await preloadConfig()).build?.rolldownOptions?.input;
    if (input === undefined) throw new Error('preload build declares no entry input');
    expect(Object.keys(input)).toEqual(['index']);
  });

  test("the sandbox's module map admits Electron's names and refuses the rest", () => {
    expect(
      unresolvableInSandbox(
        'require("electron/renderer"); require("node:events"); require("timers"); require("url");',
      ),
    ).toEqual([]);
    expect(
      unresolvableInSandbox(
        'require("node:fs"); require("fs"); require("./chunks/shared.js"); require("@inkeep/open-knowledge-core");',
      ),
    ).toEqual(['node:fs', 'fs', './chunks/shared.js', '@inkeep/open-knowledge-core']);
  });

  test('the production preload bundle requires only modules the sandbox resolves', async () => {
    const nodeEnv = process.env.NODE_ENV;
    const bundle = await buildPreloadForProduction();
    expect(process.env.NODE_ENV).toBe(nodeEnv);
    expect(requiredModules(bundle)).toContain('electron');
    expect(unresolvableInSandbox(bundle)).toEqual([]);
  });
});
