import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { buildMinidump, type MinidumpPatch } from '../../../src/main/minidump.test-helper.ts';
import {
  type AppProcess,
  type CrashDumpTestInfo,
  type CrashDumpVerdict,
  type CrashDumpWatch,
  collectCrashDumps,
  crashDumpsSince,
  crashDumpVerdict,
  crashDumpWatchFor,
  failIfEarlierAttemptFoundCrashDump,
  type ProcessTableRead,
  processRoleOf,
  type QuitObservation,
  readCrashDumpFacts,
  runningAppProcesses,
} from './crash-dumps';

const QUIT_REQUESTED_AT_MS = Date.parse('2026-09-22T15:30:19.277Z');
const ACCESS_VIOLATION = 0xc000_0005;
const DARWIN_SIMULATED_DUMP = 0x4350_7378;
const EXCEPTION_STREAM_BYTES = 168;
const NTDLL = { base: 0x7ffa_1000_0000n, size: 0x20_0000 };
const ELECTRON_IMAGE = { base: 0x7ff6_0000_0000n, size: 0x1000_0000 };
const PNPM_CONPTY_ADDON =
  'D:\\a\\agents-private\\node_modules\\.pnpm\\node-pty@1.2.0-beta.15\\node_modules\\node-pty\\prebuilds\\win32-x64\\conpty.node';
const PNPM_CONPTY_DLL =
  'D:\\a\\agents-private\\node_modules\\.pnpm\\node-pty@1.2.0-beta.15\\node_modules\\node-pty\\prebuilds\\win32-x64\\conpty\\conpty.dll';
const PARCEL_WATCHER_ADDON =
  'D:\\a\\agents-private\\node_modules\\.pnpm\\@parcel+watcher-win32-x64@2.5.6\\node_modules\\@parcel\\watcher-win32-x64\\watcher.node';
const TERMINAL_HOST: AppProcess = {
  pid: 5678,
  type: 'Utility',
  serviceName: 'OpenKnowledge Terminal Host 1',
  name: 'OpenKnowledge Terminal Host 1',
  creationTime: QUIT_REQUESTED_AT_MS - 5_300,
};
const PROJECT_SERVER: AppProcess = {
  pid: 4321,
  type: 'Utility',
  serviceName: 'OpenKnowledge Project Server 1',
  name: 'OpenKnowledge Project Server 1',
  creationTime: QUIT_REQUESTED_AT_MS - 18_000,
};
const OBSERVATION: QuitObservation = {
  processes: [TERMINAL_HOST, PROJECT_SERVER],
  quitRequestedAtMs: QUIT_REQUESTED_AT_MS,
};

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface CrashpadFixture {
  crashDumps: string;
  mainModule: string;
  watch(platform?: NodeJS.Platform): CrashDumpWatch;
  writeDump(relativePath: string, bytes: Buffer, mtimeMs: number): string;
}

function crashpadFixture(executable: (bundleRoot: string) => string): CrashpadFixture {
  const root = mkdtempSync(join(tmpdir(), 'ok-crash-dumps-'));
  tmpDirs.push(root);
  const crashDumps = join(root, 'electron-userdata', 'Crashpad');
  mkdirSync(crashDumps, { recursive: true });
  const mainModule = executable(join(root, 'electron-dist'));
  return {
    crashDumps,
    mainModule,
    watch: (platform = 'win32') => crashDumpWatchFor(crashDumps, mainModule, platform),
    writeDump(relativePath, bytes, mtimeMs) {
      const path = join(crashDumps, relativePath);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, bytes);
      utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
      return path;
    },
  };
}

function windowsFixture(): CrashpadFixture {
  return crashpadFixture((bundleRoot) => join(bundleRoot, 'electron.exe'));
}

function utilityDump(mainModule: string, extraModules: string[], patch: MinidumpPatch): Buffer {
  return buildMinidump([mainModule, ...extraModules], {
    annotationObjects: [{ process_type: 'utility' }],
    ...patch,
  });
}

