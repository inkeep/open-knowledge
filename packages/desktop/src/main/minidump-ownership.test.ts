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
  readMinidumpDisplayLockState,
  readMinidumpProcessType,
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

function classifyBytes(bytes: (bundleRoot: string) => Buffer): string {
  const dir = makeDir();
  const bundleRoot = join(dir, 'Applications', 'OpenKnowledge.app');
  const dumpPath = join(dir, 'crash.dmp');
  writeFileSync(dumpPath, bytes(bundleRoot));
  return classifyMinidumpOwnership(dumpPath, bundleRoot);
}

function ownModule(bundleRoot: string): string {
  return join(bundleRoot, 'Contents', 'MacOS', 'OpenKnowledge');
}

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
    expect(
      classifyBytes((root) => buildMinidump([FOREIGN_MODULE, join(root, 'Contents', 'lib.dylib')])),
    ).toBe('foreign');
    expect(classifyBytes((root) => buildMinidump([ownModule(root), FOREIGN_MODULE]))).toBe('ours');
  });

  test('a sibling path sharing the bundle-root prefix is foreign', () => {
    expect(
      classifyBytes((root) => buildMinidump([`${root}.malicious/Contents/MacOS/OpenKnowledge`])),
    ).toBe('foreign');
  });

  test('a relative module name cannot resolve into the bundle', () => {
    expect(classifyBytes(() => buildMinidump(['Contents/MacOS/OpenKnowledge']))).toBe('foreign');
  });

  test('the ModuleList is found behind the streams a real dump puts first', () => {
    expect(classifyBytes((root) => buildMinidump([ownModule(root)], { streamsBefore: 6 }))).toBe(
      'ours',
    );
    expect(classifyBytes(() => buildMinidump([FOREIGN_MODULE], { streamsBefore: 6 }))).toBe(
      'foreign',
    );
  });
});

describe('symlinked launch paths', () => {
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
    const dir = makeDir();
    expect(classifyMinidumpOwnership(join(dir, 'gone.dmp'), join(dir, 'OpenKnowledge.app'))).toBe(
      'unknown',
    );
  });

  test('a directory where a dump should be reads as unknown', () => {
    const dir = makeDir();
    expect(classifyMinidumpOwnership(dir, join(dir, 'OpenKnowledge.app'))).toBe('unknown');
  });
});

