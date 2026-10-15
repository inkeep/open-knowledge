import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface SourceCatalog {
  readonly locale: string;
  readonly bytes: Buffer;
}

interface Sources {
  readonly config: Buffer;
  readonly catalogs: readonly SourceCatalog[];
}

interface Stamp {
  readonly inputs: string;
  readonly outputs: Readonly<Record<string, string>>;
}

type CompileOutcome = Pick<SpawnSyncReturns<string>, 'status' | 'signal' | 'error'>;

export const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const COMPILE_TIMEOUT_MS = 120_000;
const SCRATCH_PREFIX = '.ok-i18n-compile-';
const CATALOG_SOURCE_FILENAME = 'messages.po';
const CATALOG_COMPILED_FILENAME = 'messages.json';
const LINGUI_CONFIG_FILENAME = 'lingui.config.ts';
const INSTALL_SNAPSHOT = join(APP_ROOT, '..', '..', 'node_modules', '.pnpm', 'lock.yaml');
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = process.platform === 'win32' ? 30 : 6;
const RENAME_BACKOFF_MS = 50;
const RENAME_BACKOFF_CAP_MS = 500;

function errnoOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function linguiPackageRoot(): { packageRoot: string; resolvedEntry: string } {
  const require = createRequire(import.meta.url);
  const resolvedEntry = require.resolve('@lingui/cli');
  return { packageRoot: join(dirname(resolvedEntry), '..'), resolvedEntry };
}

export function linguiBinEntry(): string {
  const { packageRoot, resolvedEntry } = linguiPackageRoot();
  return linguiBinEntryFrom(packageRoot, resolvedEntry);
}

export function linguiBinEntryFrom(packageRoot: string, resolvedEntry: string): string {
  const manifestPath = join(packageRoot, 'package.json');
  let manifest: { version?: string; bin?: Record<string, string> };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    throw new Error(
      `could not read the @lingui/cli manifest at ${manifestPath}: this run took the package root to be one directory above the directory holding the resolved "." export (${resolvedEntry}), so a release that moved that entry leaves the root wrong and the i18n catalogs uncompiled: ${String(err)}`,
    );
  }
  const declared = manifest.bin?.lingui;
  if (declared === undefined)
    throw new Error(
      `@lingui/cli@${manifest.version ?? 'unknown'} declares no "lingui" bin, so this run cannot compile the i18n catalogs`,
    );
  return join(packageRoot, declared);
}

export function describeCompileFailure(compiled: CompileOutcome): string {
  const err = compiled.error;
  if (errnoOf(err) === 'ETIMEDOUT')
    return `lingui compile did not finish within ${COMPILE_TIMEOUT_MS}ms and was killed`;
  const exit = `lingui compile exited ${String(compiled.status)}${compiled.signal ? ` on ${compiled.signal}` : ''}`;
  return err === undefined ? exit : `${exit}, and spawnSync reported ${String(err)}`;
}

function localesDirOf(appRoot: string): string {
  return join(appRoot, 'src', 'locales');
}

function compiledPathOf(appRoot: string, locale: string): string {
  return join(localesDirOf(appRoot), locale, CATALOG_COMPILED_FILENAME);
}

function stampPathOf(appRoot: string): string {
  return join(appRoot, 'node_modules', '.cache', 'ok-i18n-catalogs.json');
}

function localesHolding(localesDir: string, filename: string): string[] {
  return readdirSync(localesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(localesDir, entry.name, filename)))
    .map((entry) => entry.name)
    .sort();
}

function readSources(appRoot: string): Sources {
  const localesDir = localesDirOf(appRoot);
  const catalogs = localesHolding(localesDir, CATALOG_SOURCE_FILENAME).map((locale) => ({
    locale,
    bytes: readFileSync(join(localesDir, locale, CATALOG_SOURCE_FILENAME)),
  }));
  return { config: readFileSync(join(appRoot, LINGUI_CONFIG_FILENAME)), catalogs };
}

function digestOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function inputsDigest(sources: Sources): string {
  const hash = createHash('sha256');
  const part = (label: string, bytes: Buffer | string): void => {
    hash.update(`${label}\0${bytes.length}\0`);
    hash.update(bytes);
  };
  part('compiler', readFileSync(fileURLToPath(import.meta.url)));
  part('lingui', readFileSync(join(linguiPackageRoot().packageRoot, 'package.json')));
  part('install', existsSync(INSTALL_SNAPSHOT) ? readFileSync(INSTALL_SNAPSHOT) : '');
  part('config', sources.config);
  for (const { locale, bytes } of sources.catalogs) part(`po:${locale}`, bytes);
  return hash.digest('hex');
}

function readStamp(appRoot: string): Stamp | null {
  try {
    const stamp = JSON.parse(readFileSync(stampPathOf(appRoot), 'utf-8')) as Partial<Stamp> | null;
    return typeof stamp?.inputs === 'string' &&
      stamp.outputs !== null &&
      typeof stamp.outputs === 'object'
      ? (stamp as Stamp)
      : null;
  } catch {
    return null;
  }
}

function stampStillHolds(appRoot: string, inputs: string): boolean {
  const stamp = readStamp(appRoot);
  if (stamp === null || stamp.inputs !== inputs) return false;
  const recorded = Object.entries(stamp.outputs);
  if (recorded.length === 0) return false;
  return recorded.every(([locale, digest]) => {
    const path = compiledPathOf(appRoot, locale);
    return existsSync(path) && digestOf(readFileSync(path)) === digest;
  });
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = errnoOf(err);
      if (code === undefined || !RETRYABLE_RENAME_CODES.has(code) || attempt >= RENAME_ATTEMPTS)
        throw err;
      pause(Math.min(RENAME_BACKOFF_MS * attempt, RENAME_BACKOFF_CAP_MS));
    }
  }
}

