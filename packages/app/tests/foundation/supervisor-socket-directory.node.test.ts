import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { WorkerServerSupervisor } from '../stress/_helpers/reuse/server-supervisor.ts';
import {
  type SupervisorEndpoint,
  serveSupervisor,
} from '../stress/_helpers/reuse/supervisor-socket.ts';
import { APP_PACKAGE_ROOT } from '../stress/_helpers/seed-key.ts';

const OK_ROOT = realpathSync(join(APP_PACKAGE_ROOT, '..', '..'));
const scratchDirs: string[] = [];
const endpoints: SupervisorEndpoint[] = [];

afterEach(async () => {
  for (const endpoint of endpoints.splice(0)) await endpoint.close();
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-sockdir-')));
  scratchDirs.push(dir);
  return dir;
}

function supervisor(): WorkerServerSupervisor {
  return new WorkerServerSupervisor({
    okRoot: OK_ROOT,
    launch: () => Promise.reject(new Error('no server is launched by these cases')),
    identityTimeoutMs: 2_000,
  });
}

const runningAsRoot = process.getuid?.() === 0;

describe('the reuse supervisor serves only from a socket directory no other user can change', () => {
  test.each([
    ['world-writable', 0o777, '0777'],
    ['group-writable', 0o770, '0770'],
  ])(
    'a %s socket directory is refused and nothing is created in it',
    async (_kind, mode, shown) => {
      const shared = join(scratch(), 'shared');
      mkdirSync(shared);
      chmodSync(shared, mode);
      const socketPath = join(shared, 'supervisor.sock');

      await expect(serveSupervisor(supervisor(), socketPath)).rejects.toThrow(
        `cannot claim ${socketPath}: its directory ${shared} is group- or world-writable (mode ${shown}), so another user could replace the socket`,
      );
      expect(existsSync(socketPath)).toBe(false);
    },
  );

  test('a socket directory that is a symbolic link is refused, and the link and its target are left alone', async () => {
    const root = scratch();
    const target = join(root, 'real');
    mkdirSync(target, { mode: 0o700 });
    const linked = join(root, 'linked');
    symlinkSync(target, linked);
    const socketPath = join(linked, 'supervisor.sock');

    await expect(serveSupervisor(supervisor(), socketPath)).rejects.toThrow(
      `cannot claim ${socketPath}: its directory ${linked} is a symbolic link, so another user could replace the socket`,
    );
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(existsSync(join(target, 'supervisor.sock'))).toBe(false);
  });

  test.skipIf(runningAsRoot)(
    'a socket directory another user owns is refused even when only its owner can write it',
    async () => {
      const owned = lstatSync('/usr');
      expect(owned.uid).not.toBe(process.getuid?.());
      expect(owned.mode & 0o022).toBe(0);
      const socketPath = '/usr/ok-reuse-supervisor.sock';

      await expect(serveSupervisor(supervisor(), socketPath)).rejects.toThrow(
        `cannot claim ${socketPath}: its directory /usr is owned by uid ${owned.uid}, not by this process's uid ${process.getuid?.()}, so another user could replace the socket`,
      );
    },
  );

  test('a socket directory it creates, and the same directory when it is served again, are accepted', async () => {
    const socketPath = join(scratch(), 'new', 's.sock');

    const first = await serveSupervisor(supervisor(), socketPath);
    expect(lstatSync(join(socketPath, '..')).mode & 0o077).toBe(0);
    await first.close();
    const again = await serveSupervisor(supervisor(), socketPath);
    endpoints.push(again);

    expect(lstatSync(socketPath).isSocket()).toBe(true);
  });
});