describe('crashpad app-version annotations', () => {
  function versionOf(patch: MinidumpPatch): string | null {
    const dir = makeDir();
    const dumpPath = join(dir, 'crash.dmp');
    writeFileSync(dumpPath, buildMinidump([ownModule(join(dir, 'OpenKnowledge.app'))], patch));
    const read = readMinidumpAppVersion(dumpPath);
    expect(read.parseFailed).toBe(false);
    return read.version;
  }

  test('a dump carrying annotations names the version that crashed', () => {
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

  function dictionaryOf(entries: number): Record<string, string> {
    const annotations: Record<string, string> = {};
    for (let i = 0; i < entries - 1; i += 1) annotations[`pad_${i}`] = String(i);
    annotations._version = '0.41.0';
    return annotations;
  }

  test('a dictionary one entry over MAX_ANNOTATIONS is refused', () => {
    expect(versionOf({ annotations: dictionaryOf(257) })).toBeNull();
  });

  test('a dictionary exactly AT MAX_ANNOTATIONS still names the version', () => {
    expect(versionOf({ annotations: dictionaryOf(256) })).toBe('0.41.0');
  });

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
    const forged = `0.41.0${String.fromCharCode(10)}Crash source: something untrue`;
    expect(versionOf({ annotations: { _version: forged } })).toBeNull();
  });

  test('a malformed annotation block leaves ownership intact', () => {
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

    expect(observed).toEqual(
      MALFORMED_CASES.map(({ name, versionSurvives }) => ({
        name,
        version: versionSurvives ? '0.41.0' : null,
      })),
    );
  });

  test('a parse that throws is reported as broken, not as an absent version', async () => {
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
      const mocked = await import('./minidump-ownership.ts');

      expect(mocked.readMinidumpAppVersion(dumpPath)).toEqual({ version: null, parseFailed: true });
      expect(mocked.classifyMinidumpOwnership(dumpPath, bundleRoot)).toBe('ours');
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});

describe('classifyMinidumpCrashKind', () => {
  const SIMULATED = 0x4350_7378;
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
    expect(kindOf({})).toBe('indeterminate');
  });

  test('no exception stream plus the positive marker reads as a non-crash', () => {
    expect(kindOf({ annotations: { 'is-dump-process-without-crashing': 'true' } })).toBe(
      'non-crash',
    );
  });

  function markerDictionaryOf(entries: number): Record<string, string> {
    const annotations: Record<string, string> = {};
    for (let i = 0; i < entries - 1; i += 1) annotations[`pad_${i}`] = String(i);
    annotations['is-dump-process-without-crashing'] = 'true';
    return annotations;
  }

  test('a dictionary one entry over MAX_ANNOTATIONS hides the marker', () => {
    expect(kindOf({ annotations: markerDictionaryOf(257) })).toBe('indeterminate');
  });

  test('a dictionary exactly AT MAX_ANNOTATIONS still finds the marker', () => {
    expect(kindOf({ annotations: markerDictionaryOf(256) })).toBe('non-crash');
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
    expect(classifyMinidumpCrashKind(join(makeDir(), 'absent.dmp'), 'darwin')).toBe(
      'indeterminate',
    );
  });

  test.each<NodeJS.Platform>([
    'linux',
    'win32',
  ])('stays inert on %s even when the dump carries the macOS sentinel', (platform) => {
    expect(kindOf({ exceptionCode: SIMULATED }, platform)).toBe('indeterminate');
  });

  test('reading the crash kind leaves the ownership verdict untouched', () => {
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

describe('readMinidumpProcessType', () => {
  function processTypeOf(patch: MinidumpPatch): string | null {
    const dir = makeDir();
    const dumpPath = join(dir, 'crash.dmp');
    writeFileSync(dumpPath, buildMinidump([ownModule(join(dir, 'OpenKnowledge.app'))], patch));
    const read = readMinidumpProcessType(dumpPath);
    expect(read.parseFailed).toBe(false);
    return read.processType;
  }

  test('a child dump names the process kind in Chromium’s own vocabulary', () => {
    expect(processTypeOf({ annotationObjects: [{ process_type: 'gpu-process' }] })).toBe(
      'gpu-process',
    );
    expect(processTypeOf({ annotationObjects: [{}, { process_type: 'renderer' }] })).toBe(
      'renderer',
    );
  });

  test('a dump carrying no such key says nothing rather than guessing', () => {
    expect(processTypeOf({ annotationObjects: [{ max_idle_tasks: '0' }] })).toBeNull();
  });

  test('the simple dictionary is NOT where this lives either', () => {
    expect(processTypeOf({ annotations: { process_type: 'gpu-process' } })).toBeNull();
  });
});

describe('readMinidumpAccessibilityMode', () => {
  const REAL_AX_MODE = 'kNativeAPIs | kWebContents | kInlineTextBoxes | kExtendedPropert';

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
    expect(read.parseFailed).toBe(false);
    return read.mode;
  }

  test('a renderer dump names the accessibility mode it died with', () => {
    expect(modeOf({ annotationObjects: [REAL_NEIGHBOURS] })).toBe(REAL_AX_MODE);
  });

  test('the mode is found on a later module, not just the first', () => {
    expect(modeOf({ annotationObjects: [{}, REAL_NEIGHBOURS] })).toBe(REAL_AX_MODE);
  });

  test('the simple dictionary is NOT where this lives', () => {
    expect(modeOf({ annotations: { ax_mode: REAL_AX_MODE, _version: '0.58.9' } })).toBeNull();
  });

  test('module annotations and the simple dictionary coexist without interfering', () => {
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
    expect(
      modeOf({ annotationObjects: [{ ax_mode: REAL_AX_MODE }], annotationObjectType: 2 }),
    ).toBe(null);
  });

  test('a value carrying a newline is refused rather than printed', () => {
    expect(modeOf({ annotationObjects: [{ ax_mode: 'kNativeAPIs\nevent: forged' }] })).toBeNull();
  });

  test('an object count larger than the list holds is refused', () => {
    expect(
      modeOf({ annotationObjects: [{ ax_mode: REAL_AX_MODE }], annotationObjectCount: 4096 }),
    ).toBeNull();
  });

  describe('the declared ceilings, pinned by fully-present records', () => {
    function objectsWithAxModeLast(n: number): Record<string, string> {
      const objects: Record<string, string> = {};
      for (let i = 0; i < n - 1; i += 1) objects[`filler_${i}`] = String(i);
      objects.ax_mode = REAL_AX_MODE;
      return objects;
    }

    test('MAX_ANNOTATIONS refuses a module holding one object over the ceiling', () => {
      expect(modeOf({ annotationObjects: [objectsWithAxModeLast(257)] })).toBeNull();
    });

    test('a module exactly AT MAX_ANNOTATIONS still answers', () => {
      expect(modeOf({ annotationObjects: [objectsWithAxModeLast(256)] })).toBe(REAL_AX_MODE);
    });

    function fillerObjects(n: number): Record<string, string> {
      const objects: Record<string, string> = {};
      for (let i = 0; i < n; i += 1) objects[`filler_${i}`] = String(i);
      return objects;
    }

    function objectsWithAxModeFirst(n: number): Record<string, string> {
      const objects: Record<string, string> = { ax_mode: REAL_AX_MODE };
      for (let i = 0; i < n - 1; i += 1) objects[`filler_${i}`] = String(i);
      return objects;
    }

    test('the scan budget answers at exactly its last slot', () => {
      const modules = [
        fillerObjects(256),
        fillerObjects(256),
        fillerObjects(256),
        objectsWithAxModeLast(256),
      ];
      expect(modeOf({ annotationObjects: modules })).toBe(REAL_AX_MODE);
    });

    test('the scan budget refuses one object past its last slot', () => {
      const modules = [
        fillerObjects(256),
        fillerObjects(256),
        fillerObjects(256),
        fillerObjects(256),
        objectsWithAxModeFirst(256),
      ];
      expect(modeOf({ annotationObjects: modules })).toBeNull();
    });

    test('the scan budget stops PARTWAY through a module, not only between them', () => {
      const modules = [
        fillerObjects(200),
        fillerObjects(256),
        fillerObjects(256),
        fillerObjects(256),
        objectsWithAxModeLast(256),
      ];
      expect(modeOf({ annotationObjects: modules })).toBeNull();
    });

    test('MAX_MODULE_LINKS refuses a link list longer than the ceiling', () => {
      const modules = Array.from({ length: 4097 }, () => ({}) as Record<string, string>);
      modules[4096] = { ax_mode: REAL_AX_MODE };
      expect(modeOf({ annotationObjects: modules })).toBeNull();
    });

    test('a link list exactly AT MAX_MODULE_LINKS still answers', () => {
      const modules = Array.from({ length: 4096 }, () => ({}) as Record<string, string>);
      modules[4095] = { ax_mode: REAL_AX_MODE };
      expect(modeOf({ annotationObjects: modules })).toBe(REAL_AX_MODE);
    });

    test('a walk that stays inside the budget still answers from the last module', () => {
      const modules = [250, 250, 250].map((n, i) =>
        i === 2 ? objectsWithAxModeLast(n) : objectsWithAxModeLast(n + 1),
      );
      modules.slice(0, 2).forEach((m) => {
        delete m.ax_mode;
      });
      expect(modeOf({ annotationObjects: modules })).toBe(REAL_AX_MODE);
    });
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
    expect(readMinidumpAccessibilityMode(absent)).toEqual({ mode: null, parseFailed: false });
  });
});

describe('readMinidumpDisplayLockState', () => {
  const REAL_STATE = 'v1 lock=1 f=1 n=12 s=0';

  function stateOf(patch: MinidumpPatch): string | null {
    const dir = makeDir();
    const dumpPath = join(dir, 'crash.dmp');
    writeFileSync(dumpPath, buildMinidump([ownModule(join(dir, 'OpenKnowledge.app'))], patch));
    const read = readMinidumpDisplayLockState(dumpPath);
    expect(read.parseFailed).toBe(false);
    return read.state;
  }

  test('a renderer dump names the display-lock state it died with', () => {
    expect(stateOf({ annotationObjects: [{ ok_display_lock: REAL_STATE }] })).toBe(REAL_STATE);
  });

  test('a dump from a renderer that never published one has no state', () => {
    expect(stateOf({ annotationObjects: [{ process_type: 'renderer' }] })).toBeNull();
  });

  test('the state is found on a later module, not just the first', () => {
    expect(stateOf({ annotationObjects: [{}, { ok_display_lock: REAL_STATE }] })).toBe(REAL_STATE);
  });

  test('a missing dump reads as no state rather than as a broken parser', () => {
    expect(readMinidumpDisplayLockState(join(makeDir(), 'nope.dmp'))).toEqual({
      state: null,
      parseFailed: false,
    });
  });

  test('reading the display lock does not cost the accessibility mode its answer', () => {
    const dir = makeDir();
    const dumpPath = join(dir, 'crash.dmp');
    const axMode = 'kNativeAPIs | kWebContents';
    writeFileSync(
      dumpPath,
      buildMinidump([ownModule(join(dir, 'OpenKnowledge.app'))], {
        annotations: { _productName: 'OpenKnowledge', _version: '0.62.1' },
        annotationObjects: [{ ax_mode: axMode, ok_display_lock: REAL_STATE }],
      }),
    );
    expect(readMinidumpDisplayLockState(dumpPath).state).toBe(REAL_STATE);
    expect(readMinidumpAccessibilityMode(dumpPath).mode).toBe(axMode);
  });
});
