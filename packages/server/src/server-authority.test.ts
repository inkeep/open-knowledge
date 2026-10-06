import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { withHiddenWindowsConsole } from './child-process-windows-hide.ts';
import {
  acquireServerAuthority,
  type ContentScope,
  classifyServerAuthorityRegistryError,
  contentScopeContainsPath,
  contentScopesOverlap,
  ServerAuthorityCollisionError,
  ServerAuthorityRegistryError,
} from './server-authority.ts';
import { ServerAuthorityLeaseVerificationError } from './server-authority-lease.ts';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
}));

const root = resolve('/authority');
const tree = (path = root, excluded: string[] = []): ContentScope => ({
  kind: 'tree',
  path,
  excluded,
});
const file = (path = join(root, 'notes.md')): ContentScope => ({ kind: 'file', path });

describe('contentScopesOverlap', () => {
  test.each<[string, ContentScope, ContentScope, boolean]>([
    ['equal roots', tree(), tree(), true],
    ['nested roots', tree(), tree(join(root, 'child')), true],
    ['boundary-prefix siblings', tree(), tree(`${root}-other`), false],
    ['separate roots', tree(), tree(resolve('/elsewhere')), false],
    ['filesystem root', tree(resolve('/')), tree(), true],
    ['same file', file(), file(), true],
    ['distinct files', file(), file(join(root, 'other.md')), false],
    ['distinct extensions', file(), file(join(root, 'notes.mdx')), false],
    ['file in tree', file(), tree(), true],
    ['file outside tree', file(), tree(join(root, 'child')), false],
    ['excluded child tree', tree(root, [join(root, 'child')]), tree(join(root, 'child')), false],
    [
      'excluded grandchild tree',
      tree(root, [join(root, 'child')]),
      tree(join(root, 'child', 'docs')),
      false,
    ],
    [
      'excluded file',
      tree(root, [join(root, 'child')]),
      file(join(root, 'child', 'notes.md')),
      false,
    ],
    [
      'exclusion does not exclude boundary-prefix sibling',
      tree(root, [join(root, 'child')]),
      tree(join(root, 'child-other')),
      true,
    ],
    [
      'partial exclusions do not make overlapping trees disjoint',
      tree(root, [join(root, 'child')]),
      tree(root, [join(root, 'elsewhere')]),
      true,
    ],
  ])('%s', (_label, left, right, overlaps) => {
    expect(contentScopesOverlap(left, right)).toBe(overlaps);
    expect(contentScopesOverlap(right, left)).toBe(overlaps);
  });
});

test('path membership agrees with overlap and exact-file identity', () => {
  expect(contentScopeContainsPath(tree(), join(root, 'child', 'notes.md'))).toBe(true);
  expect(contentScopeContainsPath(tree(), `${root}-other/notes.md`)).toBe(false);
  expect(contentScopeContainsPath(tree(resolve('/')), root)).toBe(true);
  expect(contentScopeContainsPath(tree(root, [join(root, 'child')]), join(root, 'child'))).toBe(
    false,
  );
  expect(contentScopeContainsPath(file(), join(root, 'notes.md'))).toBe(true);
  expect(contentScopeContainsPath(file(), join(root, 'notes.md', 'child'))).toBe(false);
  expect(contentScopeContainsPath(tree(resolve('/')), 'relative.md')).toBe(false);
});

const replySchema = z.object({
  status: z.enum(['ready', 'acquired', 'released', 'error']),
  name: z.string().optional(),
  message: z.string().optional(),
  pid: z.number().optional(),
});

const driver = `
const { acquireServerAuthority } = await import(process.env.AUTHORITY_MODULE);
let claim;
process.on('message', command => {
  try {
    if (command === 'acquire') {
      claim = acquireServerAuthority(JSON.parse(process.env.AUTHORITY_OPTIONS));
      process.send({ status: 'acquired', pid: process.pid });
    } else if (command === 'release') {
      claim.release();
      process.send({ status: 'released' });
    } else if (command === 'exit') {
      process.exit(0);
    }
  } catch (error) {
    process.send({ status: 'error', name: error.name, message: error.message });
  }
});
process.send({ status: 'ready' });
`;

