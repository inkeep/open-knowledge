import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import linguiConfig from '../../lingui.config';
import {
  APP_ROOT,
  COMPILE_TIMEOUT_MS,
  compileI18nCatalogs,
  describeCompileFailure,
  linguiBinEntry,
  linguiBinEntryFrom,
} from '../../scripts/compile-i18n-catalogs.ts';
import { withTempDir } from '../temp-dir.test-helper.ts';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync), mkdtempSync: vi.fn(actual.mkdtempSync) };
});

const { rmSync: actualRmSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
const mockedRm = vi.mocked(rmSync);
const mockedMkdtemp = vi.mocked(mkdtempSync);

const TEMP_DIR_PREFIX = 'ok-i18n-catalog-compile-';
const SCRATCH_DIR_MARKER = '.ok-i18n-compile-';
const EDITED_LOCALE = 'es';
const UNCOMPILED_LOCALE = 'fr';
const UNCONFIGURED_LOCALE = 'xx';
const PROBE_TRANSLATION = 'catalog compile probe';
const PLAIN_MSGSTR = /^msgstr "([^"\\{}#]+)"$/m;
const CONCURRENT_RUNS = 4;
const CONFIGURED_LOCALES = [...linguiConfig.locales].sort();
const COMPILE_SCRIPT = join(APP_ROOT, 'scripts', 'compile-i18n-catalogs.ts');

function buildAppPackageFixture(fixtureRoot: string): string {
  mkdirSync(fixtureRoot, { recursive: true });
  copyFileSync(join(APP_ROOT, 'lingui.config.ts'), join(fixtureRoot, 'lingui.config.ts'));
  const sourceDir = join(APP_ROOT, 'src', 'locales');
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const source = join(sourceDir, entry.name, 'messages.po');
    if (!entry.isDirectory() || !existsSync(source)) continue;
    const targetDir = join(fixtureRoot, 'src', 'locales', entry.name);
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(source, join(targetDir, 'messages.po'));
  }
  return fixtureRoot;
}

function compiledPath(appRoot: string, locale: string): string {
  return join(appRoot, 'src', 'locales', locale, 'messages.json');
}

function catalogIdentity(appRoot: string, locale: string): number[] {
  const stat = statSync(compiledPath(appRoot, locale));
  return [stat.ino, stat.mtimeMs];
}

function compiledBytes(appRoot: string): Map<string, string> {
  return new Map(
    CONFIGURED_LOCALES.map((locale) => [
      locale,
      readFileSync(compiledPath(appRoot, locale), 'utf-8'),
    ]),
  );
}

function editOneTranslation(appRoot: string, locale: string): void {
  const catalogPath = join(appRoot, 'src', 'locales', locale, 'messages.po');
  const catalog = readFileSync(catalogPath, 'utf-8');
  const target = PLAIN_MSGSTR.exec(catalog);
  expect(
    target,
    `the mutation this test relies on never landed: ${locale}/messages.po carries no single-line plain msgstr to edit, so a green result below would prove nothing`,
  ).not.toBeNull();
  writeFileSync(
    catalogPath,
    catalog.replace(PLAIN_MSGSTR, `msgstr "${PROBE_TRANSLATION}"`),
    'utf-8',
  );
}

function raiseFrom(run: () => void): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

function compileInChild(appRoot: string): Promise<void> {
  const program = `const { compileI18nCatalogs } = await import(${JSON.stringify(pathToFileURL(COMPILE_SCRIPT).href)}); compileI18nCatalogs(${JSON.stringify(appRoot)});`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`a concurrent compile exited ${String(code)} ${String(signal)}: ${stderr}`),
          ),
    );
  });
}