function verdictFor(watch: CrashDumpWatch): CrashDumpVerdict {
  return crashDumpVerdict(crashDumpsSince(watch), OBSERVATION, watch.platform);
}

describe('readCrashDumpFacts', () => {
  test('lists every loaded module with its image range, not only the main module', () => {
    const fixture = windowsFixture();
    const path = fixture.writeDump(
      'reports/facts.dmp',
      buildMinidump(
        ['C:\\app\\electron.exe', 'C:\\Windows\\System32\\ntdll.dll', PNPM_CONPTY_ADDON],
        {
          moduleImages: [ELECTRON_IMAGE, NTDLL, { base: 0x7ff9_2000_0000n, size: 0x4_0000 }],
        },
      ),
      QUIT_REQUESTED_AT_MS,
    );

    expect(readCrashDumpFacts(path).modules).toEqual([
      { path: 'C:\\app\\electron.exe', base: ELECTRON_IMAGE.base, size: ELECTRON_IMAGE.size },
      { path: 'C:\\Windows\\System32\\ntdll.dll', base: NTDLL.base, size: NTDLL.size },
      { path: PNPM_CONPTY_ADDON, base: 0x7ff9_2000_0000n, size: 0x4_0000 },
    ]);
  });

  test('reads the exception record, the process id and creation time, and the write time', () => {
    const fixture = windowsFixture();
    const path = fixture.writeDump(
      'reports/exception.dmp',
      buildMinidump(['C:\\app\\electron.exe'], {
        exceptionCode: ACCESS_VIOLATION,
        exceptionFlags: 1,
        exceptionAddress: NTDLL.base + 0x1234n,
        exceptionThreadId: 4242,
        miscInfo: { processId: 5678, processCreateTime: 1_790_091_014 },
        timeDateStamp: 1_790_091_019,
      }),
      QUIT_REQUESTED_AT_MS,
    );

    const facts = readCrashDumpFacts(path);
    expect(facts.exception).toEqual({
      code: ACCESS_VIOLATION,
      flags: 1,
      address: NTDLL.base + 0x1234n,
      threadId: 4242,
    });
    expect(facts.processId).toBe(5678);
    expect(facts.processCreatedAtSec).toBe(1_790_091_014);
    expect(facts.writtenAtSec).toBe(1_790_091_019);
    expect(facts.unreadable).toBeNull();
  });

  test('a process id MISC_INFO does not mark as valid is not reported', () => {
    const fixture = windowsFixture();
    const path = fixture.writeDump(
      'reports/misc.dmp',
      buildMinidump(['C:\\app\\electron.exe'], { miscInfo: { processCreateTime: 1_790_091_014 } }),
      QUIT_REQUESTED_AT_MS,
    );

    const facts = readCrashDumpFacts(path);
    expect(facts.processCreatedAtSec).toBe(1_790_091_014);
    expect(facts.processId).toBeNull();
  });

  test('reads the simple dictionary and the string annotation objects of every module', () => {
    const fixture = windowsFixture();
    const path = fixture.writeDump(
      'reports/annotations.dmp',
      buildMinidump(['C:\\app\\electron.exe'], {
        annotations: { _productName: 'OpenKnowledge', _version: '0.77.9' },
        annotationObjects: [
          { ignored_binary: 'x', first: 'kept' },
          { process_type: 'utility', 'switch-1': '--type=utility' },
        ],
        annotationObjectType: 2,
      }),
      QUIT_REQUESTED_AT_MS,
    );

    expect(readCrashDumpFacts(path).annotations).toEqual([
      { key: '_productName', value: 'OpenKnowledge', source: 'simple' },
      { key: '_version', value: '0.77.9', source: 'simple' },
      { key: 'first', value: 'kept', source: 'module' },
      { key: 'process_type', value: 'utility', source: 'module' },
      { key: 'switch-1', value: '--type=utility', source: 'module' },
    ]);
  });

  test.each<[string, (fixture: CrashpadFixture) => string]>([
    ['a missing file', (fixture) => join(fixture.crashDumps, 'reports', 'gone.dmp')],
    [
      'an empty file',
      (fixture) => fixture.writeDump('reports/empty.dmp', Buffer.alloc(0), QUIT_REQUESTED_AT_MS),
    ],
    [
      'a file without the minidump signature',
      (fixture) =>
        fixture.writeDump(
          'reports/text.dmp',
          buildMinidump(['C:\\app\\electron.exe'], { signature: 'XXXX' }),
          QUIT_REQUESTED_AT_MS,
        ),
    ],
  ])('%s is reported as unreadable rather than throwing', (_label, pathOf) => {
    const facts = readCrashDumpFacts(pathOf(windowsFixture()));
    expect(facts.unreadable).not.toBeNull();
    expect(facts.modules).toEqual([]);
  });

  test('a dump cut off inside its exception record keeps the modules and drops the record', () => {
    const fixture = windowsFixture();
    const whole = buildMinidump(['C:\\app\\electron.exe', 'C:\\Windows\\System32\\ntdll.dll'], {
      exceptionCode: ACCESS_VIOLATION,
    });
    const path = fixture.writeDump(
      'reports/cut.dmp',
      whole.subarray(0, whole.length - EXCEPTION_STREAM_BYTES + 4),
      QUIT_REQUESTED_AT_MS,
    );

    const facts = readCrashDumpFacts(path);
    expect(facts.modules.map((module) => module.path)).toEqual([
      'C:\\app\\electron.exe',
      'C:\\Windows\\System32\\ntdll.dll',
    ]);
    expect(facts.exception).toBeNull();
  });
});

