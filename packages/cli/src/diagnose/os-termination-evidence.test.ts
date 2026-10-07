import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  type CommandResult,
  collectOsTerminationEvidence,
  createRunCommand,
  describeOsTerminationEvidence,
  LINUX_JOURNAL_GREP,
  parseJetsamReport,
  renderOsTerminationEvidence,
  windowsEventLogArgs,
  windowsEventLogExecutable,
} from './os-termination-evidence.ts';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function makeTmpDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'ok-os-termination-test-'));
  tmpDirs.push(dir);
  return dir;
}

const NOW = new Date('2026-10-05T12:00:00.000Z');

function jetsamReport(processes: Record<string, unknown>[], largestProcess = 'fseventsd'): string {
  const header = { bug_type: '298', timestamp: '2026-10-04 17:14:39.00 -0700' };
  const body = { largestProcess, memoryStatus: { pageSize: 16384 }, processes };
  return `${JSON.stringify(header)}\n${JSON.stringify(body, null, 2)}`;
}

function writeAged(dir: string, name: string, content: string, daysOld: number): void {
  const path = join(dir, name);
  writeFileSync(path, content);
  const at = new Date(NOW.getTime() - daysOld * 24 * 60 * 60 * 1000);
  utimesSync(path, at, at);
}

describe('parseJetsamReport', () => {
  test('keeps only this app’s processes and carries the kill reason jetsam recorded', () => {
    const event = parseJetsamReport(
      'JetsamEvent-a.ips',
      jetsamReport(
        [
          {
            name: 'OpenKnowledge',
            pid: 4406,
            rpages: 900,
            lifetimeMax: 1200,
            reason: 'vm-pageshortage',
          },
          { name: 'OpenKnowledge Helper (Renderer)', pid: 4410, rpages: 50, lifetimeMax: 60 },
          { name: 'Slack', pid: 77, rpages: 9000, reason: 'per-process-limit' },
          { name: 'OpenKnowledgeImpostor', pid: 5 },
        ],
        'OpenKnowledge',
      ),
    );

    expect(event).toEqual({
      kind: 'jetsam',
      at: '2026-10-05T00:14:39.000Z',
      file: 'JetsamEvent-a.ips',
      pageSize: 16384,
      largestProcessOwned: true,
      ownedProcesses: [
        {
          name: 'OpenKnowledge',
          pid: 4406,
          killReason: 'vm-pageshortage',
          residentPages: 900,
          lifetimeMaxPages: 1200,
        },
        {
          name: 'OpenKnowledge Helper (Renderer)',
          pid: 4410,
          killReason: null,
          residentPages: 50,
          lifetimeMaxPages: 60,
        },
      ],
    });
  });

  test('rejects a report that is not a header line followed by a JSON body', () => {
    expect(parseJetsamReport('x.ips', '{"bug_type":"298"}')).toBeNull();
    expect(parseJetsamReport('x.ips', '{"bug_type":"298"}\nnot json')).toBeNull();
    expect(parseJetsamReport('x.ips', '{"bug_type":"298"}\n{"processes":3}')).toBeNull();
  });
});

