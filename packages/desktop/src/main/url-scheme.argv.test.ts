import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { resolveBootRestoreDecision } from './boot-restore-decision.ts';
import { registerProtocolHandler } from './url-scheme.ts';

const executable = resolve(tmpdir(), 'OpenKnowledge.exe');
const documentPath = (name: string) => resolve(tmpdir(), 'open-knowledge-argv', name);

function makeHandler(
  argv: readonly string[] = [executable],
  options: { platform?: NodeJS.Platform; isPackaged?: boolean } = {},
) {
  const events = new EventEmitter();
  const ready = Promise.withResolvers<void>();
  const openEphemeralFile = vi.fn(async (_filePath: string) => {});
  const openProject = vi.fn(async (_projectPath: string) => null);
  const sendDeepLink = vi.fn();
  const infoLog = vi.fn();
  const scheduled: Array<() => void> = [];
  const control = registerProtocolHandler({
    app: {
      on: events.on.bind(events),
      whenReady: () => ready.promise,
      isPackaged: options.isPackaged ?? true,
      setAsDefaultProtocolClient: () => true,
      removeAsDefaultProtocolClient: () => true,
    },
    focusWindowForProject: () => null,
    openProject,
    openEphemeralFile,
    sendDeepLink,
    getAnyReadyWindow: () => null,
    getInitialArgv: () => argv,
    platform: options.platform ?? 'win32',
    log: { info: infoLog, warn: vi.fn(), error: vi.fn() },
    setTimeout: (cb) => scheduled.push(cb),
  });
  return {
    control,
    openEphemeralFile,
    openProject,
    sendDeepLink,
    infoLog,
    ready: ready.resolve,
    secondInstance: (args: readonly string[]) => events.emit('second-instance', {}, args),
    runScheduled: () => {
      while (scheduled.length > 0) scheduled.shift()?.();
    },
  };
}

const names = [
  'notes.md',
  'notes.mdx',
  'notes.MD',
  'notes.MDX',
  'My notes.md',
  '日本語 café.md',
  '100% complete.md',
  'literal%20name.md',
  'literal%00name.md',
  'Q4 #1 & follow-up.md',
];