describe('processRoleOf', () => {
  test.each([
    ['the pnpm development layout', PNPM_CONPTY_ADDON],
    [
      'the packaged Windows layout',
      'C:\\Users\\me\\AppData\\Local\\Programs\\OpenKnowledge\\resources\\app.asar.unpacked\\node_modules\\node-pty\\prebuilds\\win32-x64\\conpty.node',
    ],
    [
      'a macOS build of the addon',
      '/Applications/OpenKnowledge.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
    ],
  ])('a process with node-pty’s terminal addon from %s is the pty-host', (_layout, addon) => {
    const fixture = windowsFixture();
    const path = fixture.writeDump(
      'reports/role.dmp',
      buildMinidump(['C:\\app\\electron.exe', addon]),
      QUIT_REQUESTED_AT_MS,
    );
    expect(processRoleOf(readCrashDumpFacts(path))).toMatch(/^pty-host/);
  });

  test('the console-list agent node-pty forks on kill is told apart from the pty-host', () => {
    const fixture = windowsFixture();
    const path = fixture.writeDump(
      'reports/agent.dmp',
      buildMinidump([
        'C:\\app\\electron.exe',
        PNPM_CONPTY_ADDON.replace('conpty.node', 'conpty_console_list.node'),
      ]),
      QUIT_REQUESTED_AT_MS,
    );
    expect(processRoleOf(readCrashDumpFacts(path))).toBe('node-pty console-list agent');
  });

  test('a process with @parcel/watcher and no node-pty addon is the project server', () => {
    const fixture = windowsFixture();
    const path = fixture.writeDump(
      'reports/server.dmp',
      buildMinidump(['C:\\app\\electron.exe', PARCEL_WATCHER_ADDON]),
      QUIT_REQUESTED_AT_MS,
    );
    expect(processRoleOf(readCrashDumpFacts(path))).toMatch(/^project server/);
  });

  test('a module merely named like the addon outside node-pty identifies nothing', () => {
    const fixture = windowsFixture();
    const path = fixture.writeDump(
      'reports/lookalike.dmp',
      buildMinidump(['C:\\app\\electron.exe', 'C:\\Tools\\conpty.node']),
      QUIT_REQUESTED_AT_MS,
    );
    expect(processRoleOf(readCrashDumpFacts(path))).toBe('no identifying addon loaded');
  });
});

