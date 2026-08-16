import { fileURLToPath } from 'node:url';
import { FALLBACK_LOCALE, SUPPORTED_LOCALES } from '@inkeep/open-knowledge-core';
import { build, type Plugin, type RollupOutput } from 'vite';
import { beforeAll, describe, expect, test } from 'vitest';

/**
 * Proves the catalogs are actually code-split in a real build, which no
 * source-level check can: the module reads as twelve dynamic imports either
 * way, and whether the bundler honours that is the only thing standing between
 * a working build and every catalog landing in front of first paint.
 *
 * Builds the two catalog loaders alone rather than the whole app — the question
 * is about the loader map, and a small entry keeps this to a quick build
 * instead of the app's.
 *
 * The same build answers where the pseudolocale went. It is a development
 * instrument behind an `import.meta.env.PROD` check, and whether that check
 * actually keeps its catalog out of a shipped build is a bundler question too,
 * so both modes are built: production must not carry it, development must.
 * Without the development half, an absence measured in production would also be
 * satisfied by a probe that never reached the module at all.
 */

const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../../src', import.meta.url));
const ACTIVATE_LOCALE = fileURLToPath(new URL('../../src/lib/activate-locale.ts', import.meta.url));
const DEV_PSEUDO_LOCALE = fileURLToPath(
  new URL('../../src/lib/dev-pseudo-locale.ts', import.meta.url),
);

const PSEUDO_LOCALE = 'pseudo';

const PROBE_ENTRY = 'virtual:ok-locale-chunk-probe';
const RESOLVED_PROBE_ENTRY = `\0${PROBE_ENTRY}`;

// Vite lets an app build tree-shake unused entry exports, so a bare
// `import`/`re-export` of the module drops the whole loader map and the build
// emits nothing to assert on. Parking the functions on a global keeps them live.
const PROBE_SOURCE = [
  `import { dynamicActivate } from ${JSON.stringify(ACTIVATE_LOCALE)};`,
  `import { activatePseudoLocale } from ${JSON.stringify(DEV_PSEUDO_LOCALE)};`,
  'globalThis.__okLocaleChunkProbe = { dynamicActivate, activatePseudoLocale };',
].join('\n');

const probeEntryPlugin: Plugin = {
  name: 'ok:locale-chunk-probe',
  resolveId(id) {
    return id === PROBE_ENTRY ? RESOLVED_PROBE_ENTRY : null;
  },
  load(id) {
    return id === RESOLVED_PROBE_ENTRY ? PROBE_SOURCE : null;
  },
};

interface CatalogPlacement {
  readonly chunkFileName: string;
  readonly isEntry: boolean;
  /** How many locale catalogs share this chunk. */
  readonly catalogsInChunk: number;
}

/** Maps each locale to the emitted chunk its compiled catalog ended up in. */
function catalogPlacements(output: RollupOutput['output']): Map<string, CatalogPlacement> {
  const placements = new Map<string, CatalogPlacement>();
  for (const item of output) {
    if (item.type !== 'chunk') continue;
    const catalogLocales = (item.moduleIds ?? [])
      .map((id) => /[/\\]locales[/\\]([^/\\]+)[/\\]messages\.json$/.exec(id)?.[1])
      .filter((locale): locale is string => locale !== undefined);
    for (const locale of catalogLocales) {
      placements.set(locale, {
        chunkFileName: item.fileName,
        isEntry: item.isEntry,
        catalogsInChunk: catalogLocales.length,
      });
    }
  }
  return placements;
}

/**
 * Build the probe the way a real `vite build` would.
 *
 * `NODE_ENV` is what settles `import.meta.env.PROD`, not the mode alone — and
 * the test runner pins it to `test`, so a build merely *asked* for production
 * mode still compiles as though it were not one and keeps everything the
 * shipping build drops. Setting it is what makes this a measurement of the
 * shipped output rather than of the runner's environment.
 */
async function buildProbe(
  nodeEnv: 'production' | 'development',
): Promise<Map<string, CatalogPlacement>> {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  try {
    const result = (await build({
      root: APP_ROOT,
      mode: nodeEnv,
      configFile: false,
      logLevel: 'silent',
      plugins: [probeEntryPlugin],
      resolve: { alias: { '@': SRC_DIR } },
      build: { write: false, rolldownOptions: { input: { probe: PROBE_ENTRY } } },
    })) as unknown as RollupOutput;

    return catalogPlacements(result.output);
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
  }
}

// Two real Vite builds, well under the uninstall entry's but not instant.
const BUILD_TIMEOUT_MS = 180_000;

let placements: Map<string, CatalogPlacement>;
let devPlacements: Map<string, CatalogPlacement>;

beforeAll(async () => {
  placements = await buildProbe('production');
  devPlacements = await buildProbe('development');
}, BUILD_TIMEOUT_MS);

describe('compiled catalogs are code-split', () => {
  const onDemandLocales = SUPPORTED_LOCALES.filter((locale) => locale !== FALLBACK_LOCALE);

  test('reaches every enumerated locale', () => {
    // Lower bound against a vacuous pass: a build that resolved nothing would
    // satisfy every "not in the entry chunk" assertion below by having no
    // catalogs at all.
    expect([...placements.keys()].sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  test.each(onDemandLocales)('gives %s a chunk of its own, outside the entry', (locale) => {
    const placement = placements.get(locale);

    expect(placement?.isEntry).toBe(false);
    expect(placement?.catalogsInChunk).toBe(1);
  });

  test('gives no two locales the same chunk', () => {
    const chunks = onDemandLocales.map((locale) => placements.get(locale)?.chunkFileName);

    expect(new Set(chunks).size).toBe(onDemandLocales.length);
  });

  test('keeps the bootstrap catalog in the entry, so returning to it fetches nothing', () => {
    const placement = placements.get(FALLBACK_LOCALE);

    expect(placement?.isEntry).toBe(true);
    expect(placement?.catalogsInChunk).toBe(1);
  });
});

describe('the pseudolocalized catalog', () => {
  test('is nowhere in a shipped build, so nobody can stumble into it', () => {
    expect(placements.has(PSEUDO_LOCALE)).toBe(false);
  });

  test('is there in a development build, which is what makes its absence above mean something', () => {
    expect(devPlacements.has(PSEUDO_LOCALE)).toBe(true);
  });

  test('costs a development build a chunk of its own, never the entry', () => {
    const placement = devPlacements.get(PSEUDO_LOCALE);

    expect(placement?.isEntry).toBe(false);
    expect(placement?.catalogsInChunk).toBe(1);
  });
});
