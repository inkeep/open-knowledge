import { EventEmitter } from 'node:events';
import { cp, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { DmgMountError, MOUNT_ERROR_CODES, withMountedDmg } from './dmg-mount.mjs';

function makeDeps({ attachFails = false, apps = ['OpenKnowledge.app'], proc } = {}) {
  const calls = [];
  const removed = [];
  let tmpCounter = 0;
  return {
    calls,
    removed,
    deps: {
      runCommand: async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (attachFails && args[0] === 'attach') {
          throw new Error('hdiutil exited 1: no mountable file systems');
        }
      },
      mkdtemp: async (prefix) => `${prefix}${++tmpCounter}`,
      cp: async () => {},
      rm: async (p) => {
        removed.push(p);
      },
      listAppsInMount: async () => apps,
      process: proc ?? new EventEmitter(),
    },
  };
}

function fakeProcess() {
  const emitter = new EventEmitter();
  emitter.exitCodes = [];
  emitter.exit = (code) => {
    emitter.exitCodes.push(code);
  };
  return emitter;
}

describe('withMountedDmg', () => {
  test('mounts read-only + nobrowse, copies the app out, detaches, then calls back', async () => {
    const { calls, deps } = makeDeps();
    let seen = null;

    const result = await withMountedDmg(
      '/tmp/OpenKnowledge.dmg',
      async (appPath) => {
        seen = appPath;
        expect(calls.some((c) => c[0] === 'hdiutil' && c[1] === 'detach')).toBe(true);
        return 'callback-result';
      },
      deps,
    );

    expect(result).toBe('callback-result');
    expect(seen).toMatch(/OpenKnowledge\.app$/);
    expect(seen).not.toMatch(/ok-dmg-mount-/);

    const attach = calls.find((c) => c[1] === 'attach');
    expect(attach).toBeDefined();
    expect(attach).toContain('-nobrowse');
    expect(attach).toContain('-readonly');
    expect(attach).toContain('-mountpoint');
  });

  test('copies an Electron-shaped bundle without absolutizing its relative symlinks', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'ok-dmg-mount-test-'));
    const framework = join(
      scratch,
      'OpenKnowledge.app/Contents/Frameworks/Electron Framework.framework',
    );
    await mkdir(join(framework, 'Versions/A'), { recursive: true });
    await writeFile(join(framework, 'Versions/A/Electron Framework'), 'mach-o');
    await symlink('A', join(framework, 'Versions/Current'));
    await symlink('Versions/Current/Electron Framework', join(framework, 'Electron Framework'));

    let linkTarget = null;
    await withMountedDmg(
      '/tmp/OpenKnowledge.dmg',
      async (appPath) => {
        linkTarget = await readlink(
          join(appPath, 'Contents/Frameworks/Electron Framework.framework/Electron Framework'),
        );
      },
      {
        runCommand: async () => {},
        mkdtemp: async (prefix) =>
          prefix.includes('ok-dmg-mount-') ? scratch : await mkdtemp(prefix),
        cp,
        rm,
        listAppsInMount: async () => ['OpenKnowledge.app'],
        process: new EventEmitter(),
      },
    );

    expect(linkTarget).toBe('Versions/Current/Electron Framework');
    expect(isAbsolute(linkTarget)).toBe(false);

    await rm(scratch, { recursive: true, force: true });
  });

  test('detaches before the callback error propagates', async () => {
    const { calls, deps } = makeDeps();

    await expect(
      withMountedDmg(
        '/tmp/OpenKnowledge.dmg',
        async () => {
          throw new Error('smoke run blew up');
        },
        deps,
      ),
    ).rejects.toThrow('smoke run blew up');

    expect(calls.filter((c) => c[1] === 'detach')).toHaveLength(1);
  });

  test('cleans up the copy and the mountpoint even when the callback throws', async () => {
    const { removed, deps } = makeDeps();

    await expect(
      withMountedDmg(
        '/tmp/OpenKnowledge.dmg',
        async () => {
          throw new Error('boom');
        },
        deps,
      ),
    ).rejects.toThrow('boom');

    expect(removed.some((p) => p.includes('ok-dmg-app-'))).toBe(true);
    expect(removed.some((p) => p.includes('ok-dmg-mount-'))).toBe(true);
  });

  test('attach failure throws with the hdiutil stderr and leaves no mountpoint behind', async () => {
    const { removed, deps } = makeDeps({ attachFails: true });
    let called = false;

    const err = await withMountedDmg(
      '/tmp/broken.dmg',
      async () => {
        called = true;
      },
      deps,
    ).catch((e) => e);

    expect(called).toBe(false);
    expect(err).toBeInstanceOf(DmgMountError);
    expect(err.code).toBe(MOUNT_ERROR_CODES.attachFailed);
    expect(err.message).toContain('no mountable file systems');
    expect(removed.some((p) => p.includes('ok-dmg-mount-'))).toBe(true);
  });

  test('an empty volume detaches and throws a distinct no-app-bundle error', async () => {
    const { calls, deps } = makeDeps({ apps: [] });

    const err = await withMountedDmg('/tmp/empty.dmg', async () => 'unreachable', deps).catch(
      (e) => e,
    );

    expect(err).toBeInstanceOf(DmgMountError);
    expect(err.code).toBe(MOUNT_ERROR_CODES.noAppBundle);
    expect(err.code).not.toBe(MOUNT_ERROR_CODES.attachFailed);
    expect(calls.filter((c) => c[1] === 'detach')).toHaveLength(1);
  });

  test('SIGTERM while the callback runs detaches and exits', async () => {
    const proc = fakeProcess();
    const { calls, deps } = makeDeps({ proc });

    await withMountedDmg(
      '/tmp/OpenKnowledge.dmg',
      async () => {
        proc.emit('SIGTERM');
        await Promise.resolve();
      },
      deps,
    );

    expect(proc.exitCodes).toEqual([143]);
    expect(calls.some((c) => c[1] === 'detach')).toBe(true);
  });

  test('SIGINT during mount acquisition detaches before exiting', async () => {
    const proc = fakeProcess();
    const calls = [];
    const removed = [];
    let tmpCounter = 0;

    await withMountedDmg('/tmp/OpenKnowledge.dmg', async () => {}, {
      runCommand: async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (args[0] === 'attach') {
          proc.emit('SIGINT');
          await Promise.resolve();
        }
      },
      mkdtemp: async (prefix) => `${prefix}${++tmpCounter}`,
      cp: async () => {},
      rm: async (p) => {
        removed.push(p);
      },
      listAppsInMount: async () => ['OpenKnowledge.app'],
      process: proc,
    });

    expect(proc.exitCodes).toEqual([130]);
    expect(calls.some((c) => c[1] === 'detach')).toBe(true);
    expect(removed.some((p) => p.includes('ok-dmg-mount-'))).toBe(true);
  });

  test('de-registers its signal handlers so repeated mounts do not leak listeners', async () => {
    const proc = fakeProcess();

    for (let i = 0; i < 5; i += 1) {
      const { deps } = makeDeps({ proc });
      await withMountedDmg('/tmp/OpenKnowledge.dmg', async () => {}, deps);
    }

    expect(proc.listenerCount('SIGINT')).toBe(0);
    expect(proc.listenerCount('SIGTERM')).toBe(0);
  });

  test('de-registers its signal handlers when the mount fails', async () => {
    const proc = fakeProcess();
    const { deps } = makeDeps({ attachFails: true, proc });

    await withMountedDmg('/tmp/broken.dmg', async () => {}, deps).catch(() => {});

    expect(proc.listenerCount('SIGINT')).toBe(0);
    expect(proc.listenerCount('SIGTERM')).toBe(0);
  });
});