describe('macOS jetsam collection', () => {
  test('collects in-window events naming this app and counts the rest', async () => {
    const dir = makeTmpDir();
    writeAged(dir, 'JetsamEvent-owned.ips', jetsamReport([{ name: 'OpenKnowledge', pid: 1 }]), 1);
    writeAged(dir, 'JetsamEvent-foreign.ips', jetsamReport([{ name: 'Slack', pid: 2 }]), 1);
    writeAged(dir, 'JetsamEvent-garbage.ips', 'garbage', 1);
    writeAged(dir, 'JetsamEvent-old.ips', jetsamReport([{ name: 'OpenKnowledge', pid: 3 }]), 9);
    writeAged(dir, 'OpenKnowledge-crash.ips', jetsamReport([{ name: 'OpenKnowledge', pid: 4 }]), 1);

    const evidence = await collectOsTerminationEvidence({
      platform: 'darwin',
      now: () => NOW,
      macosReportsDir: dir,
    });

    expect(evidence).toMatchObject({
      outcome: 'collected',
      source: 'macos-jetsam',
      readFrom: [join(dir, 'JetsamEvent-*.ips')],
      foreignIgnored: 1,
      unparseable: 1,
      droppedOverCap: 0,
    });
    expect(evidence.events.map((e) => (e.kind === 'jetsam' ? e.file : null))).toEqual([
      'JetsamEvent-owned.ips',
    ]);
  });

  test('counts the oldest in-window files it did not read', async () => {
    const dir = makeTmpDir();
    for (let i = 0; i < 52; i += 1) {
      writeAged(
        dir,
        `JetsamEvent-${String(i).padStart(2, '0')}.ips`,
        jetsamReport([{ name: 'OpenKnowledge', pid: i }]),
        1 + i / 100,
      );
    }

    const evidence = await collectOsTerminationEvidence({
      platform: 'darwin',
      now: () => NOW,
      macosReportsDir: dir,
    });

    expect(evidence.events).toHaveLength(50);
    expect(evidence.droppedOverCap).toBe(2);
    expect(evidence.events.map((e) => (e.kind === 'jetsam' ? e.file : null))).not.toContain(
      'JetsamEvent-51.ips',
    );
  });

  test('reports an unreadable directory as unavailable rather than as an empty window', async () => {
    const evidence = await collectOsTerminationEvidence({
      platform: 'darwin',
      now: () => NOW,
      macosReportsDir: join(makeTmpDir(), 'missing'),
    });

    expect(evidence).toMatchObject({ outcome: 'unavailable', unavailableReason: 'ENOENT' });
  });
});

function runner(results: Record<string, CommandResult>) {
  const calls: { command: string; args: string[] }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const run = async (command: string, args: string[]): Promise<CommandResult> => {
    calls.push({ command, args });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    const key = command.endsWith('wevtutil.exe') ? `wevtutil:${args[1]}` : command;
    const result = results[key];
    if (result === undefined) throw new Error(`unexpected command ${key}`);
    return result;
  };
  return { run, calls, maxInFlight: () => maxInFlight };
}