describe('crashDumpVerdict names the process a clean quit crashed', () => {
  test('the pty-host is named by its pid, its node-pty addon, its exception and faulting module', () => {
    const fixture = windowsFixture();
    const watch = fixture.watch();
    fixture.writeDump(
      'reports/8c1f.dmp',
      utilityDump(
        fixture.mainModule,
        ['C:\\Windows\\System32\\ntdll.dll', PNPM_CONPTY_ADDON, PNPM_CONPTY_DLL],
        {
          moduleImages: [
            ELECTRON_IMAGE,
            NTDLL,
            { base: 0x7ff9_2000_0000n, size: 0x4_0000 },
            { base: 0x7ff9_3000_0000n, size: 0x10_0000 },
          ],
          exceptionCode: ACCESS_VIOLATION,
          exceptionAddress: NTDLL.base + 0x9abcn,
          miscInfo: { processId: TERMINAL_HOST.pid },
        },
      ),
      QUIT_REQUESTED_AT_MS + 463,
    );

    const verdict = verdictFor(watch);
    expect(verdict.crashes).toHaveLength(1);
    expect(verdict.headline).toBe(
      'the quit left 1 crash dump(s) from the app; first: ' +
        'pid 5678 Utility "OpenKnowledge Terminal Host 1"; pty-host (node-pty terminal addon loaded); ' +
        'exception 0xC0000005 EXCEPTION_ACCESS_VIOLATION at 0x7FFA10009ABC in ntdll.dll; ' +
        'written 463 ms after quit was requested',
    );
    expect(verdict.lines[0]).toContain('process_type=utility');
    expect(verdict.lines[0]).toContain('native addons: node-pty/conpty.node, node-pty/conpty.dll');
    expect(verdict.lines[0]).toContain('main module electron.exe');
  });

  test('the project server is named by its addon even when the pid was not in the snapshot', () => {
    const fixture = windowsFixture();
    const watch = fixture.watch();
    fixture.writeDump(
      'reports/2d40.dmp',
      utilityDump(fixture.mainModule, [PARCEL_WATCHER_ADDON], {
        exceptionCode: 0xc000_0409,
        miscInfo: { processId: 999 },
      }),
      QUIT_REQUESTED_AT_MS - 1_500,
    );

    const { headline } = verdictFor(watch);
    expect(headline).toContain('pid 999 (not among the app processes listed before quit)');
    expect(headline).toContain('project server (@parcel/watcher addon loaded)');
    expect(headline).toContain('0xC0000409 STATUS_STACK_BUFFER_OVERRUN');
    expect(headline).toContain('written 1500 ms before quit was requested');
  });

  test('an exception address one past a module image is not attributed to that module', () => {
    const fixture = windowsFixture();
    const watch = fixture.watch();
    fixture.writeDump(
      'reports/edge.dmp',
      utilityDump(fixture.mainModule, ['C:\\Windows\\System32\\ntdll.dll'], {
        moduleImages: [ELECTRON_IMAGE, NTDLL],
        exceptionCode: ACCESS_VIOLATION,
        exceptionAddress: NTDLL.base + BigInt(NTDLL.size),
      }),
      QUIT_REQUESTED_AT_MS,
    );

    expect(verdictFor(watch).headline).toContain('outside every listed module');
  });
});

