import { describe, expect, mock, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyInputPath,
  loadAndRoundTrip,
  parseArgs,
  resolveBundledNativeDirInDir,
  runDriver,
} from '../../../../scripts/verify-native-config-in-packaged-dmg.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliDist = resolve(__dirname, '../../../cli/dist');

describe('parseArgs', () => {
  test('accepts a single positional', () => {
    expect(parseArgs(['node', 'script', '/Applications/OpenKnowledge.app']).inputPath).toBe(
      '/Applications/OpenKnowledge.app',
    );
  });

  test('rejects zero positionals', () => {
    expect(() => parseArgs(['node', 'script'])).toThrow(/Usage:/);
  });

  test('rejects multiple positionals', () => {
    expect(() => parseArgs(['node', 'script', 'a', 'b'])).toThrow(/Usage:/);
  });
});

describe('classifyInputPath', () => {
  test('recognises .dmg / .app case-insensitively', () => {
    expect(classifyInputPath('/tmp/foo.dmg')).toBe('dmg');
    expect(classifyInputPath('/tmp/Foo.DMG')).toBe('dmg');
    expect(classifyInputPath('/Applications/Foo.app')).toBe('app');
  });

  test('treats anything else as a directory', () => {
    expect(classifyInputPath('/tmp/some/dir')).toBe('dir');
    expect(classifyInputPath('packages/cli/dist')).toBe('dir');
  });
});

describe('resolveBundledNativeDirInDir', () => {
  test('finds the loader at <dir>/dist/native', () => {
    const existsSyncMock = mock((p) => p === '/proj/dist/native/index.js');
    expect(resolveBundledNativeDirInDir('/proj', { existsSync: existsSyncMock })).toBe(
      '/proj/dist/native',
    );
  });

  test('finds the loader when <dir> is itself the native dir', () => {
    const existsSyncMock = mock((p) => p === '/proj/native/index.js');
    // The first candidate '.' checks /proj/index.js (absent), then 'native'.
    expect(resolveBundledNativeDirInDir('/proj', { existsSync: existsSyncMock })).toBe(
      '/proj/native',
    );
  });

  test('returns null when no candidate holds a loader', () => {
    expect(resolveBundledNativeDirInDir('/proj', { existsSync: () => false })).toBeNull();
  });
});

describe('loadAndRoundTrip', () => {
  test('ok:true when the binding round-trips parse/upsert/symlink', () => {
    const fakeBinding = {
      parseTomlToJson: () => '{"probe":1}',
      upsertMcpServer: () => ({
        text: '[mcp_servers.open-knowledge]\n',
        changed: true,
        existed: false,
      }),
      resolveSymlinkWritePath: (p) => ({ writePath: p }),
    };
    const result = loadAndRoundTrip('/bundle/native', {
      requireModule: () => fakeBinding,
      now: () => 0,
    });
    expect(result.ok).toBe(true);
    expect(result.backend).toBe('native');
  });

  test('ok:false when the loader throws', () => {
    const result = loadAndRoundTrip('/bundle/native', {
      requireModule: () => {
        throw new Error('Cannot find native binding');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('native binding');
  });

  test('ok:false when a binding fn returns the wrong shape', () => {
    const fakeBinding = {
      parseTomlToJson: () => '{"probe":1}',
      upsertMcpServer: () => ({ changed: true }), // missing text
      resolveSymlinkWritePath: (p) => ({ writePath: p }),
    };
    const result = loadAndRoundTrip('/bundle/native', { requireModule: () => fakeBinding });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('upsertMcpServer');
  });
});

describe('runDriver (full orchestration)', () => {
  function fakeDeps(overrides = {}) {
    const messages = { stdout: [], stderr: [] };
    return {
      writeStream: (s) => messages.stdout.push(s),
      errStream: (s) => messages.stderr.push(s),
      existsSync: () => true,
      loadAndRoundTrip: () => ({ ok: true, backend: 'native', nativeDir: '/x', durationMs: 3 }),
      ...overrides,
      messages,
    };
  }

  test('exit 2 on bad argv', async () => {
    const deps = fakeDeps();
    expect(await runDriver(['node', 'script'], deps)).toBe(2);
    expect(deps.messages.stderr.join('')).toContain('Usage:');
  });

  test('exit 3 when no bundled native dir is found in a directory input', async () => {
    const deps = fakeDeps({ existsSync: () => false });
    expect(await runDriver(['node', 'script', '/tmp/proj'], deps)).toBe(3);
    expect(deps.messages.stderr.join('')).toContain('no bundled native loader');
  });

  test('exit 0 when the bundled addon loads + round-trips', async () => {
    const deps = fakeDeps();
    expect(await runDriver(['node', 'script', '/tmp/proj'], deps)).toBe(0);
    expect(deps.messages.stdout.join('')).toContain('OK');
    expect(deps.messages.stdout.join('')).toContain('native');
  });

  test('exit 1 when the addon is found but fails to load', async () => {
    const deps = fakeDeps({
      loadAndRoundTrip: () => ({ ok: false, error: 'dlopen failed', nativeDir: '/x' }),
    });
    expect(await runDriver(['node', 'script', '/tmp/proj'], deps)).toBe(1);
    expect(deps.messages.stderr.join('')).toContain('dlopen failed');
  });

  test('.app input resolves the Contents/Resources/cli/dist/native layout', async () => {
    let probed = '';
    const deps = fakeDeps({
      existsSync: (p) => {
        probed = p;
        return true;
      },
    });
    expect(await runDriver(['node', 'script', '/Applications/OpenKnowledge.app'], deps)).toBe(0);
    expect(probed).toContain('Contents/Resources/cli/dist/native/index.js');
  });

  test('.dmg input mounts, copies the .app, and detaches', async () => {
    const runCommand = mock(async () => {});
    const cpMock = mock(async () => {});
    const deps = fakeDeps({
      runCommand,
      cp: cpMock,
      mkdtemp: mock(async () => '/tmp/ok-nc-fake'),
      rm: mock(async () => {}),
      listAppsInMount: mock(async () => ['OpenKnowledge.app']),
      existsSync: () => true,
    });
    expect(await runDriver(['node', 'script', '/tmp/build.dmg'], deps)).toBe(0);
    const cmds = runCommand.mock.calls.map((c) => c[0]);
    expect(cmds.filter((c) => c === 'hdiutil').length).toBeGreaterThanOrEqual(2);
    expect(cpMock).toHaveBeenCalled();
  });
});

describe('real bundle (end-to-end, requires a built CLI)', () => {
  test('loads + round-trips the actual packages/cli/dist/native bundle', async () => {
    if (!existsSync(resolve(cliDist, 'native', 'index.js'))) {
      console.warn(
        '[verify-native-config-driver] SKIP: packages/cli/dist/native not built. ' +
          'Run `bun run build` (the gate builds it upstream of this tier).',
      );
      return;
    }
    const messages = [];
    const code = await runDriver(['node', 'script', cliDist], {
      writeStream: (s) => messages.push(s),
      errStream: (s) => messages.push(s),
    });
    expect(code).toBe(0);
    expect(messages.join('')).toContain('backend=native');
  });
});