describe('cleanup failures are logged, not silently swallowed', () => {
  test('a failing detach warns and still does not throw', async () => {
    const warnings = [];
    const { deps } = makeDeps();
    deps.runCommand = async (_cmd, args) => {
      if (args[0] === 'detach') throw new Error('hdiutil: detach failed - Resource busy');
      return undefined;
    };
    deps.warn = (m) => warnings.push(m);

    await expect(withMountedDmg('/tmp/OpenKnowledge.dmg', async () => 'ok', deps)).resolves.toBe(
      'ok',
    );
    expect(warnings.join('\n')).toContain('Resource busy');
    expect(warnings.join('\n')).toContain('detach failed');
  });

  test('a failing scratch removal warns for each path', async () => {
    const warnings = [];
    const { deps } = makeDeps();
    deps.rm = async (p) => {
      throw new Error(`EPERM: operation not permitted, rm '${p}'`);
    };
    deps.warn = (m) => warnings.push(m);

    await withMountedDmg('/tmp/OpenKnowledge.dmg', async () => {}, deps);
    expect(warnings.filter((w) => w.includes('EPERM'))).toHaveLength(2);
    expect(warnings.join('\n')).toContain('ok-dmg-app-');
    expect(warnings.join('\n')).toContain('ok-dmg-mount-');
  });
});
