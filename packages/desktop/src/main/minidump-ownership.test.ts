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
import { afterEach, describe, expect, test } from 'vitest';
import { buildMinidump, type MinidumpPatch } from './minidump.test-helper.ts';
import { classifyMinidumpOwnership } from './minidump-ownership.ts';

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
 */
const MALFORMED_CASES: Array<{ name: string; patch: MinidumpPatch }> = [
  { name: 'a wrong header magic', patch: { signature: 'XXXX' } },
  { name: 'a header truncated mid-field', patch: { truncateTo: 20 } },
  {
    name: 'a stream-directory RVA past the end of the file',
    patch: { streamDirectoryRva: 0xffff },
  },
  { name: 'a stream count beyond the parser cap', patch: { streamCount: 100_000 } },
  { name: 'a stream count of zero', patch: { streamCount: 0 } },
  { name: 'a directory holding no ModuleList stream', patch: { streamType: 7 } },
  { name: 'a ModuleList RVA past the end of the file', patch: { moduleListRva: 0xffff } },
  { name: 'a module count of zero', patch: { moduleCount: 0 } },
  // The ModuleList count sits at 44..48 and the first 108-byte record follows,
  // so cutting at 60 leaves the record short.
  { name: 'a first module record cut short by the file end', patch: { truncateTo: 60 } },
  { name: 'a module-name RVA past the end of the file', patch: { nameRva: 0xffff } },
  { name: 'a name byte length of zero', patch: { nameByteLength: 0 } },
  { name: 'an odd name byte length (never valid UTF-16)', patch: { nameByteLength: 9 } },
  { name: 'a name byte length beyond the parser cap', patch: { nameByteLength: 1_000_000 } },
  // Even and under the cap, but longer than the bytes actually present.
  { name: 'a name that overruns the end of the file', patch: { nameByteLength: 4096 } },
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
