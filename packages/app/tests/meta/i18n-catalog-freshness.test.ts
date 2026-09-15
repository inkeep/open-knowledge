import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  assertI18nCatalogsFresh,
  COMPILE_TIMEOUT_MS,
  describeCompileFailure,
  findStaleCatalogLocales,
  linguiBinEntry,
  linguiBinEntryFrom,
} from '../stress/_helpers/i18n-catalog-freshness.ts';
import { APP_PACKAGE_ROOT } from '../stress/_helpers/seed-key.ts';
import { withTempDir } from '../temp-dir.test-helper.ts';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

const { rmSync: actualRmSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
const mockedRm = vi.mocked(rmSync);

const TEMP_DIR_PREFIX = 'ok-i18n-catalog-freshness-';
const SCRATCH_DIR_MARKER = '.ok-i18n-freshness-';
const EDITED_LOCALE = 'es';
const UNCOMPILED_LOCALE = 'fr';
const UNCONFIGURED_LOCALE = 'xx';
const PROBE_TRANSLATION = 'catalog freshness probe';
const PLAIN_MSGSTR = /^msgstr "([^"\\{}#]+)"$/m;

function buildAppPackageFixture(fixtureRoot: string): string {
  copyFileSync(join(APP_PACKAGE_ROOT, 'lingui.config.ts'), join(fixtureRoot, 'lingui.config.ts'));
  cpSync(join(APP_PACKAGE_ROOT, 'src', 'locales'), join(fixtureRoot, 'src', 'locales'), {
    recursive: true,
  });
  return fixtureRoot;
}

function editOneTranslation(fixtureRoot: string, locale: string): void {
  const catalogPath = join(fixtureRoot, 'src', 'locales', locale, 'messages.po');
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

describe('i18n catalog freshness', { timeout: COMPILE_TIMEOUT_MS + 30_000 }, () => {
  test('an untouched checkout reports no stale locale', async () => {
    await withTempDir(TEMP_DIR_PREFIX, async (fixtureRoot) => {
      const appPackageRoot = buildAppPackageFixture(fixtureRoot);

      expect(
        findStaleCatalogLocales(appPackageRoot),
        'a locale named here on an unmodified copy of this checkout means either the predicate over-fires — which would red every local Playwright run — or the committed catalogs really are stale and `pnpm run i18n` was never re-run',
      ).toEqual([]);
    });
  });

  test('editing a translation without recompiling marks only that locale stale', async () => {
    await withTempDir(TEMP_DIR_PREFIX, async (fixtureRoot) => {
      const appPackageRoot = buildAppPackageFixture(fixtureRoot);

      editOneTranslation(appPackageRoot, EDITED_LOCALE);

      expect(
        findStaleCatalogLocales(appPackageRoot),
        'an edited messages.po whose messages.json was never recompiled is exactly the case every Playwright dev-server spawn now skips the compile for, and a predicate that names sibling locales too would train readers to ignore it',
      ).toEqual([EDITED_LOCALE]);
    });
  });

  test('a compiled catalog that was never written marks its locale stale', async () => {
    await withTempDir(TEMP_DIR_PREFIX, async (fixtureRoot) => {
      const appPackageRoot = buildAppPackageFixture(fixtureRoot);

      rmSync(join(appPackageRoot, 'src', 'locales', UNCOMPILED_LOCALE, 'messages.json'));

      expect(
        findStaleCatalogLocales(appPackageRoot),
        'a locale whose messages.json is absent has nothing for the app to serve, so treating a missing file as fresh would be the emptiest pass of all',
      ).toEqual([UNCOMPILED_LOCALE]);
    });
  });

  test('the failure names the stale locale and the command that fixes it', async () => {
    await withTempDir(TEMP_DIR_PREFIX, async (fixtureRoot) => {
      const appPackageRoot = buildAppPackageFixture(fixtureRoot);
      editOneTranslation(appPackageRoot, EDITED_LOCALE);

      const raised = raiseFrom(() => assertI18nCatalogsFresh(appPackageRoot));

      expect(
        raised,
        'a stale catalog that does not throw leaves the run serving committed copy while its assertions read like the edit landed',
      ).toBeInstanceOf(Error);
      expect(
        (raised as Error).message,
        'the reader has to be told which locale drifted and which command recompiles it, or the failure points nowhere near its cause',
      ).toContain(EDITED_LOCALE);
      expect((raised as Error).message).toContain('pnpm run i18n');
      expect((raised as Error).message).toContain(appPackageRoot);
    });
  });

  test('a fresh checkout raises nothing', async () => {
    await withTempDir(TEMP_DIR_PREFIX, async (fixtureRoot) => {
      const appPackageRoot = buildAppPackageFixture(fixtureRoot);

      expect(
        () => assertI18nCatalogsFresh(appPackageRoot),
        'a guard that throws on a clean tree would be routed around within a day',
      ).not.toThrow();
    });
  });

  test('a source catalog no configured locale compiles is an outcome of its own, not a pass', async () => {
    await withTempDir(TEMP_DIR_PREFIX, async (fixtureRoot) => {
      const appPackageRoot = buildAppPackageFixture(fixtureRoot);
      const orphanDir = join(appPackageRoot, 'src', 'locales', UNCONFIGURED_LOCALE);
      mkdirSync(orphanDir, { recursive: true });
      copyFileSync(
        join(appPackageRoot, 'src', 'locales', UNCOMPILED_LOCALE, 'messages.po'),
        join(orphanDir, 'messages.po'),
      );

      const raised = raiseFrom(() => assertI18nCatalogsFresh(appPackageRoot));

      expect(
        raised,
        'a locale absent from both sides compares null to null, so calling it fresh is a comparison whose only possible answer is pass — the shape this guard exists to close',
      ).toBeInstanceOf(Error);
      expect((raised as Error).message).toContain(UNCONFIGURED_LOCALE);
      expect(
        (raised as Error).message,
        'reporting it merely stale would prescribe `pnpm run i18n`, which is config-scoped and can never write a catalog for a locale the config omits, so the red would be unclearable',
      ).toContain('does not list the locale');
      expect((raised as Error).message).toContain('lingui.config.ts');
    });
  });

  test('a malformed compiled catalog names the file that will not parse', async () => {
    await withTempDir(TEMP_DIR_PREFIX, async (fixtureRoot) => {
      const appPackageRoot = buildAppPackageFixture(fixtureRoot);
      const malformed = join(appPackageRoot, 'src', 'locales', EDITED_LOCALE, 'messages.json');
      writeFileSync(malformed, '{', 'utf-8');

      const raised = raiseFrom(() => findStaleCatalogLocales(appPackageRoot));

      expect(raised).toBeInstanceOf(Error);
      expect(
        (raised as Error).message,
        'up to 26 catalogs are read per run, so a bare SyntaxError with a character offset names none of them and the reader cannot tell which file to open',
      ).toContain(malformed);
    });
  });

  test('a scratch-directory cleanup failure does not mask the staleness it was cleaning up after', async () => {
    await withTempDir(TEMP_DIR_PREFIX, async (fixtureRoot) => {
      const appPackageRoot = buildAppPackageFixture(fixtureRoot);
      editOneTranslation(appPackageRoot, EDITED_LOCALE);

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

      let raised: unknown;
      let warnings: string[] = [];
      try {
        raised = raiseFrom(() => assertI18nCatalogsFresh(appPackageRoot));
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
        (raised as Error | undefined)?.message,
        'an rm errno on a scratch dir under node_modules is not a freshness signal, and letting a finally-throw supersede the verdict hands the operator an unrelated filesystem error instead of the stale locale',
      ).toContain('i18n catalogs are stale for');
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
      'a path assembled from a literal dist filename is not part of the package contract, so a rename inside a caret-range bump would kill three tiers in globalSetup with no semver break to warn anyone',
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
        'a globalSetup that dies on a bare ENOENT naming a package.json path lands ahead of any browser on three tiers and points at neither i18n freshness nor @lingui/cli resolution',
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
    const launch = spawnSync(join(APP_PACKAGE_ROOT, 'no-such-lingui-bin'), [], {
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