let directory: string;
let registryPath: string;
const releases: Array<() => void> = [];
const workers: Array<{ child: ChildProcess; exited: Promise<void> }> = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'ok-server-authority-'));
  registryPath = join(directory, 'runtime', 'authority.sqlite');
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const release of releases.splice(0)) release();
  for (const { child, exited } of workers.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
  rmSync(directory, { recursive: true, force: true });
});

function claim(scope: ContentScope, serverInstanceId = randomUUID()) {
  const handle = acquireServerAuthority({
    scope,
    projectDir: join(directory, serverInstanceId),
    serverInstanceId,
    registryPath,
  });
  releases.push(handle.release);
  return handle;
}

async function startWorker(scope: ContentScope) {
  let pending = Promise.withResolvers<z.infer<typeof replySchema>>();
  let stderr = '';
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', driver],
    withHiddenWindowsConsole({
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: {
        ...process.env,
        AUTHORITY_MODULE: new URL('./server-authority.ts', import.meta.url).href,
        AUTHORITY_OPTIONS: JSON.stringify({
          scope,
          projectDir: join(directory, randomUUID()),
          serverInstanceId: randomUUID(),
          registryPath,
        }),
      },
    }),
  );
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on('message', (message) => {
    const parsed = replySchema.safeParse(message);
    if (parsed.success) pending.resolve(parsed.data);
    else pending.reject(parsed.error);
  });
  child.on('error', (error) => pending.reject(error));
  const exited = new Promise<void>((resolveExit) => {
    child.once('close', (code, signal) => {
      pending.reject(new Error(`Authority worker exited (${code}, ${signal}): ${stderr}`));
      resolveExit();
    });
  });
  workers.push({ child, exited });
  expect((await pending.promise).status).toBe('ready');
  return {
    child,
    exited,
    exit() {
      child.send('exit');
      return exited;
    },
    send(command: 'acquire' | 'release') {
      pending = Promise.withResolvers<z.infer<typeof replySchema>>();
      child.send(command);
      return pending.promise;
    },
  };
}

