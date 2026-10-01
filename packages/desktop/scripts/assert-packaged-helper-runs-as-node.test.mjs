import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { posix as pathPosix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  checkPackagedApp,
  findPackagedApps,
  HELPER_PROBE_TIMEOUT_MS,
  helperProbeProblems,
  probeHelper,
} from './assert-packaged-helper-runs-as-node.mjs';

const SCRIPT = fileURLToPath(new URL('./assert-packaged-helper-runs-as-node.mjs', import.meta.url));
const NODE_MODE_HELPER = `#!/bin/sh\nexec "${process.execPath}" "$@"\n`;
const DYLD_FAILING_HELPER =
  '#!/bin/sh\necho "dyld[1]: Library not loaded: @rpath/Electron Framework.framework/Electron Framework" >&2\nexit 1\n';
const passingProbe = () => ({
  status: 0,
  signal: null,
  stdout: 'ok-helper-node-mode 24.18.0\n',
  stderr: '',
});

let root;

beforeEach(() => {
  root = mkdtempSync(pathPosix.join(tmpdir(), 'assert-packaged-helper-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function plist(executable) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>CFBundleExecutable</key>\n  <string>${executable}</string>\n</dict>\n</plist>\n`;
}

function plantApp({
  arch = 'mac-arm64',
  product = 'OpenKnowledge',
  servers = [product],
  helperName = `${product} Helper`,
  helper = NODE_MODE_HELPER,
  helperMode = 0o755,
} = {}) {
  const app = pathPosix.join(root, arch, `${product}.app`);
  mkdirSync(pathPosix.join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(pathPosix.join(app, 'Contents', 'Info.plist'), plist(product));
  writeFileSync(pathPosix.join(app, 'Contents', 'MacOS', product), '');
  for (const server of servers) {
    const bundle = pathPosix.join(app, 'Contents', 'Frameworks', `${server} Server.app`);
    mkdirSync(pathPosix.join(bundle, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(pathPosix.join(bundle, 'Contents', 'Info.plist'), plist(helperName));
    if (helper !== null) {
      const binary = pathPosix.join(bundle, 'Contents', 'MacOS', helperName);
      writeFileSync(binary, helper);
      chmodSync(binary, helperMode);
    }
  }
  return app;
}

function helperOf(app, server, helperName) {
  return pathPosix.join(
    app,
    'Contents',
    'Frameworks',
    `${server} Server.app`,
    'Contents',
    'MacOS',
    helperName,
  );
}

function runCli(...args) {
  return spawnSync(process.execPath, ['--conditions=development', SCRIPT, ...args], {
    encoding: 'utf8',
  });
}

describe('findPackagedApps', () => {
  test('finds every mac-*/*.app and nothing else', () => {
    const stable = plantApp();
    const beta = plantApp({ arch: 'mac-universal', product: 'OpenKnowledge Beta' });
    mkdirSync(pathPosix.join(root, 'linux-unpacked', 'OpenKnowledge.app'), { recursive: true });
    expect(findPackagedApps(root)).toEqual([stable, beta].sort());
  });

  test('finds nothing under a missing root', () => {
    expect(findPackagedApps(pathPosix.join(root, 'absent'))).toEqual([]);
  });
});

describe('checkPackagedApp', () => {
  test('passes a Stable app whose helper the spawn-site resolver lands on', () => {
    expect(checkPackagedApp(plantApp(), passingProbe).problems).toEqual([]);
  });

  test('passes a Beta app whose helper carries the Beta product name', () => {
    const app = plantApp({ product: 'OpenKnowledge Beta' });
    expect(checkPackagedApp(app, passingProbe).problems).toEqual([]);
  });

  test('refuses a Beta app whose helper carries the Stable names', () => {
    const app = plantApp({
      product: 'OpenKnowledge Beta',
      servers: ['OpenKnowledge'],
      helperName: 'OpenKnowledge Helper',
    });
    expect(checkPackagedApp(app, passingProbe).problems).toEqual([
      expect.stringContaining("the spawn site's resolver maps"),
    ]);
  });

  test('refuses an app with no Server.app helper bundle', () => {
    const app = plantApp({ servers: [] });
    expect(checkPackagedApp(app, passingProbe).problems).toEqual([
      expect.stringContaining('holds 0 "* Server.app" helper bundles'),
    ]);
  });

  test('refuses an app with two Server.app helper bundles', () => {
    const app = plantApp({ servers: ['OpenKnowledge', 'OpenKnowledge Extra'] });
    expect(checkPackagedApp(app, passingProbe).problems).toEqual([
      expect.stringContaining('holds 2 "* Server.app" helper bundles'),
    ]);
  });

  test('refuses a helper bundle whose executable is missing', () => {
    const app = plantApp({ helper: null });
    expect(checkPackagedApp(app, passingProbe).problems).toEqual([
      expect.stringContaining(
        `${helperOf(app, 'OpenKnowledge', 'OpenKnowledge Helper')}, which does not exist`,
      ),
    ]);
  });
});

describe('helperProbeProblems', () => {
  test('accepts a helper that runs as Node', () => {
    expect(helperProbeProblems(passingProbe())).toEqual([]);
  });

  test('refuses a helper killed by SIGTRAP', () => {
    expect(
      helperProbeProblems({ status: null, signal: 'SIGTRAP', stdout: '', stderr: '' }),
    ).toContain('it was killed by SIGTRAP');
  });

  test('refuses a helper that cannot load Electron Framework', () => {
    const problems = helperProbeProblems({
      status: 1,
      signal: null,
      stdout: '',
      stderr: 'dyld[1]: Library not loaded: @rpath/Electron Framework.framework/Electron Framework',
    });
    expect(problems).toEqual([
      'it exited 1',
      expect.stringContaining('lacks the "ok-helper-node-mode <version>" line'),
      expect.stringContaining('Library not loaded'),
    ]);
  });

  test('refuses a helper that exits 0 in Node mode but writes to stderr', () => {
    expect(
      helperProbeProblems({
        status: 0,
        signal: null,
        stdout: 'ok-helper-node-mode 24.18.0\n',
        stderr: 'unexpected diagnostic\n',
      }),
    ).toEqual(['it wrote to stderr: "unexpected diagnostic\\n"']);
  });

  test('refuses a zero exit without the Node-mode line', () => {
    expect(
      helperProbeProblems({ status: 0, signal: null, stdout: 'renderer\n', stderr: '' }),
    ).toEqual([expect.stringContaining('lacks the "ok-helper-node-mode <version>" line')]);
  });

  test('refuses a helper that could not be spawned', () => {
    const enoent = Object.assign(new Error('spawnSync helper ENOENT'), { code: 'ENOENT' });
    expect(helperProbeProblems({ error: enoent, status: null, signal: null })).toEqual([
      'it could not be run: spawnSync helper ENOENT',
    ]);
  });

  test('refuses a helper that did not exit, with what it printed before the timeout', () => {
    const timeout = Object.assign(new Error('spawnSync helper ETIMEDOUT'), { code: 'ETIMEDOUT' });
    expect(
      helperProbeProblems({
        error: timeout,
        status: null,
        signal: 'SIGTERM',
        stdout: 'partial\n',
        stderr: 'boot log\n',
      }),
    ).toEqual([
      `it did not exit within ${HELPER_PROBE_TIMEOUT_MS} ms`,
      'its stdout lacks the "ok-helper-node-mode <version>" line: "partial\\n"',
      'it wrote to stderr: "boot log\\n"',
    ]);
  });

  test('accepts a real Node binary probed the way the packaged helper is', () => {
    expect(helperProbeProblems(probeHelper(process.execPath))).toEqual([]);
  });
});

describe('the CLI', () => {
  test('exits 1 and names the search root when no packaged app exists', () => {
    const result = runCli(root, 'self-test');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`::error::self-test: no packaged mac-*/*.app under ${root}`);
  });

  test('exits 1 and names the helper when the helper cannot run', () => {
    const app = plantApp({ helper: 'not an executable', helperMode: 0o644 });
    const result = runCli(root, 'self-test');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${helperOf(app, 'OpenKnowledge', 'OpenKnowledge Helper')} under ELECTRON_RUN_AS_NODE=1: it could not be run`,
    );
  });

  test('exits 1 when the helper exits non-zero with a dyld error', (ctx) => {
    ctx.skip(process.platform === 'win32', 'a POSIX shell script plays the macOS helper binary');
    plantApp({ helper: DYLD_FAILING_HELPER });
    const result = runCli(root, 'self-test');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('it exited 1');
    expect(result.stderr).toContain('Library not loaded');
  });

  test('checks every app, and one bad app fails the run', (ctx) => {
    ctx.skip(process.platform === 'win32', 'a POSIX shell script plays the macOS helper binary');
    const good = plantApp();
    const bad = plantApp({ arch: 'mac-x64', helper: DYLD_FAILING_HELPER });
    const result = runCli(root, 'self-test');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      `packaged helper OK (self-test): ${helperOf(good, 'OpenKnowledge', 'OpenKnowledge Helper')}`,
    );
    expect(result.stderr).toContain(
      `${helperOf(bad, 'OpenKnowledge', 'OpenKnowledge Helper')} under ELECTRON_RUN_AS_NODE=1: it exited 1`,
    );
  });

  test('exits 1 and names a mac-* directory it cannot read', (ctx) => {
    ctx.skip(
      process.platform === 'win32' || process.getuid?.() === 0,
      'a mode-000 directory keeps out only a non-root POSIX reader',
    );
    plantApp({ arch: 'mac-universal', product: 'OpenKnowledge Beta' });
    const unreadable = pathPosix.dirname(plantApp());
    chmodSync(unreadable, 0o000);
    const result = runCli(root, 'self-test');
    chmodSync(unreadable, 0o755);
    expect(result.stderr).toContain(`EACCES: permission denied, scandir '${unreadable}'`);
    expect(result.status).toBe(1);
  });

  test('exits 0 when every app carries a helper that runs as Node', (ctx) => {
    ctx.skip(process.platform === 'win32', 'a POSIX shell script plays the macOS helper binary');
    plantApp();
    plantApp({ arch: 'mac-universal', product: 'OpenKnowledge Beta' });
    const result = runCli(root, 'self-test');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`packaged helper: 2 app(s) checked under ${root}`);
  });
});
