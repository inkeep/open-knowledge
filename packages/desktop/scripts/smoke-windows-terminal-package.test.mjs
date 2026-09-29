import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pino from 'pino';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  SPAWN_STARTUP_DEADLINE_MS,
  SPAWN_WAIT_EXTENSION_FACTOR,
} from '../src/shared/boot-narration.ts';
import {
  describeDriverTimeoutBudget,
  PACKAGED_BOOT_ENVELOPE_MS,
  PACKAGED_DISCOVERY_OVERRUN_MS,
  PACKAGED_DRIVER_MARGIN_MS,
  PACKAGED_DRIVER_TIMEOUT_MS,
  PACKAGED_PTY_ECHO_BUDGET_MS,
  packagedDiscoveryDeadlineMs,
  packagedDriverSpawnOptions,
  packagedStartupBoundMs,
  runWindowsPackageTerminalSmoke,
  seedWindowsPtySmokeProject,
  windowsPackageAppEnv,
  windowsPackageLaunchArgs,
  windowsPtyDriverEnv,
} from './smoke-windows-terminal-package.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const driverPath = join(scriptDir, 'smoke-terminal-package-cdp.py');
const harnessPath = join(scriptDir, 'smoke-windows-terminal-package.mjs');
const pythonBin = process.env.OK_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const DEAD_CDP_LIST_URL = 'http://127.0.0.1:9/json/list';

