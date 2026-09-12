import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
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
        env: { ...process.env, ...env },
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

function stubRenderer({ duringStart = [] } = {}) {
  const listeners = [];
  const emit = (data) => {
    for (const listener of listeners) listener({ ptyId: 7, data });
  };
  return {
    okDesktop: {
      config: { ptyAvailable: true },
      platform: 'win32',
      terminal: {
        onData(listener) {
          listeners.push(listener);
          return () => {
            listeners.length = 0;
          };
        },
        async create() {
          return { ok: true, ptyId: 7 };
        },
        async start() {
          for (const chunk of duringStart) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            emit(chunk);
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

const CONPTY_INIT = '\u001b[1t\u001b[c';
const MARKER_LINE = 'OK_PACKAGED_PTY_ECHO\r\n';
const RENDERER_TIMER_MS = 500;

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

  test('reports the same measurements on the line it prints when nothing echoes', async () => {
    await expect(runPtyEchoSnippet(stubRenderer())).rejects.toThrow(
      /PTY echo timed out; output=""; timings=\{"createdMs":\d+,"firstByteMs":null,"markerMs":null\}/,
    );
  });

  test('names every phase budget in seconds when the kill fires', () => {
    expect(describeDriverTimeoutBudget()).toBe(
      'the packaged PTY CDP driver outlived its 168s budget ' +
        '(130s discovery + 30s echo + 3s overrun + 5s margin), ' +
        'so one phase overran and was killed before it could report itself',
    );
  });
});