describe('crashDumpsSince decides which dumps count against the quit', () => {
  test('a new owned dump counts; the baseline and a foreign dump do not', () => {
    const fixture = windowsFixture();
    fixture.writeDump(
      'reports/old.dmp',
      utilityDump(fixture.mainModule, [], {}),
      QUIT_REQUESTED_AT_MS - 60_000,
    );
    const watch = fixture.watch();
    const owned = fixture.writeDump(
      'reports/new.dmp',
      utilityDump(fixture.mainModule, [], {}),
      QUIT_REQUESTED_AT_MS + 10,
    );
    const foreign = fixture.writeDump(
      'reports/foreign.dmp',
      buildMinidump(['C:\\Program Files\\PowerShell\\7\\pwsh.exe']),
      QUIT_REQUESTED_AT_MS + 20,
    );

    const findings = crashDumpsSince(watch);
    expect(findings.map((finding) => [finding.path, finding.countsAsCrash])).toEqual([
      [owned, true],
      [foreign, false],
    ]);
  });

  test('a dump whose main module cannot be read still counts as a crash from the app', () => {
    const fixture = windowsFixture();
    const watch = fixture.watch();
    const unreadable = fixture.writeDump(
      'reports/unknown.dmp',
      buildMinidump([fixture.mainModule], { nameByteLength: 3 }),
      QUIT_REQUESTED_AT_MS,
    );

    expect(crashDumpsSince(watch).map((finding) => [finding.path, finding.ownership])).toEqual([
      [unreadable, 'unknown'],
    ]);
    expect(verdictFor(watch).crashes).toHaveLength(1);
  });

  test('a baseline dump rewritten after the watch began counts again', () => {
    const fixture = windowsFixture();
    const path = fixture.writeDump(
      'reports/rewritten.dmp',
      utilityDump(fixture.mainModule, [], {}),
      QUIT_REQUESTED_AT_MS - 60_000,
    );
    const watch = fixture.watch();
    utimesSync(path, new Date(QUIT_REQUESTED_AT_MS + 5), new Date(QUIT_REQUESTED_AT_MS + 5));

    expect(crashDumpsSince(watch).map((finding) => finding.path)).toEqual([path]);
  });

  test('a macOS dump written without crashing does not count; one from a crash does', () => {
    const fixture = crashpadFixture((bundleRoot) =>
      join(bundleRoot, 'OpenKnowledge.app', 'Contents', 'MacOS', 'OpenKnowledge'),
    );
    const watch = fixture.watch('darwin');
    fixture.writeDump(
      'completed/simulated.dmp',
      buildMinidump([fixture.mainModule], { exceptionCode: DARWIN_SIMULATED_DUMP }),
      QUIT_REQUESTED_AT_MS,
    );
    const crashed = fixture.writeDump(
      'pending/crashed.dmp',
      buildMinidump([fixture.mainModule], { exceptionCode: 1 }),
      QUIT_REQUESTED_AT_MS + 1,
    );

    expect(verdictFor(watch).crashes.map((finding) => finding.path)).toEqual([crashed]);
  });

  test('a crash directory that never appeared yields no findings and a clean verdict', () => {
    const fixture = windowsFixture();
    const watch = crashDumpWatchFor(
      join(fixture.crashDumps, 'never-created'),
      fixture.mainModule,
      'win32',
    );

    const verdict = verdictFor(watch);
    expect(verdict.findings).toEqual([]);
    expect(verdict.lines).toEqual([]);
    expect(verdict.headline).toBe('the quit left no crash dump from the app');
  });

  test('a crash directory that cannot be read after the watch began fails the scan instead of yielding a clean verdict', () => {
    const fixture = windowsFixture();
    const watch = fixture.watch();
    rmSync(fixture.crashDumps, { recursive: true });
    writeFileSync(fixture.crashDumps, '');

    expect(() => verdictFor(watch)).toThrow(/ENOTDIR/);
  });

  test.skipIf(process.platform === 'win32')(
    'a dump whose metadata cannot be read after the watch began fails the scan instead of being dropped',
    () => {
      const fixture = windowsFixture();
      const watch = fixture.watch();
      const reports = join(fixture.crashDumps, 'reports');
      mkdirSync(reports);
      symlinkSync(join(reports, 'loop.dmp'), join(reports, 'loop.dmp'));

      expect(() => verdictFor(watch)).toThrow(/ELOOP/);
    },
  );
});