describe('Linux journal collection', () => {
  const KERNEL_INVOKED =
    '2026-10-04T18:49:10.100000+00:00 host-a kernel: openknowledge invoked oom-killer: gfp_mask=0xcc0(GFP_KERNEL), order=0, oom_score_adj=200';
  const KERNEL_TASK =
    '2026-10-04T18:49:10.110000+00:00 host-a kernel: oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=/,mems_allowed=0,oom_memcg=/user.slice/user-1000.slice/user@1000.service/app.slice/run-p1.service,task_memcg=/user.slice/user-1000.slice/user@1000.service/app.slice/run-p1.service,task=openknowledge,pid=1234,uid=1000';
  const KERNEL_KILLED =
    '2026-10-04T18:49:10.123456+00:00 host-a kernel: Memory cgroup out of memory: Killed process 1234 (openknowledge) total-vm:79404kB, anon-rss:65208kB, UID:1000';
  const OOMD_PRESSURE =
    '2026-10-04T18:40:00.000000+00:00 host-a systemd-oomd[812]: Killed /user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-openknowledge-1234.scope due to memory pressure for /user.slice/user-1000.slice being 71.20% > 50.00% for > 20s with reclaim activity';
  const OOMD_SWAP =
    '2026-10-04T18:41:00.000000+00:00 host-a systemd-oomd[812]: Killed /user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-openknowledge-5678.scope due to memory used (15.5G) / total (15.6G) and swap used (3.9G) / total (4.0G) being more than 90.00%';
  const FOREIGN =
    '2026-10-04T18:30:00.000000+00:00 host-a kernel: Out of memory: Killed process 99 (chrome) total-vm:1kB';

  test('queries kernel and systemd-oomd lines for the last week with a pinned filter', async () => {
    const { run, calls } = runner({
      journalctl: { status: 1, stdout: '-- No entries --\n', stderr: '' },
    });

    await collectOsTerminationEvidence({ platform: 'linux', runCommand: run });

    expect(calls).toEqual([
      {
        command: 'journalctl',
        args: [
          '--no-pager',
          '--output=short-iso-precise',
          '--since=-7d',
          '--grep=Out of memory|oom-kill|Killed process|Killed /|memory pressure',
          '_TRANSPORT=kernel',
          '+',
          '_SYSTEMD_UNIT=systemd-oomd.service',
        ],
      },
    ]);
  });

  test('the journal filter selects every published kill wording', () => {
    const filter = new RegExp(LINUX_JOURNAL_GREP);
    for (const line of [KERNEL_INVOKED, KERNEL_TASK, KERNEL_KILLED, OOMD_PRESSURE, OOMD_SWAP]) {
      expect(filter.test(line)).toBe(true);
    }
  });

  test('keeps this app’s kills as structured fields with no host, cgroup path or uid', async () => {
    const { run } = runner({
      journalctl: {
        status: 0,
        stdout: `-- Boot 44962998fa1849c29d4807eefb892418 --\n${FOREIGN}\n${OOMD_PRESSURE}\n${OOMD_SWAP}\n${KERNEL_INVOKED}\n${KERNEL_TASK}\n${KERNEL_KILLED}\n`,
        stderr: '',
      },
    });

    const evidence = await collectOsTerminationEvidence({ platform: 'linux', runCommand: run });

    expect(evidence.outcome).toBe('collected');
    expect(evidence.foreignIgnored).toBe(1);
    expect(evidence.unparseable).toBe(0);
    expect(evidence.events).toEqual([
      {
        kind: 'journal',
        at: '2026-10-04T18:40:00.000000+00:00',
        origin: 'systemd-oomd',
        action: 'oomd-kill',
        pid: null,
        processName: null,
        unit: 'app-gnome-openknowledge-1234.scope',
        trigger: 'memory-pressure',
      },
      {
        kind: 'journal',
        at: '2026-10-04T18:41:00.000000+00:00',
        origin: 'systemd-oomd',
        action: 'oomd-kill',
        pid: null,
        processName: null,
        unit: 'app-gnome-openknowledge-5678.scope',
        trigger: 'swap',
      },
      {
        kind: 'journal',
        at: '2026-10-04T18:49:10.100000+00:00',
        origin: 'kernel',
        action: 'oom-invoked',
        pid: null,
        processName: 'openknowledge',
        unit: null,
        trigger: null,
      },
      {
        kind: 'journal',
        at: '2026-10-04T18:49:10.110000+00:00',
        origin: 'kernel',
        action: 'oom-kill',
        pid: 1234,
        processName: 'openknowledge',
        unit: null,
        trigger: null,
      },
      {
        kind: 'journal',
        at: '2026-10-04T18:49:10.123456+00:00',
        origin: 'kernel',
        action: 'oom-kill',
        pid: 1234,
        processName: 'openknowledge',
        unit: null,
        trigger: null,
      },
    ]);
    const serialized = JSON.stringify(evidence.events);
    expect(serialized).not.toContain('host-a');
    expect(serialized).not.toContain('user.slice');
    expect(serialized).not.toMatch(/uid/i);
  });

  test('flags a journal that hid system messages from this user', async () => {
    const { run } = runner({
      journalctl: {
        status: 1,
        stdout: '-- No entries --\n',
        stderr:
          "Hint: You are currently not seeing messages from other users and the system.\n      Users in groups 'adm', 'systemd-journal' can see all messages.\n",
      },
    });

    const evidence = await collectOsTerminationEvidence({ platform: 'linux', runCommand: run });

    expect(evidence).toMatchObject({ outcome: 'none-in-window', restrictedToCurrentUser: true });
  });

  test('counts an exit-1 window as empty only when journalctl printed its no-entries marker', async () => {
    const empty = runner({
      journalctl: {
        status: 1,
        stdout: '-- Boot 44962998fa1849c29d4807eefb892418 --\n-- No entries --\n',
        stderr: '',
      },
    });
    const rejected = runner({
      journalctl: {
        status: 1,
        stdout: '',
        stderr: "journalctl: unrecognized option '--grep=Out of memory'\n",
      },
    });
    const missing = runner({
      journalctl: { status: null, stdout: '', stderr: '', errorCode: 'ENOENT' },
    });

    expect(
      (await collectOsTerminationEvidence({ platform: 'linux', runCommand: empty.run })).outcome,
    ).toBe('none-in-window');
    expect(
      await collectOsTerminationEvidence({ platform: 'linux', runCommand: rejected.run }),
    ).toMatchObject({
      outcome: 'unavailable',
      unavailableReason: "exit 1: journalctl: unrecognized option '--grep=Out of memory'",
    });
    expect(
      await collectOsTerminationEvidence({ platform: 'linux', runCommand: missing.run }),
    ).toMatchObject({ outcome: 'unavailable', unavailableReason: 'ENOENT' });
    const corrupt = runner({
      journalctl: {
        status: 1,
        stdout: '',
        stderr:
          'Journal file /var/log/journal/0123456789abcdef0123456789abcdef/system.journal is truncated, ignoring file.\n',
      },
    });
    expect(
      await collectOsTerminationEvidence({ platform: 'linux', runCommand: corrupt.run }),
    ).toMatchObject({
      unavailableReason: 'exit 1: Journal file <journal path> is truncated, ignoring file.',
    });
  });
});