describe('i18n catalog compile', { timeout: COMPILE_TIMEOUT_MS + 30_000 }, () => {
  test('a checkout with no compiled catalogs gets one for every configured locale, the pseudolocale included', async () => {
    await withTempDir(TEMP_DIR_PREFIX, async (fixtureRoot) => {
      const appRoot = buildAppPackageFixture(fixtureRoot);

      expect(
        compileI18nCatalogs(appRoot).sort(),
        'src/locales/*/messages.json is ignored by git, so a fresh clone starts with none; a locale left out here is one the app imports and Vite cannot resolve',
      ).toEqual(CONFIGURED_LOCALES);
      for (const locale of CONFIGURED_LOCALES) {
        expect(JSON.parse(readFileSync(compiledPath(appRoot, locale), 'utf-8'))).toHaveProperty(
          'messages',
        );
      }
    });
  });

  test('a run over current catalogs writes nothing, with or without its stamp', async () => {
    await withTempDir(TEMP_DIR_PREFIX, async (fixtureRoot) => {
      const appRoot = buildAppPackageFixture(fixtureRoot);
      compileI18nCatalogs(appRoot);
      const before = CONFIGURED_LOCALES.map((locale) => catalogIdentity(appRoot, locale));

      mockedMkdtemp.mockClear();
      expect(
        compileI18nCatalogs(appRoot),
        'every build, typecheck and test tier calls the compile, so a run with nothing to do must not touch a catalog',
      ).toEqual([]);
      expect(
        mockedMkdtemp,
        'a run the stamp covers must not compile at all, or every tier pays for a lingui compile',
      ).not.toHaveBeenCalled();
      rmSync(join(appRoot, 'node_modules', '.cache', 'ok-i18n-catalogs.json'));
      expect(
        compileI18nCatalogs(appRoot),
        'a lost stamp, as after a fresh install, must still leave byte-identical catalogs alone, or a running dev server reloads every connected browser',
      ).toEqual([]);

      const after = CONFIGURED_LOCALES.map((locale) => catalogIdentity(appRoot, locale));
      expect(after).toEqual(before);
    });
  });

  test('a changed config voids the stamp and still rewrites no catalog whose bytes are unchanged', async () => {
    await withTempDir(TEMP_DIR_PREFIX, async (fixtureRoot) => {
      const appRoot = buildAppPackageFixture(fixtureRoot);
      compileI18nCatalogs(appRoot);
      const configPath = join(appRoot, 'lingui.config.ts');
      writeFileSync(configPath, `${readFileSync(configPath, 'utf-8')}\n`, 'utf-8');

      mockedMkdtemp.mockClear();
      expect(compileI18nCatalogs(appRoot)).toEqual([]);
      expect(
        mockedMkdtemp,
        'a config change can change every catalog, so a stamp that ignores the config serves output the config no longer produces',
      ).toHaveBeenCalledTimes(1);
    });
  });

  test('editing one translation rewrites only that locale', async () => {
    await withTempDir(TEMP_DIR_PREFIX, async (fixtureRoot) => {
      const appRoot = buildAppPackageFixture(fixtureRoot);
      compileI18nCatalogs(appRoot);
      const identity = (locale: string) => catalogIdentity(appRoot, locale);
      const siblings = CONFIGURED_LOCALES.filter((locale) => locale !== EDITED_LOCALE);
      const siblingsBefore = siblings.map(identity);
      const editedBefore = identity(EDITED_LOCALE);

      editOneTranslation(appRoot, EDITED_LOCALE);

      expect(
        compileI18nCatalogs(appRoot),
        'a stamp that survived a .po edit would serve the old translation; a compile that rewrites sibling locales bumps files nothing changed',
      ).toEqual([EDITED_LOCALE]);
      expect(readFileSync(compiledPath(appRoot, EDITED_LOCALE), 'utf-8')).toContain(
        PROBE_TRANSLATION,
      );
      expect(
        siblings.map(identity),
        'a sibling catalog whose bytes did not change must keep its inode and mtime, or a running Vite dev server reloads every connected browser',
      ).toEqual(siblingsBefore);
      expect(
        identity(EDITED_LOCALE)[0],
        'the edited catalog must arrive by rename, which gives it a new inode; an in-place write lets a concurrent reader see it half-written',
      ).not.toBe(editedBefore[0]);
    });
  });

  test('a deleted compiled catalog is written again', async () => {
    await withTempDir(TEMP_DIR_PREFIX, async (fixtureRoot) => {
      const appRoot = buildAppPackageFixture(fixtureRoot);
      compileI18nCatalogs(appRoot);

      rmSync(compiledPath(appRoot, UNCOMPILED_LOCALE));

      expect(
        compileI18nCatalogs(appRoot),
        'the stamp records each catalog it wrote, so a missing one must void it rather than leave the app an import that cannot resolve',
      ).toEqual([UNCOMPILED_LOCALE]);
    });
  });

  test('a hand-edited compiled catalog is restored', async () => {
    await withTempDir(TEMP_DIR_PREFIX, async (fixtureRoot) => {
      const appRoot = buildAppPackageFixture(fixtureRoot);
      compileI18nCatalogs(appRoot);
      const compiled = readFileSync(compiledPath(appRoot, EDITED_LOCALE), 'utf-8');

      writeFileSync(compiledPath(appRoot, EDITED_LOCALE), '{"messages":{}}', 'utf-8');

      expect(compileI18nCatalogs(appRoot)).toEqual([EDITED_LOCALE]);
      expect(readFileSync(compiledPath(appRoot, EDITED_LOCALE), 'utf-8')).toBe(compiled);
    });
  });

  test('a source catalog no configured locale compiles fails, naming the locale and the config, and changes no catalog', async () => {
    await withTempDir(TEMP_DIR_PREFIX, async (fixtureRoot) => {
      const appRoot = buildAppPackageFixture(fixtureRoot);
      compileI18nCatalogs(appRoot);
      const before = compiledBytes(appRoot);
      editOneTranslation(appRoot, EDITED_LOCALE);
      const orphanDir = join(appRoot, 'src', 'locales', UNCONFIGURED_LOCALE);
      mkdirSync(orphanDir, { recursive: true });
      copyFileSync(
        join(appRoot, 'src', 'locales', UNCOMPILED_LOCALE, 'messages.po'),
        join(orphanDir, 'messages.po'),
      );

      const raised = raiseFrom(() => compileI18nCatalogs(appRoot));

      expect(
        raised,
        'a translated catalog nothing compiles is a language a user can never get, and passing over it silently hides that',
      ).toBeInstanceOf(Error);
      expect((raised as Error).message).toContain(UNCONFIGURED_LOCALE);
      expect((raised as Error).message).toContain('does not list the locale');
      expect((raised as Error).message).toContain('lingui.config.ts');
      expect(
        compiledBytes(appRoot),
        'lingui had already compiled the edited locale when the orphan was found, so a compile that publishes before it validates leaves a mix of two compiles',
      ).toEqual(before);
    });
  });

  test('a compile that fails leaves the compiled catalogs as they were', async () => {
    await withTempDir(TEMP_DIR_PREFIX, async (fixtureRoot) => {
      const appRoot = buildAppPackageFixture(fixtureRoot);
      compileI18nCatalogs(appRoot);
      const before = compiledBytes(appRoot);
      editOneTranslation(appRoot, EDITED_LOCALE);
      const configPath = join(appRoot, 'lingui.config.ts');
      writeFileSync(
        configPath,
        `${readFileSync(configPath, 'utf-8')}\nexport const broken = ;\n`,
        'utf-8',
      );

      const raised = raiseFrom(() => compileI18nCatalogs(appRoot));

      expect(raised).toBeInstanceOf(Error);
      expect((raised as Error).message).toContain('could not compile the i18n catalogs');
      expect(
        compiledBytes(appRoot),
        'a failed compile that already replaced some catalogs leaves the app serving a mix of two compiles',
      ).toEqual(before);
    });
  });

  test('concurrent cold runs never expose a half-written catalog', async () => {
    await withTempDir(TEMP_DIR_PREFIX, async (fixtureRoot) => {
      const appRoot = buildAppPackageFixture(join(fixtureRoot, 'shared'));
      const reference = buildAppPackageFixture(join(fixtureRoot, 'reference'));
      compileI18nCatalogs(reference);

      const unreadable: string[] = [];
      let settled = false;
      const runs = Promise.all(
        Array.from({ length: CONCURRENT_RUNS }, () => compileInChild(appRoot)),
      ).finally(() => {
        settled = true;
      });
      while (!settled) {
        for (const locale of CONFIGURED_LOCALES) {
          let text: string;
          try {
            text = readFileSync(compiledPath(appRoot, locale), 'utf-8');
          } catch {
            continue;
          }
          try {
            JSON.parse(text);
          } catch {
            unreadable.push(locale);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await runs;

      expect(
        unreadable,
        'the build, typecheck and every test tier compile concurrently under one task runner, so any reader that can catch a catalog mid-write fails at random',
      ).toEqual([]);
      expect(compiledBytes(appRoot)).toEqual(compiledBytes(reference));
    });
  });

  test('a scratch-directory cleanup failure leaves a warning, not a failed compile', async () => {
    await withTempDir(TEMP_DIR_PREFIX, async (fixtureRoot) => {
      const appRoot = buildAppPackageFixture(fixtureRoot);

      const untolerated: NodeJS.ErrnoException = Object.assign(new Error('rm EMFILE'), {
        code: 'EMFILE',
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let removed: string | undefined;
      mockedRm.mockImplementation((target, options) => {
        actualRmSync(target, options);
        if (String(target).includes(SCRATCH_DIR_MARKER)) {
          removed = String(target);
          throw untolerated;
        }
      });

      let written: string[] = [];
      let warnings: string[] = [];
      try {
        written = compileI18nCatalogs(appRoot);
        warnings = warn.mock.calls.map((call) => String(call[0]));
      } finally {
        mockedRm.mockImplementation(actualRmSync);
        warn.mockRestore();
      }

      expect(
        removed,
        'the errno never reached the cleanup path, so this test would pass without exercising anything',
      ).toBeDefined();
      expect(
        written.sort(),
        'an rm errno on a scratch directory under node_modules says nothing about the catalogs, so it must not fail the compile that already published them',
      ).toEqual(CONFIGURED_LOCALES);
      expect(
        warnings.join('\n'),
        'a scratch directory that could not be reclaimed has to leave a trace, or the downgrade turns a real leak into silence',
      ).toContain(SCRATCH_DIR_MARKER);
    });
  });
});

describe('lingui entry-point resolution', () => {
  test('resolves the entry the package manifest declares as its bin', () => {
    const require_ = createRequire(import.meta.url);
    const packageRoot = join(dirname(require_.resolve('@lingui/cli')), '..');
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8')) as {
      bin: Record<string, string>;
    };

    expect(
      linguiBinEntry(),
      'a path assembled from a literal dist filename is not part of the package contract, so a rename inside a caret-range bump would break every compile with no semver break to warn anyone',
    ).toBe(join(packageRoot, manifest.bin.lingui));
    expect(existsSync(linguiBinEntry())).toBe(true);
  });

  test('names the package and the root it assumed when the manifest is not where the depth assumption puts it', async () => {
    await withTempDir(TEMP_DIR_PREFIX, async (root) => {
      const movedRoot = join(root, 'moved');
      const movedEntry = join(movedRoot, 'esm', 'index.js');

      const raised = raiseFrom(() => linguiBinEntryFrom(movedRoot, movedEntry));

      expect(
        (raised as Error | undefined)?.message,
        'a compile that dies on a bare ENOENT naming a package.json path runs ahead of every build and test tier and points at neither the i18n catalogs nor @lingui/cli resolution',
      ).toContain('@lingui/cli');
      expect((raised as Error).message).toContain('one directory above');
      expect((raised as Error).message).toContain(movedEntry);
    });
  });
});

describe('compile-failure diagnosis', () => {
  test('names the budget when the compile was killed for exceeding it', () => {
    expect(
      describeCompileFailure({
        status: null,
        signal: 'SIGTERM',
        error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      }),
      'a timeout that renders as a bare SIGTERM is indistinguishable from an external kill, and never names the budget it blew',
    ).toContain(`did not finish within ${COMPILE_TIMEOUT_MS}ms`);
  });

  test('reports the raw exit for a kill it did not schedule', () => {
    expect(describeCompileFailure({ status: null, signal: 'SIGTERM', error: undefined })).toBe(
      'lingui compile exited null on SIGTERM',
    );
  });

  test('names the errno when the compile never ran', () => {
    const launch = spawnSync(join(APP_ROOT, 'no-such-lingui-bin'), [], {
      encoding: 'utf-8',
    });

    expect(
      launch.error,
      'the spawn succeeded, so this test would pass without exercising anything',
    ).toBeDefined();
    expect(
      describeCompileFailure(launch),
      'a launch failure renders as a bare exit status while the child wrote none of the stdout/stderr the outer throw appends, so the operator gets an empty message and no cause',
    ).toContain('ENOENT');
  });

  test('an output-overflow kill does not render as an external one', () => {
    const overflow = spawnSync(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(2000000))"],
      {
        encoding: 'utf-8',
        maxBuffer: 1024,
      },
    );

    expect(
      overflow.signal,
      'the cap was not exceeded, so this test would pass without exercising anything',
    ).toBe('SIGTERM');
    expect(
      describeCompileFailure(overflow),
      'spawnSync kills the child with SIGTERM on maxBuffer overflow, so an ENOBUFS compile is byte-identical to a kill nobody scheduled',
    ).not.toBe('lingui compile exited null on SIGTERM');
  });
});