describe('collectCrashDumps', () => {
  interface Attached {
    name: string;
    path?: string;
    body?: string | Buffer;
    contentType?: string;
  }

  function verdictOutputDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ok-crash-verdicts-'));
    tmpDirs.push(dir);
    return dir;
  }

  function recorder(
    testId = 'collect-crash-dumps',
    outputDir = verdictOutputDir(),
  ): CrashDumpTestInfo & { attached: Attached[] } {
    const attached: Attached[] = [];
    return {
      attached,
      testId,
      project: { outputDir },
      attach: async (name, options = {}) => {
        attached.push({ name, ...options });
      },
    };
  }

  test('keeps each crash dump file from the app and the facts of every new dump as evidence', async () => {
    const fixture = windowsFixture();
    const watch = fixture.watch();
    const owned = fixture.writeDump(
      'reports/kept.dmp',
      utilityDump(fixture.mainModule, [PNPM_CONPTY_ADDON], {
        miscInfo: { processId: TERMINAL_HOST.pid },
      }),
      QUIT_REQUESTED_AT_MS + 7,
    );
    fixture.writeDump(
      'reports/foreign.dmp',
      buildMinidump(['C:\\Program Files\\PowerShell\\7\\pwsh.exe']),
      QUIT_REQUESTED_AT_MS + 8,
    );
    const sink = recorder();

    const verdict = await collectCrashDumps(watch, OBSERVATION, sink);

    expect(verdict.crashes.map((finding) => finding.path)).toEqual([owned]);
    expect(sink.attached.map((entry) => [entry.name, entry.path ?? null])).toEqual([
      ['crash-dump-facts', null],
      ['crash-dump-1', owned],
    ]);
    const facts = JSON.parse(String(sink.attached[0]?.body));
    expect(
      facts.dumps.map((dump: { file: string; role: string; processId: number | null }) => [
        dump.file,
        dump.role,
        dump.processId,
      ]),
    ).toEqual([
      ['kept.dmp', 'pty-host (node-pty terminal addon loaded)', TERMINAL_HOST.pid],
      ['foreign.dmp', 'no identifying addon loaded', null],
    ]);
    expect(facts.processesBeforeQuit).toEqual([TERMINAL_HOST, PROJECT_SERVER]);
  });

  test('attaches nothing when the quit wrote no dump', async () => {
    const fixture = windowsFixture();
    const sink = recorder();

    const verdict = await collectCrashDumps(fixture.watch(), OBSERVATION, sink);

    expect(verdict.findings).toEqual([]);
    expect(sink.attached).toEqual([]);
  });

  describe('a crash dump found on one attempt of a test', () => {
    function writeAppCrashDump(fixture: CrashpadFixture): void {
      fixture.writeDump(
        'reports/app-crash.dmp',
        utilityDump(fixture.mainModule, [PARCEL_WATCHER_ADDON], {
          miscInfo: { processId: PROJECT_SERVER.pid },
        }),
        QUIT_REQUESTED_AT_MS + 344,
      );
    }

    test('fails every later attempt of that test with the recorded finding', async () => {
      const fixture = windowsFixture();
      const watch = fixture.watch();
      writeAppCrashDump(fixture);
      const outputDir = verdictOutputDir();

      const verdict = await collectCrashDumps(
        watch,
        OBSERVATION,
        recorder('restart-test', outputDir),
      );

      expect(verdict.crashes).toHaveLength(1);
      for (const laterAttempt of [1, 2]) {
        expect(
          () => failIfEarlierAttemptFoundCrashDump(recorder('restart-test', outputDir)),
          `attempt ${laterAttempt}`,
        ).toThrow(verdict.headline);
      }
    });

    test('still fails later attempts when its record cannot be read', async () => {
      const fixture = windowsFixture();
      const watch = fixture.watch();
      writeAppCrashDump(fixture);
      const outputDir = verdictOutputDir();
      await collectCrashDumps(watch, OBSERVATION, recorder('restart-test', outputDir));
      const records = readdirSync(outputDir, { recursive: true, withFileTypes: true }).filter(
        (entry) => entry.isFile(),
      );
      expect(records).not.toEqual([]);
      for (const record of records) {
        const recordPath = join(record.parentPath, record.name);
        rmSync(recordPath);
        mkdirSync(recordPath);
      }

      expect(() => failIfEarlierAttemptFoundCrashDump(recorder('restart-test', outputDir))).toThrow(
        /EISDIR/,
      );
    });

    test('leaves later attempts free to pass when the attempt found no dump', async () => {
      const fixture = windowsFixture();
      const outputDir = verdictOutputDir();

      await collectCrashDumps(fixture.watch(), OBSERVATION, recorder('restart-test', outputDir));

      expect(() =>
        failIfEarlierAttemptFoundCrashDump(recorder('restart-test', outputDir)),
      ).not.toThrow();
    });

    test('never reaches another test that shares the output directory', async () => {
      const fixture = windowsFixture();
      const watch = fixture.watch();
      writeAppCrashDump(fixture);
      const outputDir = verdictOutputDir();

      await collectCrashDumps(watch, OBSERVATION, recorder('clean-quit-1', outputDir));

      expect(() =>
        failIfEarlierAttemptFoundCrashDump(recorder('clean-quit-2', outputDir)),
      ).not.toThrow();
      expect(() =>
        failIfEarlierAttemptFoundCrashDump(recorder('clean-quit-1', outputDir)),
      ).toThrow();
    });

    test('does not stick when the only dump is foreign', async () => {
      const fixture = windowsFixture();
      const watch = fixture.watch();
      fixture.writeDump(
        'reports/foreign.dmp',
        buildMinidump(['C:\\Program Files\\PowerShell\\7\\pwsh.exe']),
        QUIT_REQUESTED_AT_MS + 8,
      );
      const outputDir = verdictOutputDir();

      const verdict = await collectCrashDumps(
        watch,
        OBSERVATION,
        recorder('restart-test', outputDir),
      );

      expect(verdict.findings).toHaveLength(1);
      expect(verdict.crashes).toEqual([]);
      expect(() =>
        failIfEarlierAttemptFoundCrashDump(recorder('restart-test', outputDir)),
      ).not.toThrow();
    });
  });
});

