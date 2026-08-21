/**
 * Direct coverage for the minidump ownership parse.
 *
 * This module is the only thing standing between a third-party process's raw
 * memory and our bug-report uploads, and it reads attacker-shaped input: a
 * minidump we did not write, whose every length and offset is a `u32` we must
 * not trust. The tests below therefore drive the parser itself rather than
 * only its effect on crash detection.
 *
 * The security-relevant property is one-directional: NO malformed input may
 * ever be classified `'ours'`, and none may throw (a throw during the boot
 * scan would take out crash detection). `'unknown'` is the correct answer for
 * anything unreadable — callers pick their own default for it.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildMinidump, type MinidumpPatch } from './minidump.test-helper.ts';
import {
  classifyMinidumpCrashKind,
  classifyMinidumpOwnership,
  readMinidumpAccessibilityMode,
  readMinidumpAppVersion,
} from './minidump-ownership.ts';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'ok-minidump-ownership-'));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Write `bytes` as a dump and classify it against a bundle root under the same
 * temp dir. The builder receives that root so a case can name a module inside
 * it (ours) or anywhere else (foreign).
 */
function classifyBytes(bytes: (bundleRoot: string) => Buffer): string {
  const dir = makeDir();
  const bundleRoot = join(dir, 'Applications', 'OpenKnowledge.app');
  const dumpPath = join(dir, 'crash.dmp');
  writeFileSync(dumpPath, bytes(bundleRoot));
  return classifyMinidumpOwnership(dumpPath, bundleRoot);
}

/** The main binary of a packaged build living at `bundleRoot`. */
function ownModule(bundleRoot: string): string {
  return join(bundleRoot, 'Contents', 'MacOS', 'OpenKnowledge');
}

/** A helper process — the common crash case — inside the same bundle. */
function ownHelperModule(bundleRoot: string): string {
  return join(
    bundleRoot,
    'Contents',
    'Frameworks',
    'OpenKnowledge Helper (Renderer).app',
    'Contents',
    'MacOS',
    'OpenKnowledge Helper (Renderer)',
  );
}

const FOREIGN_MODULE = '/Applications/LibreOffice.app/Contents/MacOS/soffice';

describe('well-formed dumps', () => {
  test('a main-binary dump inside the bundle is ours', () => {
    expect(classifyBytes((root) => buildMinidump([ownModule(root), '/usr/lib/dyld']))).toBe('ours');
  });

  test('a helper-process dump inside the bundle is ours', () => {
    expect(classifyBytes((root) => buildMinidump([ownHelperModule(root)]))).toBe('ours');
  });

  test('a dump from an unrelated application is foreign', () => {
    expect(classifyBytes(() => buildMinidump([FOREIGN_MODULE, '/usr/lib/dyld']))).toBe('foreign');
  });

  test('only ModuleList[0] decides, not the modules loaded behind it', () => {
    // A foreign process that happens to have loaded one of our libraries must
    // not read as ours, and our own process is ours no matter what else it
    // loaded — the main executable is the whole question.
    expect(
      classifyBytes((root) => buildMinidump([FOREIGN_MODULE, join(root, 'Contents', 'lib.dylib')])),
    ).toBe('foreign');
    expect(classifyBytes((root) => buildMinidump([ownModule(root), FOREIGN_MODULE]))).toBe('ours');
  });

  test('a sibling path sharing the bundle-root prefix is foreign', () => {
    // `<root>.malicious/...` starts with the root string but is not inside it.
    expect(
      classifyBytes((root) => buildMinidump([`${root}.malicious/Contents/MacOS/OpenKnowledge`])),
    ).toBe('foreign');
  });

  test('a relative module name cannot resolve into the bundle', () => {
    expect(classifyBytes(() => buildMinidump(['Contents/MacOS/OpenKnowledge']))).toBe('foreign');
  });

  test('the ModuleList is found behind the streams a real dump puts first', () => {
    // Crashpad emits ThreadList, MemoryList, ExceptionStream and more ahead of
    // the ModuleList, so the directory search has to walk. A single-entry
    // fixture would pass even if the parser only ever read entry 0.
    expect(classifyBytes((root) => buildMinidump([ownModule(root)], { streamsBefore: 6 }))).toBe(
      'ours',
    );
    expect(classifyBytes(() => buildMinidump([FOREIGN_MODULE], { streamsBefore: 6 }))).toBe(
      'foreign',
    );
  });
});