function windowsEvent(provider: string, eventId: number, at: string, payload: string): string {
  return `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='${provider}' Guid='{x}'/><EventID Qualifiers='0'>${eventId}</EventID><TimeCreated SystemTime='${at}'/></System>${payload}</Event>`;
}

function eventData(values: string[]): string {
  return `<EventData>${values.map((v) => `<Data>${v}</Data>`).join('')}</EventData>`;
}

function memoryExhaustion(processes: string[]): string {
  const entries = processes
    .map(
      (name, i) =>
        `<Process_${i}><Name>${name}</Name><ID>${4412 + i}</ID><CommitCharge>9000000000</CommitCharge></Process_${i}>`,
    )
    .join('');
  return `<UserData><MemoryExhaustionInfo xmlns='http://www.microsoft.com/Windows/Resource/Exhaustion/Detector/Events'><SystemInfo><SystemCommitLimit>34359738368</SystemCommitLimit><SystemCommitCharge>34000000000</SystemCommitCharge></SystemInfo><ProcessInfo>${entries}</ProcessInfo></MemoryExhaustionInfo></UserData>`;
}

describe('Windows event log collection', () => {
  test('runs wevtutil from System32 and narrows the application query to this app', () => {
    expect(windowsEventLogExecutable('D:\\Win')).toBe('D:\\Win\\System32\\wevtutil.exe');
    expect(windowsEventLogExecutable(undefined)).toBe('C:\\Windows\\System32\\wevtutil.exe');
    expect(windowsEventLogArgs('System')).toEqual([
      'qe',
      'System',
      '/q:*[System[(EventID=41 or EventID=1074 or EventID=2004 or EventID=6008) and TimeCreated[timediff(@SystemTime) <= 604800000]]]',
      '/f:xml',
      '/rd:true',
      '/c:200',
    ]);
    expect(windowsEventLogArgs('Application')).toEqual([
      'qe',
      'Application',
      "/q:*[System[(EventID=1000 or EventID=1001 or EventID=1002) and TimeCreated[timediff(@SystemTime) <= 604800000]] and EventData[Data='OpenKnowledge.exe' or Data='OpenKnowledge Beta.exe']]",
      '/f:xml',
      '/rd:true',
      '/c:200',
    ]);
  });

  test('keeps system events as times only, and this app’s application events without paths', async () => {
    const system = [
      windowsEvent(
        'Microsoft-Windows-Resource-Exhaustion-Detector',
        2004,
        '2026-10-04T10:00:00Z',
        memoryExhaustion(['OpenKnowledge.exe', 'chrome.exe']),
      ),
      windowsEvent(
        'Microsoft-Windows-Resource-Exhaustion-Detector',
        2004,
        '2026-10-04T10:30:00Z',
        memoryExhaustion(['chrome.exe']),
      ),
      windowsEvent('EventLog', 6008, '2026-10-04T11:00:00Z', eventData(['11:00:00', '10/4/2026'])),
      windowsEvent('Some-Other-Provider', 41, '2026-10-04T12:00:00Z', eventData([])),
    ].join('');
    const application = [
      windowsEvent(
        'Application Hang',
        1002,
        '2026-10-04T09:00:00Z',
        eventData([
          'OpenKnowledge.exe',
          '0.79.9.0',
          '4412',
          'C:\\Users\\someone\\AppData\\Local\\Programs\\OpenKnowledge\\OpenKnowledge.exe',
          'Quit',
        ]),
      ),
      windowsEvent('Application Error', 1000, '2026-10-04T08:00:00Z', eventData(['chrome.exe'])),
    ].join('');
    const { run, calls, maxInFlight } = runner({
      'wevtutil:System': { status: 0, stdout: system, stderr: '' },
      'wevtutil:Application': { status: 0, stdout: application, stderr: '' },
    });

    const evidence = await collectOsTerminationEvidence({
      platform: 'win32',
      runCommand: run,
      systemRoot: 'C:\\Windows',
    });

    expect(calls.map((c) => c.command)).toEqual([
      'C:\\Windows\\System32\\wevtutil.exe',
      'C:\\Windows\\System32\\wevtutil.exe',
    ]);
    expect(maxInFlight()).toBe(2);
    expect(evidence.outcome).toBe('collected');
    expect(evidence.foreignIgnored).toBe(2);
    expect(evidence.events).toEqual([
      {
        kind: 'windows-event',
        at: '2026-10-04T10:00:00Z',
        log: 'System',
        provider: 'Microsoft-Windows-Resource-Exhaustion-Detector',
        eventId: 2004,
        mentionsOpenKnowledge: true,
        data: [],
      },
      {
        kind: 'windows-event',
        at: '2026-10-04T10:30:00Z',
        log: 'System',
        provider: 'Microsoft-Windows-Resource-Exhaustion-Detector',
        eventId: 2004,
        mentionsOpenKnowledge: false,
        data: [],
      },
      {
        kind: 'windows-event',
        at: '2026-10-04T11:00:00Z',
        log: 'System',
        provider: 'EventLog',
        eventId: 6008,
        mentionsOpenKnowledge: false,
        data: [],
      },
      {
        kind: 'windows-event',
        at: '2026-10-04T09:00:00Z',
        log: 'Application',
        provider: 'Application Hang',
        eventId: 1002,
        mentionsOpenKnowledge: true,
        data: ['OpenKnowledge.exe', '0.79.9.0', '4412', 'Quit'],
      },
    ]);
  });

  test('keeps each queried id only from the provider that documents it', async () => {
    const documented: [log: 'System' | 'Application', id: number, provider: string][] = [
      ['System', 41, 'Microsoft-Windows-Kernel-Power'],
      ['System', 1074, 'User32'],
      ['System', 2004, 'Microsoft-Windows-Resource-Exhaustion-Detector'],
      ['System', 6008, 'EventLog'],
      ['Application', 1000, 'Application Error'],
      ['Application', 1001, 'Windows Error Reporting'],
      ['Application', 1002, 'Application Hang'],
    ];
    const at = '2026-10-04T10:00:00Z';
    const recordsFor = (log: string) =>
      documented
        .filter(([l]) => l === log)
        .flatMap(([, id, provider]) => [
          windowsEvent(provider, id, at, eventData(['OpenKnowledge.exe'])),
          windowsEvent('Impostor', id, at, eventData(['OpenKnowledge.exe'])),
        ])
        .join('');
    const { run } = runner({
      'wevtutil:System': { status: 0, stdout: recordsFor('System'), stderr: '' },
      'wevtutil:Application': { status: 0, stdout: recordsFor('Application'), stderr: '' },
    });

    const evidence = await collectOsTerminationEvidence({ platform: 'win32', runCommand: run });

    expect(
      evidence.events.map((e) =>
        e.kind === 'windows-event' ? [e.log, e.eventId, e.provider] : null,
      ),
    ).toEqual(documented);
    expect(evidence.foreignIgnored).toBe(documented.length);
  });

  test('a single failed log makes the sweep partial, and two make it unavailable', async () => {
    const oneFailed = runner({
      'wevtutil:System': { status: 5, stdout: '', stderr: 'Access is denied.' },
      'wevtutil:Application': { status: 0, stdout: '', stderr: '' },
    });
    const bothFailed = runner({
      'wevtutil:System': { status: null, stdout: '', stderr: '', errorCode: 'ENOENT' },
      'wevtutil:Application': { status: null, stdout: '', stderr: '', signal: 'SIGKILL' },
    });

    expect(
      await collectOsTerminationEvidence({ platform: 'win32', runCommand: oneFailed.run }),
    ).toMatchObject({ outcome: 'partial', unavailableReason: 'System: exit 5: Access is denied.' });
    expect(
      await collectOsTerminationEvidence({ platform: 'win32', runCommand: bothFailed.run }),
    ).toMatchObject({
      outcome: 'unavailable',
      unavailableReason: 'System: ENOENT; Application: signal SIGKILL',
    });
  });
});

