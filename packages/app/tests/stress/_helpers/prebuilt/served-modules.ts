import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import {
  PREBUILT_MODULE_CHUNKS,
  PREBUILT_MODULE_MANIFEST,
} from '../../../../src/build/prebuilt-dev-contract.ts';
import { APP_PACKAGE_ROOT } from '../seed-key.ts';
import { type ModuleServing, workerServingFromEnv } from './prebuilt-serving.ts';

type ModuleLocator = {
  readonly moduleUrl: (source: string) => string;
  readonly entryScriptUrl: () => string;
  readonly requestPaths: (sources: readonly string[]) => ReadonlySet<string>;
};

export type ServedModules = ModuleLocator & {
  readonly moduleRoute: (...sources: readonly string[]) => (url: URL) => boolean;
  readonly entryScriptRoute: () => (url: URL) => boolean;
};

const SHELL_HTML = 'index.html';
const BROWSER_MODULE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs']);
const MODULE_SCRIPT = /<script\b(?=[^>]*\btype="module")[^>]*\bsrc="([^"]+)"[^>]*>/g;
const URL_BASE = 'http://served-module.invalid';

type ModuleManifestEntry = {
  readonly file: string;
  readonly loadedOnItsOwn: boolean;
};

export function parseModuleManifest(value: unknown): ReadonlyMap<string, ModuleManifestEntry> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('the prebuilt module manifest is not a JSON object');
  }
  const entries = new Map<string, ModuleManifestEntry>();
  for (const [source, raw] of Object.entries(value)) {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`the prebuilt module manifest entry for ${source} is not an object`);
    }
    const { file, isEntry, isDynamicEntry } = raw as Record<string, unknown>;
    if (typeof file !== 'string' || file === '') {
      throw new Error(`the prebuilt module manifest entry for ${source} names no file`);
    }
    entries.set(source, { file, loadedOnItsOwn: isEntry === true || isDynamicEntry === true });
  }
  return entries;
}

export function parseModuleChunks(value: unknown): ReadonlyMap<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('the prebuilt module chunk map is not a JSON object');
  }
  const chunks = new Map<string, string>();
  for (const [source, chunk] of Object.entries(value)) {
    if (typeof chunk !== 'string' || chunk === '') {
      throw new Error(`the prebuilt module chunk map names no chunk for ${source}`);
    }
    chunks.set(source, chunk);
  }
  return chunks;
}

function pathnameOf(url: string): string {
  return new URL(url, URL_BASE).pathname;
}

function devModuleLocator(appRoot: string): ModuleLocator {
  const moduleUrl = (source: string) => {
    if (statSync(join(appRoot, source), { throwIfNoEntry: false })?.isFile() !== true) {
      throw new Error(
        `${source} is not a source file of the app, so the dev server serves no module for it`,
      );
    }
    return BROWSER_MODULE_EXTENSIONS.has(extname(source)) ? `/${source}` : `/${source}?import`;
  };
  return {
    moduleUrl,
    entryScriptUrl() {
      const sources = [
        ...readFileSync(join(appRoot, SHELL_HTML), 'utf8').matchAll(MODULE_SCRIPT),
      ].map((match) => match[1]);
      const [source] = sources;
      if (sources.length !== 1 || source === undefined) {
        throw new Error(
          `${SHELL_HTML} has ${sources.length} module scripts, so it names no single entry script`,
        );
      }
      return source;
    },
    requestPaths(sources) {
      return new Set(sources.map((source) => pathnameOf(moduleUrl(source))));
    },
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function prebuiltModuleLocator(outputDir: string): ModuleLocator {
  const distDir = join(outputDir, 'dist');
  const manifest = parseModuleManifest(readJson(join(distDir, PREBUILT_MODULE_MANIFEST)));
  const carriers = parseModuleChunks(readJson(join(distDir, PREBUILT_MODULE_CHUNKS)));
  const ownerOf = new Map(
    [...manifest]
      .filter(([, entry]) => entry.loadedOnItsOwn)
      .map(([source, entry]) => [entry.file, source]),
  );
  const chunkOf = (source: string) => {
    const file = manifest.get(source)?.file;
    if (file === undefined) {
      throw new Error(
        `${source} names no chunk of the prebuilt DEV app (${distDir}), so no request serves it alone`,
      );
    }
    return `/${file}`;
  };
  return {
    moduleUrl: chunkOf,
    entryScriptUrl: () => chunkOf(SHELL_HTML),
    requestPaths(sources) {
      const requested = new Set(sources);
      const paths = new Set<string>();
      for (const source of sources) {
        const chunk = carriers.get(source);
        if (chunk === undefined) {
          throw new Error(`${source} is in no chunk of the prebuilt DEV app (${distDir})`);
        }
        const owner = ownerOf.get(chunk);
        if (owner === undefined) {
          throw new Error(
            `${source} is bundled into ${chunk}, which no single module loads on its own, so delaying it would delay more than ${source}`,
          );
        }
        if (!requested.has(owner)) {
          throw new Error(
            `${source} is bundled into ${chunk}, the chunk of ${owner}, which this route does not delay, so delaying it would delay more than ${source}`,
          );
        }
        paths.add(`/${chunk}`);
      }
      return paths;
    },
  };
}

export function resolveServedModules(
  serving: ModuleServing,
  appRoot: string = APP_PACKAGE_ROOT,
): ServedModules {
  const locator =
    serving.kind === 'dev-server'
      ? devModuleLocator(appRoot)
      : prebuiltModuleLocator(serving.outputDir);
  return {
    ...locator,
    moduleRoute(...sources) {
      if (sources.length === 0)
        throw new Error('a module route needs at least one source to match');
      const paths = locator.requestPaths(sources);
      return (url) => paths.has(url.pathname);
    },
    entryScriptRoute() {
      const path = pathnameOf(locator.entryScriptUrl());
      return (url) => url.pathname === path;
    },
  };
}

let workerModules: ServedModules | undefined;

function servedModules(): ServedModules {
  workerModules ??= resolveServedModules(workerServingFromEnv(process.env));
  return workerModules;
}

export function servedModuleUrl(source: string): string {
  return servedModules().moduleUrl(source);
}

export function servedModuleRoute(...sources: readonly string[]): (url: URL) => boolean {
  return servedModules().moduleRoute(...sources);
}

export function servedEntryScriptRoute(): (url: URL) => boolean {
  return servedModules().entryScriptRoute();
}

export function appSourcesIn(directory: string, name: RegExp): string[] {
  return readdirSync(join(APP_PACKAGE_ROOT, directory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && name.test(entry.name))
    .map((entry) => `${directory}/${entry.name}`)
    .sort();
}