describe('runningAppProcesses', () => {
  const table = (read: ProcessTableRead) => (): ProcessTableRead => read;

  test('reads the Windows process table and keeps only the app processes still listed', () => {
    const tasklist = [
      '"System Idle Process","0","Services","0","8 K"',
      `"electron.exe","${TERMINAL_HOST.pid}","Console","1","41,220 K"`,
      '"pwsh.exe","9999","Console","1","80,100 K"',
    ].join('\r\n');

    expect(
      runningAppProcesses([TERMINAL_HOST, PROJECT_SERVER], {
        platform: 'win32',
        read: table({ status: 0, stdout: tasklist }),
      }),
    ).toEqual([TERMINAL_HOST]);
  });

  test('ps finding none of the pids means every app process has exited', () => {
    expect(
      runningAppProcesses([TERMINAL_HOST, PROJECT_SERVER], {
        platform: 'linux',
        read: table({ status: 1, stdout: '' }),
      }),
    ).toEqual([]);
  });

  test('a process table that cannot be read leaves every app process counted as running', () => {
    expect(
      runningAppProcesses([TERMINAL_HOST, PROJECT_SERVER], {
        platform: 'win32',
        read: table({ status: null, stdout: '' }),
      }),
    ).toEqual([TERMINAL_HOST, PROJECT_SERVER]);
  });

  test('a Windows process table that exits 0 with no row it can parse leaves every app process counted as running', () => {
    for (const stdout of ['', 'INFO: No tasks are running which match the specified criteria.']) {
      expect(
        runningAppProcesses([TERMINAL_HOST, PROJECT_SERVER], {
          platform: 'win32',
          read: table({ status: 0, stdout }),
        }),
      ).toEqual([TERMINAL_HOST, PROJECT_SERVER]);
    }
  });

  test('the real process table lists this process and not a child that already exited', () => {
    const exited = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
    expect(exited.status).toBe(0);
    const self: AppProcess = { ...TERMINAL_HOST, pid: process.pid };
    const gone: AppProcess = { ...PROJECT_SERVER, pid: exited.pid };

    expect(runningAppProcesses([self, gone])).toEqual([self]);
  });
});