describe('createRunCommand', () => {
  const node = process.execPath;

  test('reports an exit code, a missing program, an output overflow and a timeout distinctly', async () => {
    const run = createRunCommand({ timeoutMs: 5_000, maxBuffer: 64 });

    expect(await run(node, ['-e', 'process.stdout.write("hi"); process.exit(3)'])).toMatchObject({
      status: 3,
      stdout: 'hi',
    });
    expect(await run(join(makeTmpDir(), 'no-such-program'), [])).toMatchObject({
      status: null,
      errorCode: 'ENOENT',
    });
    expect(await run(node, ['-e', 'process.stdout.write("x".repeat(4096))'])).toMatchObject({
      status: null,
      errorCode: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    });
    expect(
      await createRunCommand({ timeoutMs: 200 })(node, ['-e', 'setTimeout(() => {}, 10_000)']),
    ).toMatchObject({ status: null, errorCode: 'ETIMEDOUT' });
  });

  test('resolves a spawn that throws synchronously instead of rejecting', async () => {
    expect(await createRunCommand()(node, ['-e', 'nul\0byte'])).toMatchObject({
      status: null,
      errorCode: 'ERR_INVALID_ARG_VALUE',
    });
  });

  test.skipIf(process.platform === 'win32')('names the signal that ended a child', async () => {
    const run = createRunCommand();

    expect(
      await run(node, ['-e', 'process.kill(process.pid, "SIGTERM"); setTimeout(() => {}, 5000)']),
    ).toMatchObject({ status: null, signal: 'SIGTERM' });
  });
});

test('names a platform with no collector as unsupported', async () => {
  expect(await collectOsTerminationEvidence({ platform: 'freebsd' })).toMatchObject({
    source: null,
    outcome: 'unsupported',
  });
});

test('summarises the sweep in one line, naming what it could not keep', () => {
  expect(
    describeOsTerminationEvidence({
      schemaVersion: 1,
      platform: 'win32',
      source: 'windows-event-log',
      outcome: 'partial',
      readFrom: [],
      unavailableReason: 'System: exit 5',
      windowDays: 7,
      foreignIgnored: 3,
      unparseable: 1,
      droppedOverCap: 2,
      events: [],
    }),
  ).toBe(
    'partial from Windows event logs, System: exit 5 (7d; 0 kept; 3 other-process record(s) ignored; 1 unparseable; 2 older dropped over cap)',
  );
});

test('renders an uncollected sweep explicitly rather than as an empty file', () => {
  expect(JSON.parse(renderOsTerminationEvidence(undefined))).toEqual({
    schemaVersion: 1,
    outcome: 'not-collected',
  });
});