describe('Windows file-association argv delivery', () => {
  test.each(['cold', 'second-instance'])(
    'skips unencodable paths and records only counts on %s delivery',
    (delivery) => {
      const file = documentPath('valid + 日本語 😀.md');
      const linkedFile = documentPath('linked.md');
      const args = [
        executable,
        documentPath(`high-${String.fromCharCode(0xd800)}.md`),
        file,
        documentPath(`low-${String.fromCharCode(0xdc00)}.mdx`),
        `openknowledge://open?file=${encodeURIComponent(linkedFile)}`,
        '--inspect=9229',
      ];
      const h = makeHandler(delivery === 'cold' ? args : undefined);
      if (delivery === 'second-instance') {
        h.infoLog.mockClear();
        h.secondInstance(args);
      }
      h.control.drainQueuedUrls();
      expect(h.openEphemeralFile.mock.calls.map(([path]) => path)).toEqual([file, linkedFile]);
      expect(
        h.infoLog.mock.calls.filter(([, message]) => message === '[receive] action=argv-scan'),
      ).toEqual([
        [
          { argvLength: 6, urlArguments: 1, fileArguments: 1, unencodableArguments: 2 },
          '[receive] action=argv-scan',
        ],
      ]);
    },
  );

  test.each(names)('queues cold-start file %s and preserves its exact path', (name) => {
    const file = documentPath(name);
    const h = makeHandler([executable, file]);
    expect(h.openEphemeralFile).not.toHaveBeenCalled();
    h.control.drainQueuedUrls();
    expect(h.openEphemeralFile).toHaveBeenCalledExactlyOnceWith(file);
    expect(h.openProject).not.toHaveBeenCalled();
  });

  test.each(names)('routes second-instance file %s after startup', (name) => {
    const file = documentPath(name);
    const h = makeHandler();
    h.control.drainQueuedUrls();
    h.secondInstance([executable, file]);
    expect(h.openEphemeralFile).toHaveBeenCalledExactlyOnceWith(file);
    expect(h.openProject).not.toHaveBeenCalled();
  });

  test('claims the cold launch synchronously before restore chooses a window', async () => {
    const h = makeHandler([executable, documentPath('notes.md')]);
    expect(h.control.singleFileLaunch()).toBe(true);
    expect(h.control.urlLaunchOwnsWindow()).toBe(true);
    expect(
      await resolveBootRestoreDecision({
        pendingRestore: [{ kind: 'project', projectPath: documentPath('previous-project') }],
        lastOpenedProject: documentPath('last-project'),
        optionHeld: false,
        pathExists: () => true,
        urlLaunchOwnsWindow: h.control.urlLaunchOwnsWindow,
        waitForUrlLaunchSettled: h.control.waitForUrlLaunchSettled,
      }),
    ).toEqual({ clearSnapshot: true, action: 'none' });
    expect(h.openEphemeralFile).not.toHaveBeenCalled();
  });

  test('routes a file when Electron prepends switches to second-instance argv', () => {
    const file = documentPath('notes.md');
    const h = makeHandler();
    h.control.drainQueuedUrls();
    h.secondInstance(['--original-process-start-time=123', file, executable]);
    expect(h.openEphemeralFile).toHaveBeenCalledExactlyOnceWith(file);
  });

  test('queues second-instance files received before the first window is ready', () => {
    const first = documentPath('first.md');
    const second = documentPath('second.mdx');
    const h = makeHandler();
    h.secondInstance([executable, first, second]);
    expect(h.openEphemeralFile).not.toHaveBeenCalled();
    expect(h.control.singleFileLaunch()).toBe(true);
    expect(h.control.urlLaunchOwnsWindow()).toBe(true);
    h.control.drainQueuedUrls();
    expect(h.openEphemeralFile.mock.calls).toEqual([[first], [second]]);
  });

  test('flushes a cold file without an existing ready window', async () => {
    const file = documentPath('notes.md');
    const h = makeHandler([executable, file]);
    h.ready();
    await Promise.resolve();
    h.runScheduled();
    expect(h.openEphemeralFile).toHaveBeenCalledExactlyOnceWith(file);
  });

  test.each(['cold', 'second-instance'])(
    'ignores non-document arguments on %s delivery',
    (delivery) => {
      const args = [
        executable,
        '--original-process-start-time=123',
        '--inspect=9229',
        `--log-file=${documentPath('electron.md')}`,
        'relative.md',
        documentPath('main.js'),
        documentPath('program.exe'),
        documentPath('photo.png'),
        documentPath('.md'),
        documentPath('.mdx'),
        'https://example.com/page.md',
      ];
      const h = makeHandler(delivery === 'cold' ? args : undefined);
      if (delivery === 'second-instance') h.secondInstance(args);
      h.control.drainQueuedUrls();
      expect(h.openEphemeralFile).not.toHaveBeenCalled();
      expect(h.openProject).not.toHaveBeenCalled();
      expect(h.control.urlLaunchOwnsWindow()).toBe(false);
    },
  );

  test.each(['cold', 'second-instance'])(
    'ignores document and dev-entrypoint arguments on %s delivery when unpackaged',
    (delivery) => {
      const args = [
        executable,
        documentPath('notes.md'),
        documentPath('out/main/index.js'),
        '--inspect=9229',
      ];
      const h = makeHandler(delivery === 'cold' ? args : undefined, { isPackaged: false });
      if (delivery === 'second-instance') h.secondInstance(args);
      h.control.drainQueuedUrls();
      expect(h.openEphemeralFile).not.toHaveBeenCalled();
      expect(h.control.urlLaunchOwnsWindow()).toBe(false);
    },
  );

  test.each(['cold', 'second-instance'])(
    'preserves custom-scheme single-file delivery on %s startup',
    (delivery) => {
      const file = documentPath('url-note.md');
      const args = [executable, `openknowledge://open?file=${encodeURIComponent(file)}`];
      const h = makeHandler(delivery === 'cold' ? args : undefined);
      if (delivery === 'second-instance') h.secondInstance(args);
      expect(h.control.urlLaunchOwnsWindow()).toBe(true);
      h.control.drainQueuedUrls();
      expect(h.openEphemeralFile).toHaveBeenCalledExactlyOnceWith(file);
    },
  );

  test.each<NodeJS.Platform>(['darwin', 'linux'])(
    'retains URL-only argv behavior on %s',
    (platform) => {
      const file = documentPath('notes.md');
      const h = makeHandler([executable, file], { platform });
      h.secondInstance([executable, file]);
      h.control.drainQueuedUrls();
      expect(h.openEphemeralFile).not.toHaveBeenCalled();
      expect(h.control.urlLaunchOwnsWindow()).toBe(false);
    },
  );

  test
    .skipIf(process.platform !== 'win32')
    .each(['C:\\Users\\Test User\\Documents\\notes.md', 'D:\\日本語\\100% # & notes.mdx'])(
    'routes native Windows path %s',
    (file) => {
      const h = makeHandler([executable, file]);
      h.control.drainQueuedUrls();
      expect(h.openEphemeralFile).toHaveBeenCalledExactlyOnceWith(file);
    },
  );
});