describe('acquireServerAuthority', () => {
  test.each([
    [517, 'contention'],
    [261, 'contention'],
    [779, 'invalid-data'],
    [13, 'unknown'],
  ] as const)(
    'extended SQLite result %s reports %s without a false permissions remedy',
    (errcode, expected) => {
      const cause = Object.assign(new Error('SQLite failure'), { errcode });
      expect(classifyServerAuthorityRegistryError(cause)).toBe(expected);
      const error = new ServerAuthorityRegistryError(expected, registryPath, cause);
      expect(error.kind).toBe(expected);
      expect(error.cause).toBe(cause);
      expect(error.registryPath).toBe(registryPath);
      expect(error.message).toContain('SQLite failure');
      expect(error.message).not.toContain('writable OS-account home');
    },
  );
  test('same-process different instances cannot claim overlapping scopes', () => {
    const id = randomUUID();
    claim(tree(), id);
    try {
      claim(file());
      expect.fail('Overlapping authority must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(ServerAuthorityCollisionError);
      if (!(error instanceof ServerAuthorityCollisionError)) throw error;
      expect(error.existing).toMatchObject({
        pid: process.pid,
        projectDir: join(directory, id),
        scope: tree(),
      });
    }
  });

  test('disjoint scopes coexist and release is idempotent without deleting a replacement', () => {
    const id = randomUUID();
    const first = claim(file(), id);
    const second = claim(file(join(root, 'other.md')));
    first.release();
    claim(file(), id);
    first.release();
    expect(() => claim(file())).toThrow(ServerAuthorityCollisionError);
    second.release();
    expect(() => claim(file(join(root, 'other.md')))).not.toThrow();
  });

  test('claim scope is an immutable snapshot rather than the caller array', () => {
    const excluded = [join(root, 'child')];
    const input = { kind: 'tree' as const, path: root, excluded };
    const handle = claim(input);
    excluded.push(join(root, 'new-child'));
    input.path = resolve('/changed');
    expect(handle.scope).toEqual(tree(root, [join(root, 'child')]));
    expect(Object.isFrozen(handle.scope)).toBe(true);
    expect(handle.scope.kind === 'tree' && Object.isFrozen(handle.scope.excluded)).toBe(true);
    expect(() => claim(tree(join(root, 'new-child')))).toThrow(ServerAuthorityCollisionError);
    expect(() => claim(tree(join(root, 'child')))).not.toThrow();
  });

  test('an unreleased handle cannot delete a row whose ownership token was replaced', () => {
    const handle = claim(tree());
    const db = new DatabaseSync(registryPath);
    try {
      db.prepare('UPDATE server_authority SET owner_token = ?').run(randomUUID());
    } finally {
      db.close();
    }
    handle.release();
    expect(() => claim(tree())).toThrow(ServerAuthorityCollisionError);
  });

  test.each([
    tree('relative'),
    tree(root, [root]),
    tree(root, [resolve('/outside')]),
    file('relative.md'),
  ])('invalid scope is refused without reserving authority: %j', (scope) => {
    expect(() => claim(scope)).toThrow();
    expect(() => claim(tree())).not.toThrow();
  });

  test('corrupt registry fails closed instead of resetting it', () => {
    writeFileSync(join(directory, 'corrupt.sqlite'), 'not a SQLite database');
    registryPath = join(directory, 'corrupt.sqlite');
    expect(() => claim(tree())).toThrow(ServerAuthorityRegistryError);
    expect(() => claim(tree())).toThrow(registryPath);
    expect(() => claim(tree())).toThrow(/Never remove either while a server is running/);
  });

  test('unwritable registry location fails closed', () => {
    const parentFile = join(directory, 'not-a-directory');
    writeFileSync(parentFile, 'file');
    registryPath = join(parentFile, 'authority.sqlite');
    expect(() => claim(tree())).toThrow();
  });

  test('an unknown registry version fails closed without erasing a held scope', () => {
    const handle = claim(tree());
    const db = new DatabaseSync(registryPath);
    try {
      db.exec('PRAGMA user_version = 999');
      expect(() => claim(file())).toThrow(
        'This runtime does not support the content ownership registry version.',
      );
      db.exec('PRAGMA user_version = 2');
      expect(() => claim(file())).toThrow(ServerAuthorityCollisionError);
    } finally {
      db.close();
      handle.release();
    }
  });

  test('the known empty unreleased v1 layout upgrades atomically without discarding any claim', () => {
    mkdirSync(dirname(registryPath), { recursive: true });
    const database = new DatabaseSync(registryPath);
    database.exec(`CREATE TABLE server_authority (
      server_instance_id TEXT PRIMARY KEY, owner_token TEXT NOT NULL, pid INTEGER NOT NULL,
      hostname TEXT NOT NULL, machine_id TEXT NOT NULL, project_dir TEXT NOT NULL,
      scope_json TEXT NOT NULL, started_at TEXT NOT NULL
    ) STRICT; PRAGMA user_version = 1`);
    database.close();
    claim(tree());
    const check = new DatabaseSync(registryPath);
    try {
      expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
      expect(
        check.prepare('SELECT lease_protocol FROM server_authority').get()?.lease_protocol,
      ).toBe('sqlite-lifetime-lease:v1');
    } finally {
      check.close();
    }
  });

  test.each(['nonempty', 'different-columns'] as const)(
    'a %s v1 layout is retained with actionable retired-format recovery',
    (state) => {
      mkdirSync(dirname(registryPath), { recursive: true });
      const database = new DatabaseSync(registryPath);
      try {
        if (state === 'nonempty') {
          database.exec(`CREATE TABLE server_authority (
          server_instance_id TEXT PRIMARY KEY, owner_token TEXT NOT NULL, pid INTEGER NOT NULL,
          hostname TEXT NOT NULL, machine_id TEXT NOT NULL, project_dir TEXT NOT NULL,
          scope_json TEXT NOT NULL, started_at TEXT NOT NULL
        ) STRICT`);
          database
            .prepare('INSERT INTO server_authority VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(
              randomUUID(),
              randomUUID(),
              process.pid,
              'legacy',
              'legacy',
              directory,
              JSON.stringify(tree()),
              new Date().toISOString(),
            );
        } else database.exec('CREATE TABLE server_authority (unexpected TEXT) STRICT');
        database.exec('PRAGMA user_version = 1');
        const rows = database.prepare('SELECT * FROM server_authority').all();
        const columns = database.prepare('PRAGMA table_info(server_authority)').all();
        try {
          claim(tree());
          expect.fail('Retired layout must not be discarded');
        } catch (error) {
          expect(error).toBeInstanceOf(ServerAuthorityRegistryError);
          expect((error as ServerAuthorityRegistryError).kind).toBe('retired-version');
          expect((error as Error).message).toContain(
            'This runtime no longer reads the retired pre-release content ownership registry layout.',
          );
          expect((error as Error).message).toContain(`Registry: ${registryPath}.`);
          expect((error as Error).message).not.toContain('Version 1.');
          expect((error as Error).message).toContain('ok stop all');
          expect((error as Error).message).toContain('-journal');
        }
        expect(database.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
        expect(database.prepare('SELECT * FROM server_authority').all()).toEqual(rows);
        expect(database.prepare('PRAGMA table_info(server_authority)').all()).toEqual(columns);
      } finally {
        database.close();
      }
    },
  );

  test('optional orphan collection failure cannot refuse a valid acquisition', () => {
    const read = vi.spyOn(fs, 'readdirSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('Garbage collection descriptor limit'), { code: 'EMFILE' });
    });
    expect(() => claim(tree())).not.toThrow();
    expect(read).toHaveBeenCalledOnce();
    read.mockRestore();
    const check = new DatabaseSync(registryPath);
    try {
      expect(check.prepare('SELECT scope_json FROM server_authority').get()?.scope_json).toBe(
        JSON.stringify(tree()),
      );
    } finally {
      check.close();
    }
  });

  test('a malformed holder record fails closed rather than being treated as stale', () => {
    claim(tree());
    const db = new DatabaseSync(registryPath);
    try {
      db.prepare('UPDATE server_authority SET pid = ?').run(0);
    } finally {
      db.close();
    }
    expect(() => claim(file(join(root, 'other.md')))).toThrow();
  });

  test('unexpected process-probe failure cannot reclaim a live holder', () => {
    claim(tree());
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('Unknown probe failure'), { code: 'EINVAL' });
    });
    expect(() => claim(tree())).toThrow(ServerAuthorityCollisionError);
  });

  test('EPERM process-probe failure cannot reclaim a live holder', () => {
    claim(tree());
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('Permission denied'), { code: 'EPERM' });
    });
    expect(() => claim(tree())).toThrow(ServerAuthorityCollisionError);
  });

  test('independent simultaneous conflicting starts grant exactly one lifetime claim', async () => {
    const [left, right] = await Promise.all([
      startWorker(tree()),
      startWorker(tree(join(root, 'child'))),
    ]);
    const replies = await Promise.all([left.send('acquire'), right.send('acquire')]);
    expect(replies.map((reply) => reply.status).sort()).toEqual(['acquired', 'error']);
    expect(replies.find((reply) => reply.status === 'error')?.name).toBe(
      'ServerAuthorityCollisionError',
    );
    expect(() => claim(file(join(root, 'child', 'notes.md')))).toThrow(
      ServerAuthorityCollisionError,
    );
  });

  test('independent simultaneous disjoint file previews both retain authority', async () => {
    const [left, right] = await Promise.all([
      startWorker(file()),
      startWorker(file(join(root, 'other.md'))),
    ]);
    const replies = await Promise.all([left.send('acquire'), right.send('acquire')]);
    expect(replies.map((reply) => reply.status)).toEqual(['acquired', 'acquired']);
    expect(() => claim(tree())).toThrow(ServerAuthorityCollisionError);
    expect((await left.send('release')).status).toBe('released');
    expect(() => claim(file())).not.toThrow();
    expect(() => claim(file(join(root, 'other.md')))).toThrow(ServerAuthorityCollisionError);
  });

  test('independent parent and excluded child trees can acquire concurrently', async () => {
    const childRoot = join(root, 'child');
    const [parent, child] = await Promise.all([
      startWorker(tree(root, [childRoot])),
      startWorker(tree(childRoot)),
    ]);
    const replies = await Promise.all([parent.send('acquire'), child.send('acquire')]);
    expect(replies.map((reply) => reply.status)).toEqual(['acquired', 'acquired']);
    expect(() => claim(file(join(childRoot, 'notes.md')))).toThrow(ServerAuthorityCollisionError);
    expect(() => claim(file())).toThrow(ServerAuthorityCollisionError);
  });

  test('a crashed holder is pruned only after its process actually exits', async () => {
    const worker = await startWorker(tree());
    expect((await worker.send('acquire')).status).toBe('acquired');
    expect(() => claim(tree())).toThrow(ServerAuthorityCollisionError);
    worker.child.kill('SIGKILL');
    await worker.exited;
    expect(() => claim(tree())).not.toThrow();
  });

  test.each(['missing', 'wal', 'mismatched-token', 'garbage', 'present-unreadable'] as const)(
    'an unverifiable %s lease protects only its recorded scope',
    async (damage) => {
      const worker = await startWorker(tree());
      expect((await worker.send('acquire')).status).toBe('acquired');
      worker.child.kill('SIGKILL');
      await worker.exited;
      const registry = new DatabaseSync(registryPath);
      const token = registry.prepare('SELECT owner_token FROM server_authority').get()?.owner_token;
      registry.close();
      if (typeof token !== 'string') throw new Error('Owner token absent');
      const path = join(dirname(registryPath), 'server-authority-leases', `${token}.sqlite`);
      if (damage === 'missing') unlinkSync(path);
      else if (damage === 'garbage') writeFileSync(path, 'not a SQLite lease');
      else if (damage === 'present-unreadable') {
        unlinkSync(path);
        mkdirSync(path);
      } else {
        const lease = new DatabaseSync(path);
        if (damage === 'wal') lease.exec('PRAGMA journal_mode=WAL');
        else lease.prepare('UPDATE lease SET owner_token = ?').run(randomUUID());
        lease.close();
      }
      expect(() => claim(tree(`${root}-disjoint`))).not.toThrow();
      try {
        claim(tree());
        expect.fail('Unverifiable ownership must remain protected');
      } catch (error) {
        expect(error).toBeInstanceOf(ServerAuthorityCollisionError);
        expect((error as ServerAuthorityCollisionError).verifiedLease).toBe(false);
        expect((error as ServerAuthorityCollisionError).leasePath).toBe(path);
        expect((error as Error).cause).toBeInstanceOf(ServerAuthorityLeaseVerificationError);
        expect(((error as Error).cause as ServerAuthorityLeaseVerificationError).kind).toBe(
          damage === 'missing'
            ? 'missing'
            : damage === 'present-unreadable'
              ? 'unavailable'
              : 'invalid-data',
        );
        if (damage === 'present-unreadable') {
          expect((error as Error).message).toContain('temporarily unavailable');
          expect((error as Error).message).toContain('retry');
        } else expect((error as Error).message).not.toContain('retry');
        expect((error as Error).message).toContain('could not be verified');
        expect((error as Error).message).toContain(registryPath);
        expect((error as Error).message).toContain('ok stop all');
      }
    },
  );

  test('a live SQLite lease cannot be stolen when the holder PID is invisible', async () => {
    const worker = await startWorker(tree());
    expect((await worker.send('acquire')).status).toBe('acquired');
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('Foreign PID namespace'), { code: 'ESRCH' });
    });
    expect(() => claim(tree())).toThrow(ServerAuthorityCollisionError);
    expect(probe).not.toHaveBeenCalled();
    probe.mockRestore();
  });

  test('an exited SQLite lease is reclaimed even if the old PID now appears alive', async () => {
    const worker = await startWorker(tree());
    expect((await worker.send('acquire')).status).toBe('acquired');
    worker.child.kill('SIGKILL');
    await worker.exited;
    const probe = vi.spyOn(process, 'kill').mockReturnValue(true);
    expect(() => claim(tree())).not.toThrow();
    expect(probe).not.toHaveBeenCalled();
    probe.mockRestore();
  });

  test('crash reclamation ignores the recorded PID display metadata', async () => {
    const worker = await startWorker(tree());
    expect((await worker.send('acquire')).status).toBe('acquired');
    const db = new DatabaseSync(registryPath);
    try {
      db.prepare('UPDATE server_authority SET pid = ?').run(process.pid);
    } finally {
      db.close();
    }
    expect(() => claim(tree())).toThrow(ServerAuthorityCollisionError);
    worker.child.kill('SIGKILL');
    await worker.exited;
    expect(() => claim(tree())).not.toThrow();
  });

  test('an unrecognized lifetime-lease protocol fails closed', async () => {
    const worker = await startWorker(tree());
    expect((await worker.send('acquire')).status).toBe('acquired');
    const db = new DatabaseSync(registryPath);
    try {
      db.prepare('UPDATE server_authority SET lease_protocol = ?').run('unknown-protocol');
    } finally {
      db.close();
    }
    worker.child.kill('SIGKILL');
    await worker.exited;
    try {
      claim(tree());
      expect.fail('Unknown lease protocols must remain protected');
    } catch (error) {
      expect(error).toBeInstanceOf(ServerAuthorityCollisionError);
      expect((error as ServerAuthorityCollisionError).verifiedLease).toBe(false);
      expect((error as ServerAuthorityCollisionError).leasePath).toBeUndefined();
      expect((error as Error).message).toContain('unknown-protocol');
      expect((error as Error).message).toContain('compatible version');
      expect((error as Error).message).not.toContain('back up');
      expect((error as Error).message).not.toContain('remove');
    }
  });

  test('the registry is owner-only on filesystems supporting POSIX modes', () => {
    claim(tree());
    if (process.platform !== 'win32') expect(statSync(registryPath).mode & 0o777).toBe(0o600);
  });

  test('legacy rows without lifetime leases fail closed even when their old PID is gone', async () => {
    const worker = await startWorker(tree());
    expect((await worker.send('acquire')).status).toBe('acquired');
    const db = new DatabaseSync(registryPath);
    db.prepare('UPDATE server_authority SET lease_protocol = ?').run('unverified:legacy');
    db.close();
    worker.child.kill('SIGKILL');
    await worker.exited;
    expect(() => claim(tree())).toThrow(ServerAuthorityCollisionError);
  });

  test('legacy PID-domain records cannot be interpreted as lifetime-lease proof', async () => {
    const worker = await startWorker(tree());
    expect((await worker.send('acquire')).status).toBe('acquired');
    const db = new DatabaseSync(registryPath);
    try {
      db.prepare('UPDATE server_authority SET lease_protocol = ?').run(
        'process-domain:v1:linux:foreign-boot:pid:[4026539999]',
      );
    } finally {
      db.close();
    }
    worker.child.kill('SIGKILL');
    await worker.exited;
    expect(() => claim(tree())).toThrow(ServerAuthorityCollisionError);
  });

  test('normal process exit releases its own lifetime claim', async () => {
    const worker = await startWorker(tree());
    expect((await worker.send('acquire')).status).toBe('acquired');
    await worker.exit();
    const db = new DatabaseSync(registryPath);
    try {
      expect(db.prepare('SELECT * FROM server_authority').all()).toEqual([]);
    } finally {
      db.close();
    }
    expect(() => claim(tree())).not.toThrow();
  });

  test('an arbitrarily old live claim is not stolen by a timeout or TTL', async () => {
    const worker = await startWorker(tree());
    expect((await worker.send('acquire')).status).toBe('acquired');
    const db = new DatabaseSync(registryPath);
    try {
      db.prepare('UPDATE server_authority SET started_at = ?').run('1970-01-01T00:00:00.000Z');
    } finally {
      db.close();
    }
    expect(() => claim(tree())).toThrow(ServerAuthorityCollisionError);
  });
});