/**
 * The two sides of the comparison do not spell paths the same way. Crashpad
 * records `ModuleList[0]` as the loader saw it — the path the process was
 * invoked through, symlinks intact — while the bundle root reaches us from
 * Electron's `app.getPath('exe')`, which Chromium resolves through `realpath`
 * before returning. Any symlink anywhere in the launch path therefore yields
 * two different spellings of one file, and comparing them as text alone reads
 * our own crash as somebody else's.
 *
 * Not hypothetical: a dev run launches Electron through pnpm's symlinked
 * `node_modules/electron`, and every own dump from such a run classifies
 * `'foreign'` under a purely lexical comparison.
 */
describe('symlinked launch paths', () => {
  /** Bundle at `<dir>/real/…`, reachable a second way via `<dir>/link/…`. */
  function makeLinkedBundle(): { realRoot: string; linkedExecutable: string; dir: string } {
    const dir = makeDir();
    const realRoot = join(dir, 'real', 'OpenKnowledge.app');
    mkdirSync(join(realRoot, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(join(realRoot, 'Contents', 'MacOS', 'OpenKnowledge'), '');
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    return {
      dir,
      realRoot,
      linkedExecutable: join(
        dir,
        'link',
        'OpenKnowledge.app',
        'Contents',
        'MacOS',
        'OpenKnowledge',
      ),
    };
  }

  test('a dump recorded through a symlinked launch path is ours', () => {
    const { dir, realRoot, linkedExecutable } = makeLinkedBundle();
    const dumpPath = join(dir, 'crash.dmp');
    writeFileSync(dumpPath, buildMinidump([linkedExecutable, '/usr/lib/dyld']));

    expect(classifyMinidumpOwnership(dumpPath, realRoot)).toBe('ours');
  });

  test('resolving the link cannot launder a foreign dump into ours', () => {
    // The resolved form is what decides, so a foreign binary stays foreign no
    // matter which spelling of it the dump happens to carry.
    const { dir, realRoot } = makeLinkedBundle();
    const outsider = join(dir, 'Outsider.app', 'Contents', 'MacOS', 'Outsider');
    mkdirSync(join(dir, 'Outsider.app', 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(outsider, '');
    symlinkSync(outsider, join(dir, 'outsider-link'));
    const dumpPath = join(dir, 'crash.dmp');
    writeFileSync(dumpPath, buildMinidump([join(dir, 'outsider-link')]));

    expect(classifyMinidumpOwnership(dumpPath, realRoot)).toBe('foreign');
  });
});

/**
 * Every case names a single lie the dump tells about its own layout, with the
 * rest of the structure left well-formed, so a failure points at one offset.
 *
 * `versionSurvives` records what the SAME lie does to the app-version read,
 * which lives in a different stream. A lie about the header or the stream
 * directory takes down both reads; one about a module record leaves the
 * annotations perfectly readable. That split is the observable form of the two
 * reads being independent, so it is pinned per case rather than asserted as a
 * blanket property neither read could violate.
 */
const MALFORMED_CASES: Array<{
  name: string;
  patch: MinidumpPatch;
  versionSurvives: boolean;
}> = [
  { name: 'a wrong header magic', patch: { signature: 'XXXX' }, versionSurvives: false },
  { name: 'a header truncated mid-field', patch: { truncateTo: 20 }, versionSurvives: false },
  {
    name: 'a stream-directory RVA past the end of the file',
    patch: { streamDirectoryRva: 0xffff },
    versionSurvives: false,
  },
  {
    name: 'a stream count beyond the parser cap',
    patch: { streamCount: 100_000 },
    versionSurvives: false,
  },
  { name: 'a stream count of zero', patch: { streamCount: 0 }, versionSurvives: false },
  {
    name: 'a directory holding no ModuleList stream',
    patch: { streamType: 7 },
    versionSurvives: true,
  },
  {
    name: 'a ModuleList RVA past the end of the file',
    patch: { moduleListRva: 0xffff },
    versionSurvives: true,
  },
  { name: 'a module count of zero', patch: { moduleCount: 0 }, versionSurvives: true },
  // The ModuleList count sits at 44..48 and the first 108-byte record follows,
  // so cutting at 60 leaves the record short.
  {
    name: 'a first module record cut short by the file end',
    patch: { truncateTo: 60 },
    versionSurvives: false,
  },
  {
    name: 'a module-name RVA past the end of the file',
    patch: { nameRva: 0xffff },
    versionSurvives: true,
  },
  { name: 'a name byte length of zero', patch: { nameByteLength: 0 }, versionSurvives: true },
  {
    name: 'an odd name byte length (never valid UTF-16)',
    patch: { nameByteLength: 9 },
    versionSurvives: true,
  },
  {
    name: 'a name byte length beyond the parser cap',
    patch: { nameByteLength: 1_000_000 },
    versionSurvives: true,
  },
  // Even and under the cap, but longer than the bytes actually present.
  {
    name: 'a name that overruns the end of the file',
    patch: { nameByteLength: 4096 },
    versionSurvives: true,
  },
];

describe('malformed dumps are unreadable, never ours', () => {
  for (const { name, patch } of MALFORMED_CASES) {
    test(`${name} reads as unknown`, () => {
      expect(classifyBytes((root) => buildMinidump([ownModule(root)], patch))).toBe('unknown');
    });
  }

  test('a file that is not a minidump at all reads as unknown', () => {
    expect(classifyBytes(() => Buffer.from('minidump-bytes-that-are-not-a-minidump'))).toBe(
      'unknown',
    );
  });

  test('an empty file reads as unknown', () => {
    expect(classifyBytes(() => Buffer.alloc(0))).toBe('unknown');
  });

  test('a dump that vanished before the scan reads as unknown', () => {
    // Crashpad rotates its own database, so a path can disappear between the
    // directory listing and this read.
    const dir = makeDir();
    expect(classifyMinidumpOwnership(join(dir, 'gone.dmp'), join(dir, 'OpenKnowledge.app'))).toBe(
      'unknown',
    );
  });

  test('a directory where a dump should be reads as unknown', () => {
    // Opening succeeds on a directory; the first read is what fails.
    const dir = makeDir();
    expect(classifyMinidumpOwnership(dir, join(dir, 'OpenKnowledge.app'))).toBe('unknown');
  });
});

/**
 * The crashed session's own app version, which the boot-time detector needs
 * because an auto-update can replace the binary between the crash and the
 * launch that notices it.
 *
 * The security-relevant property mirrors the ownership one: no malformed
 * annotation block may ever produce a version, none may throw on the boot
 * path, and none may disturb the ownership answer read from the same file.
 */
describe('crashpad app-version annotations', () => {
  /** Write a dump under a temp dir and read its version back. */
  function versionOf(patch: MinidumpPatch): string | null {
    const dir = makeDir();
    const dumpPath = join(dir, 'crash.dmp');
    writeFileSync(dumpPath, buildMinidump([ownModule(join(dir, 'OpenKnowledge.app'))], patch));
    const read = readMinidumpAppVersion(dumpPath);
    // Every case here is a dump the parse declines to trust, never one it
    // failed to parse — the distinction the flag exists to carry, asserted
    // once here so each case below can stay a plain version comparison.
    expect(read.parseFailed).toBe(false);
    return read.version;
  }

  test('a dump carrying annotations names the version that crashed', () => {
    // The five keys a real Electron dump carries, in the order Crashpad
    // writes them, so the lookup is exercised past the first entry.
    expect(
      versionOf({
        annotations: {
          _productName: 'OpenKnowledge',
          _version: '0.41.0',
          plat: 'OS X',
          prod: 'Electron',
          ver: '41.2.1',
        },
      }),
    ).toBe('0.41.0');
  });

  test('the app version wins over the Electron version beside it', () => {
    expect(versionOf({ annotations: { ver: '41.2.1', _version: '0.41.0' } })).toBe('0.41.0');
  });

  test('a dump with no crashpad stream at all has no version', () => {
    expect(versionOf({})).toBeNull();
  });

  test('annotations that name no version have no version', () => {
    expect(versionOf({ annotations: { _productName: 'OpenKnowledge', prod: 'Electron' } })).toBe(
      null,
    );
  });

  test('a dump truncated before its annotations has no version', () => {
    expect(versionOf({ annotations: { _version: '0.41.0' }, truncateTo: 80 })).toBeNull();
  });

  /**
   * One lie per case with the rest of the dump well-formed, so a failure names
   * a single offset. Each uses a single-entry dictionary because the patches
   * target the first entry.
   */
  const MALFORMED_ANNOTATION_CASES: Array<{ name: string; patch: MinidumpPatch }> = [
    {
      name: 'a crashpad stream hidden behind another stream type',
      patch: { crashpadStreamType: 9 },
    },
    { name: 'a dictionary RVA of zero (no annotations registered)', patch: { annotationsRva: 0 } },
    { name: 'a dictionary RVA past the end of the file', patch: { annotationsRva: 0xffff } },
    { name: 'an entry count beyond the parser cap', patch: { annotationCount: 100_000 } },
    { name: 'an entry count of zero', patch: { annotationCount: 0 } },
    { name: 'an entry count larger than the block has room for', patch: { annotationCount: 4 } },
    { name: 'a declared dictionary size too small for its entries', patch: { annotationsSize: 4 } },
    { name: 'a key RVA past the end of the file', patch: { annotationKeyRva: 0xffff } },
    { name: 'a key RVA of zero', patch: { annotationKeyRva: 0 } },
    { name: 'a value RVA past the end of the file', patch: { annotationValueRva: 0xffff } },
    { name: 'a value RVA of zero', patch: { annotationValueRva: 0 } },
    { name: 'a value byte length of zero', patch: { annotationValueByteLength: 0 } },
    {
      name: 'a value byte length beyond the parser cap',
      patch: { annotationValueByteLength: 1_000_000 },
    },
    // Under the cap, but longer than the bytes actually present.
    {
      name: 'a value that overruns the end of the file',
      patch: { annotationValueByteLength: 200 },
    },
  ];

  for (const { name, patch } of MALFORMED_ANNOTATION_CASES) {
    test(`${name} yields no version`, () => {
      expect(versionOf({ annotations: { _version: '0.41.0' }, ...patch })).toBeNull();
    });
  }

  test('a value carrying control characters is refused', () => {
    // The value lands in a line-oriented log and report body, so a newline
    // would let it forge the context lines printed around it.
    const forged = `0.41.0${String.fromCharCode(10)}Crash source: something untrue`;
    expect(versionOf({ annotations: { _version: forged } })).toBeNull();
  });

  test('a malformed annotation block leaves ownership intact', () => {
    // The load-bearing independence check. Ownership decides whether a report
    // may carry process memory at all, so a drift in Crashpad's annotation
    // layout must never quietly turn our own crashes into unattachable ones.
    const dir = makeDir();
    const bundleRoot = join(dir, 'Applications', 'OpenKnowledge.app');
    const dumpPath = join(dir, 'crash.dmp');
    writeFileSync(
      dumpPath,
      buildMinidump([ownModule(bundleRoot), '/usr/lib/dyld'], {
        annotations: { _version: '0.41.0' },
        annotationsRva: 0xffff,
      }),
    );

    expect(readMinidumpAppVersion(dumpPath).version).toBeNull();
    expect(classifyMinidumpOwnership(dumpPath, bundleRoot)).toBe('ours');
  });

  test('a version never launders a foreign dump into ours', () => {
    // Crashpad stamps OUR annotations onto dumps written for descendant
    // processes, so a version alone never implies the crash was ours. This is
    // why the detector reads the version only for a dump ownership kept.
    const dir = makeDir();
    const bundleRoot = join(dir, 'Applications', 'OpenKnowledge.app');
    const dumpPath = join(dir, 'crash.dmp');
    writeFileSync(
      dumpPath,
      buildMinidump(['/Applications/LibreOffice.app/Contents/MacOS/soffice'], {
        annotations: { _version: '0.41.0' },
      }),
    );

    expect(readMinidumpAppVersion(dumpPath).version).toBe('0.41.0');
    expect(classifyMinidumpOwnership(dumpPath, bundleRoot)).toBe('foreign');
  });

  test('an ownership lie decides the version read on its own merits', () => {
    // Each case tells one structural lie and the version read answers for
    // itself: the header and stream directory are shared, so a lie there takes
    // both down, while a lie about a module record leaves the annotations in
    // another stream untouched. Pinned as an exact table rather than "none of
    // these throws", which the two catch-alls guarantee no matter what the
    // parse does — though a throw still fails here, since it would take out
    // boot-time crash detection.
    const observed = MALFORMED_CASES.map(({ name, patch }) => {
      const dir = makeDir();
      const dumpPath = join(dir, 'crash.dmp');
      writeFileSync(
        dumpPath,
        buildMinidump([ownModule(join(dir, 'OpenKnowledge.app'))], {
          annotations: { _version: '0.41.0' },
          ...patch,
        }),
      );
      return { name, version: readMinidumpAppVersion(dumpPath).version };
    });

    // Compared as whole rows so a failure names the case that moved.
    expect(observed).toEqual(
      MALFORMED_CASES.map(({ name, versionSurvives }) => ({
        name,
        version: versionSurvives ? '0.41.0' : null,
      })),
    );
  });

  test('a parse that throws is reported as broken, not as an absent version', async () => {
    // Nothing a dump can CONTAIN reaches the annotation parse's catch — every
    // bound is checked and every distrusted layout declines by returning null,
    // which is what the table above pins. What could reach it is a Crashpad
    // revision whose records this parser no longer recognizes at all, and then
    // the report shows an unknown version with nothing to say whether the dump
    // predates the annotation or the parser regressed. Those are opposite
    // investigations. Driving the throw from outside the file is the only way
    // to hold the two apart, since no input can.
    //
    // The read is intercepted by its width: the Crashpad info record's 44-byte
    // prefix opens the annotation walk, and no other read in either pass asks
    // for that many bytes (the module-name block of a tmpdir path is far
    // wider), so ownership stays on the real implementation throughout.
    const CRASHPAD_INFO_PREFIX_BYTES = 44;
    const dir = makeDir();
    const bundleRoot = join(dir, 'OpenKnowledge.app');
    const dumpPath = join(dir, 'crash.dmp');
    writeFileSync(
      dumpPath,
      buildMinidump([ownModule(bundleRoot)], { annotations: { _version: '0.41.0' } }),
    );

    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.resetModules();
    vi.doMock('node:fs', () => ({
      ...realFs,
      readSync: (
        fd: number,
        buffer: NodeJS.ArrayBufferView,
        offset: number,
        length: number,
        position: number,
      ) => {
        if (length === CRASHPAD_INFO_PREFIX_BYTES) throw new Error('crashpad layout moved');
        return realFs.readSync(fd, buffer, offset, length, position);
      },
    }));
    try {
      // Dynamic so it binds the mocked fs; the statically imported copy at the
      // top of this file stays real for every other test here.
      const mocked = await import('./minidump-ownership.ts');

      expect(mocked.readMinidumpAppVersion(dumpPath)).toEqual({ version: null, parseFailed: true });
      // And the containment holds: a broken annotation parse still costs the
      // ownership answer nothing, which is what decides whether process memory
      // may leave the machine.
      expect(mocked.classifyMinidumpOwnership(dumpPath, bundleRoot)).toBe('ours');
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});

/**
 * Did the process actually fault?
 *
 * The failure this guards is one-directional and silent: classify a real crash
 * as "not a crash" and the user is never asked about it, the dump is never
 * offered, and nothing anywhere says so. Every case below is therefore written
 * from the direction of "can a genuine crash be swallowed", not "is the happy
 * path happy".
 *
 * `platform` is passed explicitly rather than read from the process because CI
 * runs Linux, where the predicate is deliberately inert. Left implicit, every
 * assertion here would pass vacuously on CI while proving nothing.
 */
describe('classifyMinidumpCrashKind', () => {
  /** `'CPsx'` — Crashpad's "dump captured, process did not fault" sentinel. */
  const SIMULATED = 0x4350_7378;
  /**
   * `'CPnx'` — `kMachExceptionFromNSException`. ONE hex digit from the
   * sentinel, same `CP` tag, and a genuine fatal crash.
   */
  const FROM_NS_EXCEPTION = 0x4350_6e78;

  function writeDump(patch: MinidumpPatch): string {
    const dir = makeDir();
    const dumpPath = join(dir, 'dump.dmp');
    writeFileSync(dumpPath, buildMinidump([join(dir, 'App.app', 'MacOS', 'App')], patch));
    return dumpPath;
  }

  const kindOf = (patch: MinidumpPatch, platform: NodeJS.Platform = 'darwin') =>
    classifyMinidumpCrashKind(writeDump(patch), platform);

  test('the simulated-exception sentinel reads as a non-crash', () => {
    expect(kindOf({ exceptionCode: SIMULATED })).toBe('non-crash');
  });

  test('kMachExceptionFromNSException is a CRASH despite sharing the CP tag', () => {
    // The whole reason the comparison is exact equality. A range or prefix
    // match over the `CP` family would swallow this, and it is a real fatal
    // crash a user would never then be asked to report.
    expect(kindOf({ exceptionCode: FROM_NS_EXCEPTION })).toBe('crash');
  });

  test.each([
    ['EXC_BREAKPOINT', 0x6],
    ['EXC_BAD_ACCESS', 0x1],
    ['SIGSEGV-shaped', 0xb],
    ['zero', 0x0],
    ['one below the sentinel', SIMULATED - 1],
    ['one above the sentinel', SIMULATED + 1],
  ])('%s reads as a crash', (_label, exceptionCode) => {
    expect(kindOf({ exceptionCode })).toBe('crash');
  });

  test('no exception stream alone is indeterminate, never a non-crash', () => {
    // A dump truncated by the very fault that produced it also has no
    // exception stream. Concluding "no crash" from absence would swallow it.
    expect(kindOf({})).toBe('indeterminate');
  });

  test('no exception stream plus the positive marker reads as a non-crash', () => {
    expect(kindOf({ annotations: { 'is-dump-process-without-crashing': 'true' } })).toBe(
      'non-crash',
    );
  });

  test('the marker must actually say true', () => {
    expect(kindOf({ annotations: { 'is-dump-process-without-crashing': 'false' } })).toBe(
      'indeterminate',
    );
  });

  test('an unrelated annotation does not stand in for the marker', () => {
    expect(kindOf({ annotations: { _version: '1.2.3' } })).toBe('indeterminate');
  });

  test('a truncated dump carrying the sentinel is indeterminate, not a non-crash', () => {
    // Truncation must not be readable as absence-of-crash even when the bytes
    // that survived would have said so.
    expect(kindOf({ exceptionCode: SIMULATED, truncateTo: 40 })).toBe('indeterminate');
  });

  test.each([
    ['a bad signature', { signature: 'XXXX', exceptionCode: SIMULATED }],
    ['an unreachable stream directory', { streamDirectoryRva: 0xffff, exceptionCode: SIMULATED }],
    ['an absurd stream count', { streamCount: 0xffff_ffff, exceptionCode: SIMULATED }],
  ])('%s is indeterminate', (_label, patch) => {
    expect(kindOf(patch as MinidumpPatch)).toBe('indeterminate');
  });

  test('a missing file is indeterminate rather than a throw', () => {
    // This runs inside the boot scan; a throw here takes out crash detection.
    expect(classifyMinidumpCrashKind(join(makeDir(), 'absent.dmp'), 'darwin')).toBe(
      'indeterminate',
    );
  });

  test.each<NodeJS.Platform>([
    'linux',
    'win32',
  ])('stays inert on %s even when the dump carries the macOS sentinel', (platform) => {
    // Those platforms' sentinels are known from Crashpad source but have not
    // been measured against a real dump there, so the predicate must not
    // fire. Indeterminate preserves today's behavior exactly.
    expect(kindOf({ exceptionCode: SIMULATED }, platform)).toBe('indeterminate');
  });

  test('reading the crash kind leaves the ownership verdict untouched', () => {
    // Ownership decides whether raw process memory may leave the machine. The
    // two answers are separate exports on separate file handles, and adding an
    // exception stream must not perturb the one that gates attachment.
    const dir = makeDir();
    const bundleRoot = join(dir, 'App.app');
    const dumpPath = join(dir, 'dump.dmp');
    const modulePath = join(bundleRoot, 'Contents', 'MacOS', 'App');
    mkdirSync(join(bundleRoot, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(dumpPath, buildMinidump([modulePath], { exceptionCode: SIMULATED }));
    expect(classifyMinidumpOwnership(dumpPath, bundleRoot)).toBe('ours');
    expect(classifyMinidumpCrashKind(dumpPath, 'darwin')).toBe('non-crash');
  });
});

describe('readMinidumpAccessibilityMode', () => {
  /**
   * The `ax_mode` value a real 0.49.0-beta.30 renderer dump carried, copied
   * exactly — including the cut-off `kExtendedPropert`, which is Crashpad's
   * 64-byte annotation cap and not damage. A fixture that quietly rounded it up
   * to `kExtendedProperties` would stop testing the truncation the parser has
   * to pass through untouched.
   */
  const REAL_AX_MODE = 'kNativeAPIs | kWebContents | kInlineTextBoxes | kExtendedPropert';

  /**
   * The annotation objects beside `ax_mode` in that same dump, in the order
   * Crashpad wrote them, so the lookup is exercised past the first entry and
   * against neighbours that really do sit there.
   */
  const REAL_NEIGHBOURS = {
    max_idle_tasks: '0',
    ax_mode: REAL_AX_MODE,
    renderer_foreground: 'true',
    v8_isolate_address: '0x13400780000',
    process_type: 'renderer',
  };

  function modeOf(patch: MinidumpPatch): string | null {
    const dir = makeDir();
    const dumpPath = join(dir, 'crash.dmp');
    writeFileSync(dumpPath, buildMinidump([ownModule(join(dir, 'OpenKnowledge.app'))], patch));
    const read = readMinidumpAccessibilityMode(dumpPath);
    // Every case below is a dump the parse DECLINES to trust, never one that
    // broke it — the distinction the flag carries. Asserted once here so each
    // case stays a plain value comparison.
    expect(read.parseFailed).toBe(false);
    return read.mode;
  }

  test('a renderer dump names the accessibility mode it died with', () => {
    expect(modeOf({ annotationObjects: [REAL_NEIGHBOURS] })).toBe(REAL_AX_MODE);
  });

  test('the mode is found on a later module, not just the first', () => {
    // Measured on a real dump: the crash keys sit on the framework, and a
    // second link carrying no objects at all sits beside it. A walk that
    // stopped at link 0 would read that dump as having no mode.
    expect(modeOf({ annotationObjects: [{}, REAL_NEIGHBOURS] })).toBe(REAL_AX_MODE);
  });

  test('the simple dictionary is NOT where this lives', () => {
    // The whole reason this parse exists rather than another key passed to
    // `findSimpleAnnotation`. A dump carrying `ax_mode` as a simple annotation
    // is not a shape Chromium produces, and reading it from there would be the
    // parser agreeing with a fiction.
    expect(modeOf({ annotations: { ax_mode: REAL_AX_MODE, _version: '0.58.9' } })).toBeNull();
  });

  test('module annotations and the simple dictionary coexist without interfering', () => {
    // Real dumps carry both structures. Neither may be reached through the
    // other, and neither may cost the other its answer.
    const dir = makeDir();
    const dumpPath = join(dir, 'crash.dmp');
    writeFileSync(
      dumpPath,
      buildMinidump([ownModule(join(dir, 'OpenKnowledge.app'))], {
        annotations: { _productName: 'OpenKnowledge', _version: '0.58.9', ver: '41.9.1' },
        annotationObjects: [REAL_NEIGHBOURS],
      }),
    );
    expect(readMinidumpAccessibilityMode(dumpPath).mode).toBe(REAL_AX_MODE);
    expect(readMinidumpAppVersion(dumpPath).version).toBe('0.58.9');
  });

  test('a utility-process dump has no mode, and that is not "accessibility was off"', () => {
    // Measured shape: a NodeService dump carries `process_type=utility` and
    // simply never registers `ax_mode`. Null is the honest answer; the contract
    // that it must not be read as "off" is on `MinidumpAccessibilityModeRead`.
    expect(
      modeOf({ annotationObjects: [{ process_type: 'utility', chrome_trace_id: '69107426' }] }),
    ).toBeNull();
  });

  test('a dump with no crashpad stream at all has no mode', () => {
    expect(modeOf({})).toBeNull();
  });

  test('a dump registering no module annotations has no mode', () => {
    expect(modeOf({ annotationObjects: [REAL_NEIGHBOURS], crashpadModuleListRva: 0 })).toBeNull();
  });

  test('a module carrying no annotation objects has no mode', () => {
    expect(modeOf({ annotationObjects: [{}] })).toBeNull();
  });

  test('a non-string annotation type is never decoded as text', () => {
    // A value of any other type is raw bytes — v8 addresses and counters live
    // in this same list. Decoding one because its key matched would put
    // arbitrary process bytes on a log line.
    expect(
      modeOf({ annotationObjects: [{ ax_mode: REAL_AX_MODE }], annotationObjectType: 2 }),
    ).toBe(null);
  });

  test('a value carrying a newline is refused rather than printed', () => {
    // The destination is a line-oriented log, and a dump is untrusted input: a
    // value with a line break could forge the context printed around it.
    expect(modeOf({ annotationObjects: [{ ax_mode: 'kNativeAPIs\nevent: forged' }] })).toBeNull();
  });

  test('an object count larger than the list holds is refused', () => {
    expect(
      modeOf({ annotationObjects: [{ ax_mode: REAL_AX_MODE }], annotationObjectCount: 4096 }),
    ).toBeNull();
  });

  test('a declared object-list size too small for its own entries is refused', () => {
    expect(modeOf({ annotationObjects: [REAL_NEIGHBOURS], annotationObjectsSize: 8 })).toBeNull();
  });

  test('a link count larger than the list holds is refused', () => {
    expect(modeOf({ annotationObjects: [REAL_NEIGHBOURS], moduleLinkCount: 4096 })).toBeNull();
  });

  test('a declared link-list size too small for its own links is refused', () => {
    expect(modeOf({ annotationObjects: [REAL_NEIGHBOURS], crashpadModuleListSize: 4 })).toBeNull();
  });

  test('an object-list pointer past the end of the file is refused', () => {
    expect(
      modeOf({ annotationObjects: [REAL_NEIGHBOURS], annotationObjectsRva: 0x7fff_0000 }),
    ).toBeNull();
  });

  // The two lies below land on the FIRST object of the first module, so these
  // cases pass a single-key map — against `REAL_NEIGHBOURS` they would corrupt
  // `max_idle_tasks` and leave `ax_mode` perfectly readable, which is a test
  // that passes while checking nothing.
  test('a value pointer past the end of the file is refused', () => {
    expect(
      modeOf({
        annotationObjects: [{ ax_mode: REAL_AX_MODE }],
        annotationObjectValueRva: 0x7fff_0000,
      }),
    ).toBeNull();
  });

  test('a value length past the annotation ceiling is refused', () => {
    expect(
      modeOf({
        annotationObjects: [{ ax_mode: REAL_AX_MODE }],
        annotationObjectValueByteLength: 4096,
      }),
    ).toBeNull();
  });

  test('a dump truncated before its module annotations has no mode', () => {
    expect(modeOf({ annotationObjects: [REAL_NEIGHBOURS], truncateTo: 80 })).toBeNull();
  });

  test.each([
    ['a bad signature', { signature: 'XXXX' }],
    ['a stream count past the ceiling', { streamCount: 100_000 }],
    ['a stream directory pointing nowhere', { streamDirectoryRva: 0x7fff_0000 }],
    ['a crashpad stream hidden behind another type', { crashpadStreamType: 99 }],
  ])('%s yields no mode and never throws', (_label, patch) => {
    expect(modeOf({ annotationObjects: [REAL_NEIGHBOURS], ...patch })).toBeNull();
  });

  test('reading the mode leaves the ownership verdict untouched', () => {
    // Ownership decides whether raw process memory may leave the machine. This
    // question rides its own file handle precisely so it cannot reach that
    // answer, and adding module annotations must not perturb it.
    const dir = makeDir();
    const bundleRoot = join(dir, 'OpenKnowledge.app');
    const dumpPath = join(dir, 'crash.dmp');
    mkdirSync(join(bundleRoot, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(
      dumpPath,
      buildMinidump([ownModule(bundleRoot)], { annotationObjects: [REAL_NEIGHBOURS] }),
    );
    expect(classifyMinidumpOwnership(dumpPath, bundleRoot)).toBe('ours');
    expect(readMinidumpAccessibilityMode(dumpPath).mode).toBe(REAL_AX_MODE);
  });

  test('an unreadable path declines rather than throwing, and is not a parse failure', () => {
    const absent = join(makeDir(), 'absent.dmp');
    expect(() => readMinidumpAccessibilityMode(absent)).not.toThrow();
    // An absent file is not a broken parser — it is the ordinary state during a
    // scan of a directory Crashpad is also writing to. `parseFailed` exists to
    // separate "this dump has no mode" from "the parser broke", and a flag that
    // fired on every missing file would say neither.
    expect(readMinidumpAccessibilityMode(absent)).toEqual({ mode: null, parseFailed: false });
  });
});