function runPython(args, env) {
  try {
    return {
      code: 0,
      output: execFileSync(pythonBin, args, {
        encoding: 'utf8',
        env: { ...process.env, ...env, PYTHONDONTWRITEBYTECODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 25_000,
      }),
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        `no python interpreter at ${pythonBin}; the harness resolves env.OK_PYTHON ?? 'python', set OK_PYTHON to match`,
      );
    }
    return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

function websocketStub(body) {
  return `def create_connection(url, timeout=None, origin=None):\n    ${body}\n`;
}

const CHATTY_PEER_STUB = [
  'import json',
  '',
  'class _Chatty:',
  '    def __init__(self, timeout):',
  '        self.timeout = timeout',
  '    def settimeout(self, value):',
  '        self.timeout = value',
  '    def send(self, payload):',
  '        pass',
  '    def recv(self):',
  '        return json.dumps({"id": 99, "method": "Runtime.consoleAPICalled"})',
  '    def close(self):',
  '        pass',
  '',
  'def create_connection(url, timeout=None, origin=None):',
  '    return _Chatty(timeout)',
  '',
].join('\n');

const WINDOW_RECORDING_STUB = [
  'import json, time',
  '',
  'class _Recorder:',
  '    def __init__(self):',
  '        self.seen = []',
  '        self.reads = 0',
  '    def settimeout(self, value):',
  '        self.seen.append(value)',
  '    def send(self, payload):',
  '        pass',
  '    def recv(self):',
  '        self.reads += 1',
  '        if self.reads >= 4:',
  '            raise RuntimeError("WINDOWS=" + json.dumps(self.seen))',
  '        time.sleep(0.05)',
  '        return json.dumps({"id": 99, "method": "Runtime.consoleAPICalled"})',
  '    def close(self):',
  '        pass',
  '',
  'def create_connection(url, timeout=None, origin=None):',
  '    return _Recorder()',
  '',
].join('\n');

const SPENT_ON_CONNECT_STUB = [
  'import json, time',
  '',
  'class _Idle:',
  '    def settimeout(self, value):',
  '        pass',
  '    def send(self, payload):',
  '        raise AssertionError("send ran after the deadline was already spent")',
  '    def recv(self):',
  '        return json.dumps({"id": 99})',
  '    def close(self):',
  '        print("CLOSED")',
  '',
  'def create_connection(url, timeout=None, origin=None):',
  '    time.sleep(0.4)',
  '    return _Idle()',
  '',
].join('\n');

function stubRootWithModule(source) {
  const stubRoot = mkdtempSync(join(tmpdir(), 'ok-cdp-driver-stub-'));
  fixtures.push(stubRoot);
  writeFileSync(join(stubRoot, 'websocket.py'), source);
  return stubRoot;
}

function stubRootWith(body) {
  return stubRootWithModule(websocketStub(body));
}
const MEASURED_SPAWN_TO_CDP_MS = 3_920;
const MEASURED_CDP_TO_EDITOR_MS = 5_940;

const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function drainDriverBytecode() {
  const cacheDir = join(dirname(driverPath), '__pycache__');
  const left = existsSync(cacheDir)
    ? readdirSync(cacheDir).map((entry) => join(cacheDir, entry))
    : [];
  rmSync(cacheDir, { recursive: true, force: true });
  return left;
}

function ptyEchoSnippet() {
  const extractor = [
    'import importlib.util, sys, types',
    "sys.modules['websocket'] = types.ModuleType('websocket')",
    `spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(driverPath)})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'seen = {}',
    'def fake(socket_url, expression, timeout=5):',
    "    seen['e'] = expression",
    "    return {'platform': 'win32'}",
    'm.evaluate_value = fake',
    "m.evaluate_pty_echo('ws://stub')",
    "sys.stdout.write(seen['e'])",
  ].join('\n');
  const run = runPython(['-c', extractor], { OK_SMOKE_ECHO_DEADLINE_MS: '10500' });
  if (run.code !== 0) throw new Error(`snippet extraction failed: ${run.output}`);
  return run.output;
}

const STUB_PTY_ID = '5f1c2a70-3b6e-4d2f-9a11-7c0e5d8b4321';
const OTHER_PTY_ID = '0c4a9e18-77d5-4a63-8f20-1b93e6c5a7d4';
const STUB_EXIT_CODE = 3;

function stubRenderer({ duringStart = [] } = {}) {
  const channels = { data: [], exit: [], notice: [] };
  const subscribed = { data: 0, exit: 0, notice: 0 };
  let subscribedAtCreate = null;
  const subscribe = (channel) => (listener) => {
    channels[channel].push(listener);
    subscribed[channel] += 1;
    return () => {
      const at = channels[channel].indexOf(listener);
      if (at !== -1) channels[channel].splice(at, 1);
    };
  };
  const deliver = (channel, payload) => {
    for (const listener of channels[channel].slice()) listener(payload);
  };
  const dispatch = (step) => {
    if (typeof step === 'string') return deliver('data', { ptyId: STUB_PTY_ID, data: step });
    if (step.exit !== undefined) return deliver('exit', step.exit);
    return deliver('notice', step.notice);
  };
  return {
    subscriptionAudit: () => ({
      subscribed: { ...subscribed },
      subscribedAtCreate,
      active: {
        data: channels.data.length,
        exit: channels.exit.length,
        notice: channels.notice.length,
      },
    }),
    okDesktop: {
      config: { ptyAvailable: true },
      platform: 'win32',
      terminal: {
        onData: subscribe('data'),
        onExit: subscribe('exit'),
        onNotice: subscribe('notice'),
        async create() {
          subscribedAtCreate = { ...subscribed };
          return { ok: true, ptyId: STUB_PTY_ID };
        },
        async start() {
          for (const step of duringStart) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            dispatch(step);
          }
          return { ok: true };
        },
        async kill() {},
      },
    },
  };
}

function runPtyEchoSnippet(window) {
  return new Function('window', `return (\n${ptyEchoSnippet()}\n);`)(window);
}

function rejectionOf(pending) {
  return pending.then(
    (value) => {
      throw new Error(
        `the renderer expression resolved instead of timing out: ${JSON.stringify(value)}`,
      );
    },
    (reason) => reason,
  );
}

function timeoutFields(message) {
  const parsed =
    /^PTY echo timed out; output=("(?:[^"\\]|\\.)*"); timings=(\{.*?\}); endings=(\[.*\]); notices=(\[.*\])$/.exec(
      message,
    );
  if (parsed === null) {
    throw new Error(
      `the PTY echo timeout error named no ending: it must carry output, timings, endings and notices in that order, and it read ${message}`,
    );
  }
  return {
    output: JSON.parse(parsed[1]),
    timings: JSON.parse(parsed[2]),
    endings: JSON.parse(parsed[3]),
    notices: JSON.parse(parsed[4]),
  };
}

async function timedOutWith(duringStart) {
  const reason = await rejectionOf(runPtyEchoSnippet(stubRenderer({ duringStart })));
  return timeoutFields(reason.message);
}

async function terminalSubsystemLogReader() {
  const module = await import(pathToFileURL(harnessPath).href);
  expect(
    typeof module.readTerminalSubsystemLog,
    'the packaged Windows smoke must export a reader for the log the terminal subsystem actually writes, so a failing run can print it',
  ).toBe('function');
  return module.readTerminalSubsystemLog;
}

async function terminalSubsystemLogReaderOverNewestFirstListing() {
  vi.resetModules();
  vi.doMock('node:fs', async (importOriginal) => {
    const fs = await importOriginal();
    return {
      ...fs,
      readdirSync: (...args) =>
        fs
          .readdirSync(...args)
          .sort()
          .reverse(),
    };
  });
  try {
    return await terminalSubsystemLogReader();
  } finally {
    vi.doUnmock('node:fs');
    vi.resetModules();
  }
}

const NEWER_LOG = 'desktop.2026-09-24.log';
const OLDER_LOG = 'desktop.2026-09-23.log';
const UNREADABLE_LOG = 'desktop.2026-09-22.log';
const LAUNCHED_AT = Date.UTC(2026, 8, 23, 23, 59);
const BEFORE_LAUNCH = '2026-09-23T23:58:00.000Z';
const YESTERDAY_AFTER_LAUNCH = '2026-09-23T23:59:30.000Z';
const AFTER_LAUNCH = '2026-09-24T00:00:30.000Z';

function logsDirOf(home) {
  return join(home, '.ok', 'logs');
}

function writeLogFile(logsDir, name, lines) {
  writeFileSync(join(logsDir, name), `${lines.join('\n')}\n`);
}

function homeWithLogs(lines, previousDayLines = null) {
  const home = mkdtempSync(join(tmpdir(), 'ok-win-pty-home-'));
  fixtures.push(home);
  const logsDir = logsDirOf(home);
  mkdirSync(logsDir, { recursive: true });
  if (previousDayLines !== null) writeLogFile(logsDir, OLDER_LOG, previousDayLines);
  writeLogFile(logsDir, NEWER_LOG, lines);
  return home;
}

const CONPTY_INIT = '\u001b[1t\u001b[c';
const MARKER_LINE = 'OK_PACKAGED_PTY_ECHO\r\n';
const RENDERER_TIMER_MS = 500;
const OVERSIZED_TERMINAL_LOG_LINES = 400;

describe('packaged Windows terminal smoke driver', () => {
  test('seeds deterministic project-local terminal config for the packaged app', () => {
    const root = mkdtempSync(join(tmpdir(), 'ok-win-pty-smoke-test-'));
    fixtures.push(root);
    const { projectDir, userDataDir } = seedWindowsPtySmokeProject(
      root,
      'C:\\Windows\\System32\\cmd.exe',
    );

    expect(readFileSync(join(projectDir, '.ok', 'config.yml'), 'utf8')).toBe(
      "content:\n  dir: '.'\n",
    );
    expect(readFileSync(join(projectDir, '.ok', 'local', 'config.yml'), 'utf8')).toBe(
      'terminal:\n  enabled: true\n  shell: "C:\\\\Windows\\\\System32\\\\cmd.exe"\n',
    );
    expect(readFileSync(join(projectDir, 'start.md'), 'utf8')).toContain('Windows terminal');
    expect(userDataDir).toBe(join(root, 'user-data'));
  });

  test('fails closed on missing ComSpec before touching a package', () => {
    expect(() => runWindowsPackageTerminalSmoke({ platform: 'win32', env: {} })).toThrow(
      /requires ComSpec in its environment/,
    );
  });

  test('launches a unique project through a loopback-only CDP endpoint', () => {
    const args = windowsPackageLaunchArgs('C:\\Temp\\Project With Spaces', 'C:\\Temp\\User Data');

    expect(args).toContain('--remote-debugging-address=127.0.0.1');
    expect(args).toContain('--remote-debugging-port=9222');
    expect(args).toContain('--user-data-dir=C:\\Temp\\User Data');
    expect(args.at(-1)).toBe(
      'openknowledge://open?project=C%3A%5CTemp%5CProject%20With%20Spaces&doc=start',
    );
  });

  test('fails closed when invoked anywhere except a real Windows runner', () => {
    expect(() => runWindowsPackageTerminalSmoke({ platform: 'linux' })).toThrow(
      /must run on Windows/,
    );
  });

  test('requires the CDP driver to exercise its Windows branch', () => {
    expect(windowsPtyDriverEnv({ SENTINEL: 'preserved' })).toEqual({
      SENTINEL: 'preserved',
      OK_SMOKE_EXPECT_PLATFORM: 'win32',
      OK_SMOKE_DISCOVERY_DEADLINE_MS: String(packagedDiscoveryDeadlineMs()),
      OK_SMOKE_ECHO_DEADLINE_MS: String(PACKAGED_PTY_ECHO_BUDGET_MS),
    });
  });

  test('hands the CDP driver only env keys that driver reads', () => {
    const driver = readFileSync(driverPath, 'utf8');
    for (const key of Object.keys(windowsPtyDriverEnv({}))) {
      expect(driver).toMatch(new RegExp(`os\\.environ(?:\\.get\\(|\\[)"${key}"`));
    }
  });

  test('forwards that env and the driver budget to the spawn it actually makes', () => {
    const options = packagedDriverSpawnOptions('C:\\pkg', { SENTINEL: 'preserved' });
    expect(options.cwd).toBe('C:\\pkg');
    expect(options.timeout).toBe(PACKAGED_DRIVER_TIMEOUT_MS);
    expect(options.env).toEqual(windowsPtyDriverEnv({ SENTINEL: 'preserved' }));
  });

  test('spawns the packaged app at a log level that keeps the records its failure path reads back', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-win-pty-logger-home-'));
    fixtures.push(home);
    const spawned = windowsPackageAppEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      OK_LOG_LEVEL: 'error',
      HOME: home,
      USERPROFILE: home,
    });

    vi.resetModules();
    for (const [key, value] of Object.entries(spawned)) vi.stubEnv(key, value);
    try {
      const { getRootDesktopLogger } = await import('../src/main/desktop-logger.ts');
      const logger = getRootDesktopLogger();
      const destination = logger[pino.symbols.streamSym];
      const closed = once(destination, 'close');
      destination.end();
      await closed;

      expect(
        existsSync(logsDirOf(home)),
        'the logger resolves its directory from the home this cell stubbed, so a run that did not open it there wrote its records somewhere else and settles nothing about the level',
      ).toBe(true);
      expect(
        { warn: logger.isLevelEnabled('warn'), info: logger.isLevelEnabled('info') },
        `the packaged app inherits whatever environment the runner hands the smoke, the terminal and pty-host subsystems log only at warn and info, and this one resolved to ${logger.level}, which empties the corpus the failure path reads back and leaves it reporting that the app logged nothing about the subsystem this smoke drives`,
      ).toEqual({ warn: true, info: true });
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  test('stops re-arming the read window when its own deadline is spent', () => {
    const stubRoot = stubRootWithModule(CHATTY_PEER_STUB);
    const startedAt = Date.now();
    const { code, output } = runPython(
      [
        '-c',
        [
          'import importlib.util,sys',
          `spec=importlib.util.spec_from_file_location("cdp",${JSON.stringify(driverPath)})`,
          'm=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
          'try:',
          '    m.evaluate_value("ws://127.0.0.1:9/devtools/page/x", "1", timeout=1.5)',
          'except Exception as error:',
          '    print(f"{type(error).__name__}: {error}")',
        ].join('\n'),
      ],
      { PYTHONPATH: stubRoot },
    );
    const elapsed = Date.now() - startedAt;
    expect(code).toBe(0);
    expect(output).toContain('ReplyPhaseTimeoutError: no CDP reply for id=1 within 1.5s');
    expect(elapsed).toBeGreaterThanOrEqual(1_400);
    expect(elapsed).toBeLessThan(20_000);
  });

  test('closes the socket instead of sending when the connect spent the deadline', () => {
    const stubRoot = stubRootWithModule(SPENT_ON_CONNECT_STUB);
    const { code, output } = runPython(
      [
        '-c',
        [
          'import importlib.util,sys',
          `spec=importlib.util.spec_from_file_location("cdp",${JSON.stringify(driverPath)})`,
          'm=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
          'try:',
          '    m.evaluate_value("ws://127.0.0.1:9/devtools/page/x", "1", timeout=0.3)',
          'except Exception as error:',
          '    print(f"{type(error).__name__}: {error}")',
        ].join('\n'),
      ],
      { PYTHONPATH: stubRoot },
    );
    expect(code).toBe(0);
    expect(output).toContain(
      'ConnectPhaseTimeoutError: connect and handshake spent the whole 0.3s budget',
    );
    expect(output).toContain('CLOSED');
    expect(output).not.toContain('send ran after the deadline');
  });

  test('arms a shrinking socket window before every read', () => {
    const stubRoot = stubRootWithModule(WINDOW_RECORDING_STUB);
    const { code, output } = runPython(
      [
        '-c',
        [
          'import importlib.util,sys',
          `spec=importlib.util.spec_from_file_location("cdp",${JSON.stringify(driverPath)})`,
          'm=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
          'try:',
          '    m.evaluate_value("ws://127.0.0.1:9/devtools/page/x", "1", timeout=5)',
          'except Exception as error:',
          '    print(f"{error}")',
        ].join('\n'),
      ],
      { PYTHONPATH: stubRoot },
    );
    expect(code).toBe(0);
    const windows = JSON.parse(/WINDOWS=(\[[^\]]*\])/.exec(output)?.[1] ?? '[]');
    expect(windows.length).toBe(5);
    expect(windows[0] - windows[windows.length - 1]).toBeGreaterThanOrEqual(0.1);
  });

  test.each([['9000'], ['10000']])(
    'refuses echo budget %s before it spends the discovery budget',
    (budget) => {
      const stubRoot = stubRootWith('raise OSError');
      const { code, output } = runPython([driverPath], {
        PYTHONPATH: stubRoot,
        OK_SMOKE_ECHO_DEADLINE_MS: budget,
        OK_SMOKE_CDP_LIST_URL: DEAD_CDP_LIST_URL,
      });
      expect(code).toBe(1);
      expect(output).toContain('ERROR: packaged PTY smoke misconfigured:');
      expect(output).toContain('leaves no room for the renderer');
      expect(output).not.toContain('Traceback');
      expect(output).not.toContain('no project editor debug target appeared');
    },
  );

  test('accepts the smallest echo budget that leaves the renderer its margin', () => {
    const stubRoot = stubRootWith('raise OSError');
    const { code, output } = runPython(
      [
        '-c',
        [
          'import importlib.util,sys',
          `spec=importlib.util.spec_from_file_location("cdp",${JSON.stringify(driverPath)})`,
          'm=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
          'print(f"RENDERER_TIMER={m.renderer_echo_timeout_ms()}")',
        ].join('\n'),
      ],
      { PYTHONPATH: stubRoot, OK_SMOKE_ECHO_DEADLINE_MS: '10001' },
    );
    expect(code).toBe(0);
    expect(output).toMatch(/RENDERER_TIMER=1(?![0-9])/);
  });

  test('hands the renderer echo timer the socket budget it must beat', () => {
    const stubRoot = stubRootWith('raise RuntimeError(f"SOCKET_TIMEOUT={timeout}")');
    const { code, output } = runPython(
      [
        '-c',
        [
          'import importlib.util,sys',
          `spec=importlib.util.spec_from_file_location("cdp",${JSON.stringify(driverPath)})`,
          'm=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
          'try:',
          '    m.evaluate_pty_echo("ws://127.0.0.1:9/devtools/page/x")',
          'except Exception as error:',
          '    print(error)',
        ].join('\n'),
      ],
      { PYTHONPATH: stubRoot, OK_SMOKE_ECHO_DEADLINE_MS: String(PACKAGED_PTY_ECHO_BUDGET_MS) },
    );
    expect(code).toBe(0);
    expect(output).toMatch(
      new RegExp(`SOCKET_TIMEOUT=${(PACKAGED_PTY_ECHO_BUDGET_MS / 1000).toFixed(1)}(?![0-9])`),
    );
    expect(output).toContain(`of a ${PACKAGED_PTY_ECHO_BUDGET_MS / 1000}s budget`);
    expect(output).toContain('renderer_timer=20s');
  });

  test('reaches the app budget through a plain node import of the app module', () => {
    const output = execFileSync(
      process.execPath,
      [
        '-e',
        `import(${JSON.stringify(pathToFileURL(harnessPath).href)}).then((m) => console.log(m.packagedDiscoveryDeadlineMs()))`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(output.trim()).toBe(String(packagedDiscoveryDeadlineMs()));
  });

  test('spends the deadline it was handed before reporting the phase it reached', () => {
    const stubRoot = stubRootWith('raise OSError');
    const { code, output } = runPython([driverPath], {
      PYTHONPATH: stubRoot,
      OK_SMOKE_DISCOVERY_DEADLINE_MS: '1200',
      OK_SMOKE_CDP_LIST_URL: DEAD_CDP_LIST_URL,
    });
    expect(code).not.toBe(0);
    expect(output).toContain('the debug endpoint never answered');
    const elapsed = output.match(/gave up after (\d+\.\d)s of a 1s budget/);
    expect(elapsed).not.toBeNull();
    expect(Number(elapsed[1])).toBeGreaterThanOrEqual(1.2);
  });

  test('waits as long as the packaged app is allowed to keep starting its server', () => {
    expect(packagedStartupBoundMs()).toBe(SPAWN_STARTUP_DEADLINE_MS * SPAWN_WAIT_EXTENSION_FACTOR);
    expect(packagedDiscoveryDeadlineMs()).toBe(
      packagedStartupBoundMs() + PACKAGED_BOOT_ENVELOPE_MS,
    );
    expect(PACKAGED_BOOT_ENVELOPE_MS).toBeGreaterThanOrEqual(
      MEASURED_SPAWN_TO_CDP_MS + MEASURED_CDP_TO_EDITOR_MS,
    );
  });

  test('moves with the spawn deadline the packaged path enforces', () => {
    expect(packagedDiscoveryDeadlineMs(20_000) - packagedDiscoveryDeadlineMs(15_000)).toBe(
      5_000 * SPAWN_WAIT_EXTENSION_FACTOR,
    );
    expect(packagedDiscoveryDeadlineMs(15_000)).toBe(
      15_000 * SPAWN_WAIT_EXTENSION_FACTOR + PACKAGED_BOOT_ENVELOPE_MS,
    );
  });

  test('moves with the extension factor the packaged path enforces', () => {
    expect(packagedDiscoveryDeadlineMs(SPAWN_STARTUP_DEADLINE_MS, 4)).toBe(
      SPAWN_STARTUP_DEADLINE_MS * 4 + PACKAGED_BOOT_ENVELOPE_MS,
    );
    expect(
      packagedDiscoveryDeadlineMs(SPAWN_STARTUP_DEADLINE_MS, SPAWN_WAIT_EXTENSION_FACTOR + 1) -
        packagedDiscoveryDeadlineMs(),
    ).toBe(SPAWN_STARTUP_DEADLINE_MS);
  });

  test('derives from no constant the packaged boot leaves unexecuted', () => {
    const harness = readFileSync(harnessPath, 'utf8');
    expect(harness).toContain('SPAWN_STARTUP_DEADLINE_MS');
    expect(harness).not.toContain('UTILITY_INIT_TIMEOUT_MS');
  });

  test('kills the driver only after every phase budget plus a margin has run out', () => {
    expect(PACKAGED_DRIVER_TIMEOUT_MS).toBe(
      packagedDiscoveryDeadlineMs() +
        PACKAGED_PTY_ECHO_BUDGET_MS +
        PACKAGED_DISCOVERY_OVERRUN_MS +
        PACKAGED_DRIVER_MARGIN_MS,
    );
  });

  test('measures each phase from when the snippet started, not from an absolute clock', async () => {
    const result = await runPtyEchoSnippet(
      stubRenderer({ duringStart: [CONPTY_INIT, MARKER_LINE] }),
    );
    const { createdMs, firstByteMs, markerMs } = result.timings;
    for (const value of [createdMs, firstByteMs, markerMs]) {
      expect(typeof value).toBe('number');
      expect(value).toBeLessThan(RENDERER_TIMER_MS);
    }
    expect(createdMs).toBeLessThanOrEqual(firstByteMs);
    expect(firstByteMs).toBeLessThan(markerMs);
  });

  test('reports the same measurements on the line it prints when nothing echoes, and says no ending arrived', async () => {
    const pending = runPtyEchoSnippet(stubRenderer());
    await expect(pending).rejects.toThrow(
      /PTY echo timed out; output=""; timings=\{"createdMs":\d+,"firstByteMs":null,"markerMs":null\}/,
    );

    const { endings, notices } = timeoutFields((await rejectionOf(pending)).message);
    expect(
      { endings, notices },
      'an empty endings list is the datum that separates a shell that is alive and silent from every death, so it must be reported rather than omitted',
    ).toEqual({ endings: [], notices: [] });
  });

  test('subscribes to every ending channel before it creates the pty, and releases all three when it settles', async () => {
    const renderer = stubRenderer({ duringStart: [CONPTY_INIT, MARKER_LINE] });

    await runPtyEchoSnippet(renderer);

    expect(renderer.subscriptionAudit()).toEqual({
      subscribed: { data: 1, exit: 1, notice: 1 },
      subscribedAtCreate: { data: 1, exit: 1, notice: 1 },
      active: { data: 0, exit: 0, notice: 0 },
    });
  });

  test('names the preload member it could not subscribe to, instead of leaving the driver waiting on the socket', async () => {
    const renderer = stubRenderer();
    delete renderer.okDesktop.terminal.onExit;
    const STILL_PENDING = Symbol('still pending');

    const settled = await Promise.race([
      rejectionOf(runPtyEchoSnippet(renderer)),
      new Promise((resolve) => setTimeout(() => resolve(STILL_PENDING), RENDERER_TIMER_MS * 4)),
    ]);

    expect(
      settled,
      'a preload that does not expose a channel must settle the expression with its own cause; staying pending spends the whole CDP budget and prints a reply timeout carrying no cause at all',
    ).not.toBe(STILL_PENDING);
    expect(settled.message).toMatch(/onExit/);
    expect(
      {
        subscribed: renderer.subscriptionAudit().subscribed,
        active: renderer.subscriptionAudit().active,
      },
      'the channel it did subscribe to before the throw has to come back off; taking all three in one call loses the first release when the second throws, and that listener outlives the expression that installed it',
    ).toEqual({
      subscribed: { data: 1, exit: 0, notice: 0 },
      active: { data: 0, exit: 0, notice: 0 },
    });
  });

  test('names a shell that never attached on the line it prints', async () => {
    const { endings, notices } = await timedOutWith([
      { exit: { ptyId: STUB_PTY_ID, neverStarted: true } },
    ]);

    expect({ endings, notices }).toEqual({
      endings: [{ ptyId: STUB_PTY_ID, neverStarted: true, atMs: expect.any(Number) }],
      notices: [],
    });
  });

  test('names an attached shell that exited, with the code it exited on', async () => {
    const { endings } = await timedOutWith([
      CONPTY_INIT,
      { exit: { ptyId: STUB_PTY_ID, exitCode: STUB_EXIT_CODE, signal: null } },
    ]);

    expect(endings).toEqual([
      { ptyId: STUB_PTY_ID, exitCode: STUB_EXIT_CODE, signal: null, atMs: expect.any(Number) },
    ]);
  });

  test('separates a dead pty host from a shell that never attached and from a shell that exited', async () => {
    const { endings } = await timedOutWith([
      { exit: { ptyId: STUB_PTY_ID, neverStarted: true, hostExited: true } },
    ]);

    expect(endings).toEqual([
      { ptyId: STUB_PTY_ID, neverStarted: true, hostExited: true, atMs: expect.any(Number) },
    ]);
  });

  test('names a shell notice and the reason it carried', async () => {
    const { endings, notices } = await timedOutWith([
      { notice: { ptyId: STUB_PTY_ID, notice: 'invalid-shell-override', reason: 'not-found' } },
    ]);

    expect({ endings, notices }).toEqual({
      endings: [],
      notices: [
        {
          ptyId: STUB_PTY_ID,
          notice: 'invalid-shell-override',
          reason: 'not-found',
          atMs: expect.any(Number),
        },
      ],
    });
  });

  test('keeps an ending whose ptyId does not match the pty it created', async () => {
    const { endings } = await timedOutWith([
      { exit: { ptyId: OTHER_PTY_ID, exitCode: STUB_EXIT_CODE, signal: null } },
    ]);

    expect(
      endings,
      'dropping an ending is the defect under repair, so an ending for another pty is reported with its own ptyId rather than filtered away',
    ).toEqual([
      { ptyId: OTHER_PTY_ID, exitCode: STUB_EXIT_CODE, signal: null, atMs: expect.any(Number) },
    ]);
  });

  test('reports what it saw before the marker on the run that echoed, and records nothing after it settles', async () => {
    const result = await runPtyEchoSnippet(
      stubRenderer({
        duringStart: [
          { notice: { ptyId: STUB_PTY_ID, notice: 'shell-resolved', shellFamily: 'cmd' } },
          CONPTY_INIT,
          MARKER_LINE,
          { exit: { ptyId: STUB_PTY_ID, exitCode: 0, signal: null } },
        ],
      }),
    );

    expect({ endings: result.endings, notices: result.notices }).toEqual({
      endings: [],
      notices: [
        {
          ptyId: STUB_PTY_ID,
          notice: 'shell-resolved',
          shellFamily: 'cmd',
          atMs: expect.any(Number),
        },
      ],
    });
  });

  test('prints what the observer recorded beside the timings on the run that passed', () => {
    const { code, output } = runPython(
      [
        '-c',
        [
          'import importlib.util, sys, types',
          "sys.modules['websocket'] = types.ModuleType('websocket')",
          `spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(driverPath)})`,
          'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
          "m.find_editor_websocket = lambda: 'ws://stub'",
          'm.evaluate_pty_echo = lambda socket_url: {',
          "    'platform': 'win32',",
          "    'timings': {'createdMs': 1, 'firstByteMs': 2, 'markerMs': 3},",
          "    'endings': [],",
          "    'notices': [{'ptyId': 'p', 'notice': 'shell-resolved', 'shellFamily': 'cmd', 'atMs': 2}],",
          '}',
          'raise SystemExit(m.main())',
        ].join('\n'),
      ],
      {
        OK_SMOKE_EXPECT_PLATFORM: 'win32',
        OK_SMOKE_ECHO_DEADLINE_MS: String(PACKAGED_PTY_ECHO_BUDGET_MS),
      },
    );

    expect(code).toBe(0);
    expect(
      output,
      'a green run is the cheapest proof that the ending channels are live, which it can only give by printing what they delivered',
    ).toContain(
      'timings={"createdMs": 1, "firstByteMs": 2, "markerMs": 3}; endings=[]; ' +
        'notices=[{"ptyId": "p", "notice": "shell-resolved", "shellFamily": "cmd", "atMs": 2}]',
    );
  });

  test('surfaces the terminal and pty-host lines the app wrote to its own log', async () => {
    const read = await terminalSubsystemLogReader();
    const unrelated = JSON.stringify({
      time: AFTER_LAUNCH,
      level: 30,
      subsystem: 'app',
      event: 'terminal-load-failed',
    });
    const spawnError = JSON.stringify({
      time: AFTER_LAUNCH,
      level: 40,
      subsystem: 'terminal',
      event: 'terminal-manager-spawn-error',
      shellNeverAttached: true,
      exitCode: -1,
      elapsedMs: 42,
      killRequested: false,
    });
    const hostLine = JSON.stringify({
      time: AFTER_LAUNCH,
      level: 40,
      subsystem: 'pty-host',
      event: 'pty-host-unexpected-message',
    });
    const eventless = JSON.stringify({
      time: AFTER_LAUNCH,
      level: 40,
      subsystem: 'terminal',
      cli: 'claude',
      msg: 'cli-preflight: unknown cli discriminant',
    });

    const surfaced = read(LAUNCHED_AT, homeWithLogs([unrelated, spawnError, hostLine, eventless]));

    expect(surfaced).toContain(spawnError);
    expect(surfaced).toContain(hostLine);
    expect(
      surfaced,
      'the terminal subsystem names an event on most of its records but not all of them, so a reader that selects on the event name instead of the subsystem drops the warnings that carry no event and the triager loses them',
    ).toContain(eventless);
    expect(surfaced).not.toContain('terminal-load-failed');
  });

  test('says it looked and where when the logs directory is not there', async () => {
    const read = await terminalSubsystemLogReader();
    const absent = join(tmpdir(), `ok-win-pty-home-absent-${process.pid}`);
    expect(existsSync(absent)).toBe(false);

    const surfaced = read(LAUNCHED_AT, absent);

    expect(surfaced.trim()).not.toBe('');
    expect(surfaced).toContain(logsDirOf(absent));
  });

  test('says it looked and where when the logs it found carry no terminal line', async () => {
    const read = await terminalSubsystemLogReader();
    const home = homeWithLogs([
      JSON.stringify({
        time: AFTER_LAUNCH,
        level: 30,
        subsystem: 'app',
        event: 'theme-source-set',
      }),
    ]);
    const absent = join(tmpdir(), `ok-win-pty-home-absent-${process.pid}`);

    const surfaced = read(LAUNCHED_AT, home);

    expect(surfaced.trim()).not.toBe('');
    expect(surfaced).toContain(logsDirOf(home));
    expect(surfaced).not.toContain('theme-source-set');
    expect(
      surfaced.replaceAll(home, '<home>'),
      'a directory that holds no terminal line is a different observation from a directory that is not there, so the two cannot print the same sentence',
    ).not.toBe(read(LAUNCHED_AT, absent).replaceAll(absent, '<home>'));
  });

  test('bounds what it surfaces to the newest lines the terminal subsystem wrote', async () => {
    const read = await terminalSubsystemLogReader();
    const line = (index) =>
      JSON.stringify({
        time: AFTER_LAUNCH,
        level: 40,
        subsystem: 'terminal',
        event: 'terminal-manager-host-exited',
        index,
      });
    const written = Array.from({ length: OVERSIZED_TERMINAL_LOG_LINES }, (_, index) => line(index));

    const surfaced = read(LAUNCHED_AT, homeWithLogs(written));

    expect(surfaced).toContain(line(OVERSIZED_TERMINAL_LOG_LINES - 1));
    expect(surfaced).not.toContain(line(0));
  });

  test('skips a line it cannot parse and still surfaces the terminal lines around it', async () => {
    const read = await terminalSubsystemLogReader();
    const tornEvent = 'terminal-manager-write-interrupted';
    const before = JSON.stringify({
      time: AFTER_LAUNCH,
      level: 40,
      subsystem: 'terminal',
      event: 'terminal-manager-spawn-error',
      shellNeverAttached: true,
    });
    const after = JSON.stringify({
      time: AFTER_LAUNCH,
      level: 40,
      subsystem: 'pty-host',
      event: 'pty-host-exited',
      code: 1,
    });
    const complete = JSON.stringify({
      time: AFTER_LAUNCH,
      level: 40,
      subsystem: 'terminal',
      event: tornEvent,
      elapsedMs: 42,
    });
    const torn = complete.slice(0, complete.lastIndexOf(',"elapsedMs"'));

    const surfaced = read(LAUNCHED_AT, homeWithLogs([before, torn, after]));

    expect(surfaced).toContain(before);
    expect(surfaced).toContain(after);
    expect(
      surfaced,
      'a half-written record carries no subsystem the reader can select on, and printing the fragment puts a parse artefact where the triager is looking for the lines that explain the run',
    ).not.toContain(tornEvent);
  });

  test('surfaces every log file the directory holds, oldest first', async () => {
    const read = await terminalSubsystemLogReaderOverNewestFirstListing();
    const yesterday = JSON.stringify({
      time: YESTERDAY_AFTER_LAUNCH,
      level: 40,
      subsystem: 'terminal',
      event: 'terminal-manager-host-exited',
      day: 'yesterday',
    });
    const today = JSON.stringify({
      time: AFTER_LAUNCH,
      level: 40,
      subsystem: 'terminal',
      event: 'terminal-manager-host-exited',
      day: 'today',
    });

    const surfaced = read(LAUNCHED_AT, homeWithLogs([today], [yesterday]));

    expect(surfaced).toContain(yesterday);
    expect(surfaced).toContain(today);
    expect(
      surfaced.indexOf(yesterday),
      'the app names its log file once, for the day it started, so a run that crosses midnight leaves two of them; splicing the older day in after the newer one reads to a triager as a clock running backwards',
    ).toBeLessThan(surfaced.indexOf(today));
  });

  test('bounds the newest lines across every log file, not within each one', async () => {
    const read = await terminalSubsystemLogReaderOverNewestFirstListing();
    const line = (index) =>
      JSON.stringify({
        time: AFTER_LAUNCH,
        level: 40,
        subsystem: 'terminal',
        event: 'terminal-manager-host-exited',
        index,
      });
    const yesterday = JSON.stringify({
      time: YESTERDAY_AFTER_LAUNCH,
      level: 40,
      subsystem: 'terminal',
      event: 'terminal-manager-host-exited',
      day: 'yesterday',
    });
    const written = Array.from({ length: OVERSIZED_TERMINAL_LOG_LINES }, (_, index) => line(index));

    const surfaced = read(LAUNCHED_AT, homeWithLogs(written, [yesterday]));

    expect(surfaced).toContain(line(OVERSIZED_TERMINAL_LOG_LINES - 1));
    expect(
      surfaced,
      'a bound spent once per file keeps yesterday alive at the cost of the lines this run wrote, which is the opposite of the trade a triager reading a failed run needs',
    ).not.toContain(yesterday);
  });

  test('says what it looked at and where when the logs path cannot be listed', async () => {
    const read = await terminalSubsystemLogReader();
    const home = mkdtempSync(join(tmpdir(), 'ok-win-pty-home-'));
    fixtures.push(home);
    mkdirSync(join(home, '.ok'));
    const notADirectory = logsDirOf(home);
    writeFileSync(notADirectory, 'a path that exists, is readable, and is not a directory\n');
    expect(
      existsSync(notADirectory),
      'the path has to exist, or the reader answers from its absence branch and this cell never reaches the listing it is here to drive',
    ).toBe(true);

    const surfaced = read(LAUNCHED_AT, home);

    expect(surfaced.trim()).not.toBe('');
    expect(
      surfaced,
      'the reader runs inside the supervisor catch that is about to print why the driver failed, so a filesystem error let loose here replaces that diagnostic with its own',
    ).toContain(notADirectory);
  });

  test('surfaces the terminal records in the logs it can read when another log cannot be read', async () => {
    const read = await terminalSubsystemLogReader();
    const record = JSON.stringify({
      time: AFTER_LAUNCH,
      level: 40,
      subsystem: 'terminal',
      event: 'terminal-manager-spawn-error',
      shellNeverAttached: true,
    });
    const home = homeWithLogs([record]);
    mkdirSync(join(logsDirOf(home), UNREADABLE_LOG));

    const surfaced = read(LAUNCHED_AT, home);

    expect(surfaced).toContain(record);
    expect(
      surfaced,
      'a log the reader could not open may hold the record that explains the run, so the triager has to be told which one is missing',
    ).toContain(UNREADABLE_LOG);
  });

  test('names the log it could not read when the logs it could read carry no terminal record', async () => {
    const read = await terminalSubsystemLogReader();
    const home = homeWithLogs([
      JSON.stringify({
        time: AFTER_LAUNCH,
        level: 30,
        subsystem: 'app',
        event: 'theme-source-set',
      }),
    ]);
    mkdirSync(join(logsDirOf(home), UNREADABLE_LOG));

    const surfaced = read(LAUNCHED_AT, home);

    expect(
      surfaced,
      'with nothing found in the logs it could read, the log it could not open is the only place the record that explains the run can still be, so leaving it unnamed reads as a terminal subsystem that stayed quiet',
    ).toContain(UNREADABLE_LOG);
  });

  test('prints the terminal records this launch wrote, and none from before it, when the driver fails', () => {
    const earlierSession = JSON.stringify({
      time: BEFORE_LAUNCH,
      level: 40,
      subsystem: 'terminal',
      event: 'terminal-manager-spawn-error',
      shellNeverAttached: true,
    });
    const thisLaunch = JSON.stringify({
      time: AFTER_LAUNCH,
      level: 40,
      subsystem: 'pty-host',
      event: 'pty-host-exited',
      code: 1,
    });
    const home = homeWithLogs([earlierSession, thisLaunch]);
    const packageDir = join(home, 'win-unpacked');
    mkdirSync(packageDir);
    copyFileSync(
      process.execPath,
      join(packageDir, 'OpenKnowledge.exe'),
      constants.COPYFILE_FICLONE,
    );

    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(LAUNCHED_AT);
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() =>
        runWindowsPackageTerminalSmoke({
          packageDir,
          platform: 'win32',
          env: { ...process.env, ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
          python: join(home, 'no-python-here'),
        }),
      ).toThrow(/could not run packaged PTY CDP driver/);
      const stderr = printed.mock.calls.map((call) => call.join(' ')).join('\n');

      expect(stderr).toContain(thisLaunch);
      expect(
        stderr,
        'the app shares one log file per day across every session on the host, so a record from before this launch printed beside its own reads to a triager as something this run did',
      ).not.toContain(earlierSession);
    } finally {
      printed.mockRestore();
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  test('reads the logs the app writes beneath the home directory when it is called without one', async () => {
    const read = await terminalSubsystemLogReader();
    const hostLine = JSON.stringify({
      time: AFTER_LAUNCH,
      level: 40,
      subsystem: 'pty-host',
      event: 'pty-host-exited',
      code: 1,
    });
    const fakeHome = homeWithLogs([hostLine]);

    vi.stubEnv('HOME', fakeHome);
    vi.stubEnv('USERPROFILE', fakeHome);
    try {
      expect(
        homedir(),
        'the home directory has to resolve to the fixture before the reader is called, or calling it without one reads whatever this machine has in its own ~/.ok/logs',
      ).toBe(fakeHome);

      expect(read(LAUNCHED_AT)).toContain(hostLine);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('names every phase budget in seconds when the kill fires', () => {
    expect(describeDriverTimeoutBudget()).toBe(
      'the packaged PTY CDP driver outlived its 168s budget ' +
        '(130s discovery + 30s echo + 3s overrun + 5s margin), ' +
        'so one phase overran and was killed before it could report itself',
    );
  });

  test('imports the CDP driver without leaving Python bytecode in the repository', () => {
    const driverMarker = MARKER_LINE.trim();
    const readDriverMarker = [
      'import importlib.util, sys, types',
      "sys.modules['websocket'] = types.ModuleType('websocket')",
      `spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(driverPath)})`,
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'sys.stdout.write(m.MARKER)',
    ].join('\n');

    drainDriverBytecode();
    try {
      const shippedSnippet = ptyEchoSnippet();
      const afterShippedCallSite = drainDriverBytecode();
      const overriddenCallerClear = runPython(['-c', readDriverMarker], {
        PYTHONDONTWRITEBYTECODE: '',
      });
      const afterHelperOverrodeCallerClear = drainDriverBytecode();

      expect(shippedSnippet).toContain(driverMarker);
      expect(
        overriddenCallerClear.code,
        `the caller-clear arm's python spawn on ${driverPath} exited non-zero: ${overriddenCallerClear.output}`,
      ).toBe(0);
      expect(overriddenCallerClear.output.trim()).toBe(driverMarker);
      expect(
        { afterShippedCallSite, afterHelperOverrodeCallerClear },
        `a python spawn compiled ${driverPath} into the repository: CPython caches an imported module's bytecode beside its source, and the push-boundary gate refuses a tree carrying untracked files`,
      ).toEqual({ afterShippedCallSite: [], afterHelperOverrodeCallerClear: [] });
    } finally {
      try {
        drainDriverBytecode();
      } catch (error) {
        process.stderr.write(
          `[pycache-drain] failed to clear __pycache__ under ${dirname(driverPath)}; python bytecode is left in the working tree, where the push-boundary gate will refuse it: ${error}\n`,
        );
      }
    }
  });
});
