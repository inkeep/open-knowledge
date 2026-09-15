import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { APP_PACKAGE_ROOT } from './seed-key.ts';
import { removeAllDuringTeardown } from './teardown-fs.ts';

export const COMPILE_TIMEOUT_MS = 120_000;
const SCRATCH_PREFIX = '.ok-i18n-freshness-';
const CATALOG_SOURCE_FILENAME = 'messages.po';
const CATALOG_COMPILED_FILENAME = 'messages.json';
const LINGUI_CONFIG_FILENAME = 'lingui.config.ts';

export function linguiBinEntry(): string {
  const require = createRequire(import.meta.url);
  const resolvedEntry = require.resolve('@lingui/cli');
  return linguiBinEntryFrom(join(dirname(resolvedEntry), '..'), resolvedEntry);
}

export function linguiBinEntryFrom(packageRoot: string, resolvedEntry: string): string {
  const manifestPath = join(packageRoot, 'package.json');
  let manifest: { version?: string; bin?: Record<string, string> };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    throw new Error(
      `could not read the @lingui/cli manifest at ${manifestPath}: this run took the package root to be one directory above the directory holding the resolved "." export (${resolvedEntry}), so a release that moved that entry leaves the root wrong and the i18n catalogs unchecked for staleness: ${String(err)}`,
    );
  }
  const declared = manifest.bin?.lingui;
  if (declared === undefined)
    throw new Error(
      `@lingui/cli@${manifest.version ?? 'unknown'} declares no "lingui" bin, so this run cannot compile the i18n catalogs to check them for staleness`,
    );
  return join(packageRoot, declared);
}

export function describeCompileFailure(
  compiled: Pick<SpawnSyncReturns<string>, 'status' | 'signal' | 'error'>,
): string {
  const err = compiled.error as NodeJS.ErrnoException | undefined;
  if (err?.code === 'ETIMEDOUT')
    return `lingui compile did not finish within ${COMPILE_TIMEOUT_MS}ms and was killed`;
  const exit = `lingui compile exited ${String(compiled.status)}${compiled.signal ? ` on ${compiled.signal}` : ''}`;
  return err === undefined ? exit : `${exit}, and spawnSync reported ${String(err)}`;
}

function localesDirOf(appPackageRoot: string): string {
  return join(appPackageRoot, 'src', 'locales');
}

function catalogLocales(appPackageRoot: string): string[] {
  const localesDir = localesDirOf(appPackageRoot);
  return readdirSync(localesDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(join(localesDir, entry.name, CATALOG_SOURCE_FILENAME)),
    )
    .map((entry) => entry.name)
    .sort();
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function readCompiledCatalog(path: string): string | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8');
  try {
    return JSON.stringify(canonicalize(JSON.parse(raw)));
  } catch (err) {
    throw new Error(
      `could not parse the compiled i18n catalog at ${path}, so this run cannot tell whether it would serve stale copy: ${String(err)}`,
    );
  }
}

function compileInto(scratchRoot: string, appPackageRoot: string, locales: string[]): void {
  copyFileSync(
    join(appPackageRoot, LINGUI_CONFIG_FILENAME),
    join(scratchRoot, LINGUI_CONFIG_FILENAME),
  );
  for (const locale of locales) {
    mkdirSync(join(scratchRoot, 'src', 'locales', locale), { recursive: true });
    copyFileSync(
      join(localesDirOf(appPackageRoot), locale, CATALOG_SOURCE_FILENAME),
      join(scratchRoot, 'src', 'locales', locale, CATALOG_SOURCE_FILENAME),
    );
  }
  const compiled = spawnSync(
    process.execPath,
    [
      linguiBinEntry(),
      'compile',
      '--namespace',
      'json',
      /* UPSTREAM(@lingui/cli@6.0.1): dist/api/typedPool.js points the worker pool at
         compileWorkerWrapper.jiti.js when NODE_ENV === 'test', and the published package ships only
         the .prod.js build, so the pool dies under any caller vitest started. --workers 1 takes
         lingui's single-threaded path instead. */
      '--workers',
      '1',
      '--config',
      join(scratchRoot, LINGUI_CONFIG_FILENAME),
    ],
    { cwd: APP_PACKAGE_ROOT, encoding: 'utf-8', timeout: COMPILE_TIMEOUT_MS },
  );
  if (compiled.error !== undefined || compiled.status !== 0) {
    throw new Error(
      `could not compile the i18n catalogs of ${appPackageRoot} to check them for staleness, so this run cannot tell whether it would serve stale copy — ${describeCompileFailure(compiled)}:\n${compiled.stderr ?? ''}${compiled.stdout ?? ''}`,
    );
  }
}

export function findStaleCatalogLocales(appPackageRoot: string): string[] {
  const locales = catalogLocales(appPackageRoot);
  mkdirSync(join(APP_PACKAGE_ROOT, 'node_modules'), { recursive: true });
  const scratchRoot = mkdtempSync(join(APP_PACKAGE_ROOT, 'node_modules', SCRATCH_PREFIX));
  try {
    compileInto(scratchRoot, appPackageRoot, locales);
    const compiledDir = join(scratchRoot, 'src', 'locales');
    const uncompiled = locales.filter(
      (locale) => !existsSync(join(compiledDir, locale, CATALOG_COMPILED_FILENAME)),
    );
    if (uncompiled.length > 0)
      throw new Error(
        `nothing compiles the i18n catalogs of ${uncompiled.join(', ')}: src/locales/<locale>/${CATALOG_SOURCE_FILENAME} exists but ${LINGUI_CONFIG_FILENAME} does not list the locale, so this run cannot tell whether it would serve stale copy. ` +
          `Fix: add the locale to the "locales" array in ${join(appPackageRoot, LINGUI_CONFIG_FILENAME)}, or delete ${join(localesDirOf(appPackageRoot), '<locale>')}.`,
      );
    return locales.filter(
      (locale) =>
        readCompiledCatalog(
          join(localesDirOf(appPackageRoot), locale, CATALOG_COMPILED_FILENAME),
        ) !== readCompiledCatalog(join(compiledDir, locale, CATALOG_COMPILED_FILENAME)),
    );
  } finally {
    try {
      removeAllDuringTeardown(scratchRoot);
    } catch (err) {
      console.warn(
        `[i18n freshness] could not remove the scratch compile directory ${scratchRoot}, so it is left behind rather than masking the freshness verdict: ${String(err)}`,
      );
    }
  }
}

export function assertI18nCatalogsFresh(appPackageRoot: string): void {
  const stale = findStaleCatalogLocales(appPackageRoot);
  if (stale.length === 0) return;
  throw new Error(
    `i18n catalogs are stale for ${stale.join(', ')}: src/locales/<locale>/${CATALOG_COMPILED_FILENAME} is not what ${CATALOG_SOURCE_FILENAME} compiles to. ` +
      'Every dev server a Playwright run boots sets OK_TEST_SKIP_I18N_COMPILE, so nothing in this run would recompile them and every assertion would read the committed copy instead of your edit. ' +
      `Fix: run "pnpm run i18n" in ${appPackageRoot}, then re-run.`,
  );
}

export default function globalAssertI18nCatalogsFresh(): void {
  assertI18nCatalogsFresh(APP_PACKAGE_ROOT);
}