function stagedPathFor(target: string): string {
  return `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}

function replaceAtomically(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameWithRetry(from, to);
  } catch (err) {
    if (errnoOf(err) !== 'EXDEV') throw err;
    const staged = stagedPathFor(to);
    try {
      copyFileSync(from, staged);
      renameWithRetry(staged, to);
    } catch (copyErr) {
      rmSync(staged, { force: true });
      throw copyErr;
    }
  }
}

function writeStamp(appRoot: string, stamp: Stamp): void {
  const path = stampPathOf(appRoot);
  const staged = stagedPathFor(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(staged, `${JSON.stringify(stamp)}\n`, 'utf-8');
    renameWithRetry(staged, path);
  } catch (err) {
    rmSync(staged, { force: true });
    console.warn(
      `[i18n compile] the catalogs are current, but the stamp at ${path} could not be written, so the next run compiles again: ${String(err)}`,
    );
  }
}

function compileInto(scratchRoot: string, sources: Sources, appRoot: string): void {
  writeFileSync(join(scratchRoot, LINGUI_CONFIG_FILENAME), sources.config);
  for (const { locale, bytes } of sources.catalogs) {
    const localeDir = join(localesDirOf(scratchRoot), locale);
    mkdirSync(localeDir, { recursive: true });
    writeFileSync(join(localeDir, CATALOG_SOURCE_FILENAME), bytes);
  }
  const compiled = spawnSync(
    process.execPath,
    [
      linguiBinEntry(),
      'compile',
      '--namespace',
      'json',
      /* UPSTREAM(@lingui/cli@6.0.1): lingui's api/typedPool.js points the worker pool at
         compileWorkerWrapper.jiti.js when NODE_ENV === 'test', and the published package ships only
         the .prod.js build, so the pool dies under any caller vitest started. --workers 1 takes
         lingui's single-threaded path instead. */
      '--workers',
      '1',
      '--config',
      join(scratchRoot, LINGUI_CONFIG_FILENAME),
    ],
    { cwd: APP_ROOT, encoding: 'utf-8', timeout: COMPILE_TIMEOUT_MS },
  );
  if (compiled.error !== undefined || compiled.status !== 0) {
    throw new Error(
      `could not compile the i18n catalogs of ${appRoot}, so src/locales/<locale>/${CATALOG_COMPILED_FILENAME} was left as it was: ${describeCompileFailure(compiled)}:\n${compiled.stderr ?? ''}${compiled.stdout ?? ''}`,
    );
  }
  const reported = (compiled.stderr ?? '').trim();
  if (reported !== '') console.warn(`[i18n compile] lingui compile reported:\n${reported}`);
}

function assertEveryCatalogCompiled(sources: Sources, compiledDir: string, appRoot: string): void {
  const uncompiled = sources.catalogs
    .map(({ locale }) => locale)
    .filter((locale) => !existsSync(join(compiledDir, locale, CATALOG_COMPILED_FILENAME)));
  if (uncompiled.length > 0)
    throw new Error(
      `nothing compiles the i18n catalogs of ${uncompiled.join(', ')}: src/locales/<locale>/${CATALOG_SOURCE_FILENAME} exists but ${LINGUI_CONFIG_FILENAME} does not list the locale. ` +
        `Fix: add the locale to SUPPORTED_LOCALES in packages/core/src/i18n/locales.ts, to the "locales" array in ${join(appRoot, LINGUI_CONFIG_FILENAME)} and to the --locale list of "i18n:extract" in ${join(appRoot, 'package.json')}, or delete ${join(localesDirOf(appRoot), '<locale>')}.`,
    );
}

export function compileI18nCatalogs(appRoot: string = APP_ROOT): string[] {
  const root = resolve(appRoot);
  const sources = readSources(root);
  const inputs = inputsDigest(sources);
  if (stampStillHolds(root, inputs)) return [];

  mkdirSync(join(APP_ROOT, 'node_modules'), { recursive: true });
  const scratchRoot = mkdtempSync(join(APP_ROOT, 'node_modules', SCRATCH_PREFIX));
  try {
    compileInto(scratchRoot, sources, root);
    const compiledDir = localesDirOf(scratchRoot);
    assertEveryCatalogCompiled(sources, compiledDir, root);
    const outputs: Record<string, string> = {};
    const written: string[] = [];
    for (const locale of localesHolding(compiledDir, CATALOG_COMPILED_FILENAME)) {
      const fresh = join(compiledDir, locale, CATALOG_COMPILED_FILENAME);
      const bytes = readFileSync(fresh);
      const target = compiledPathOf(root, locale);
      outputs[locale] = digestOf(bytes);
      if (existsSync(target) && readFileSync(target).equals(bytes)) continue;
      replaceAtomically(fresh, target);
      written.push(locale);
    }
    writeStamp(root, { inputs, outputs });
    return written;
  } finally {
    try {
      rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      console.warn(
        `[i18n compile] could not remove the scratch compile directory ${scratchRoot}, so it is left behind: ${String(err)}`,
      );
    }
  }
}

export default function setup(): void {
  compileI18nCatalogs();
}

function main(argv: readonly string[]): number {
  const bestEffort = argv.includes('--best-effort');
  try {
    const written = compileI18nCatalogs();
    if (written.length > 0) console.log(`compiled the i18n catalogs for ${written.join(', ')}`);
    return 0;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (!bestEffort) {
      console.error(reason);
      return 1;
    }
    console.warn(
      `warning: could not compile the i18n catalogs now; the app build, typecheck, dev server and tests compile them before they read them: ${reason}`,
    );
    return 0;
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = main(process.argv.slice(2));
}
