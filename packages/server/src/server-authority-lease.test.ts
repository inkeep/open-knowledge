import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SERVER_AUTHORITY_LEASES_DIRNAME } from '@inkeep/open-knowledge-core';
import { afterEach, expect, test, vi } from 'vitest';
import * as fsTraced from './fs-traced.ts';
import {
  acquireServerAuthorityLease,
  collectServerAuthorityLeaseOrphansUnderRegistryTransaction,
  isServerAuthorityLeaseReleased,
  removeReleasedServerAuthorityLease,
  ServerAuthorityLeaseVerificationError,
} from './server-authority-lease.ts';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ok-authority-lease-'));
  directories.push(directory);
  const ownerToken = randomUUID();
  const registryPath = join(directory, 'registry.sqlite');
  const path = join(directory, SERVER_AUTHORITY_LEASES_DIRNAME, `${ownerToken}.sqlite`);
  return { directory, ownerToken, registryPath, path };
}

test('an in-process owned lease is retained and release removes only its own file idempotently', () => {
  const { ownerToken, registryPath, path } = fixture();
  const release = acquireServerAuthorityLease(registryPath, ownerToken);
  try {
    expect(isServerAuthorityLeaseReleased(registryPath, ownerToken)).toBe(false);
    expect(existsSync(path)).toBe(true);
  } finally {
    release();
  }
  release();
  expect(existsSync(path)).toBe(false);
});

test.each([true, false])(
  'a released lease proves only its persisted owner token (matches=%s)',
  (matches) => {
    const { ownerToken, registryPath, path } = fixture();
    mkdirSync(join(path, '..'), { recursive: true });
    const database = new DatabaseSync(path);
    database.exec('CREATE TABLE lease (owner_token TEXT PRIMARY KEY) STRICT');
    database.prepare('INSERT INTO lease VALUES (?)').run(matches ? ownerToken : randomUUID());
    database.close();
    if (matches) {
      expect(isServerAuthorityLeaseReleased(registryPath, ownerToken)).toBe(true);
      removeReleasedServerAuthorityLease(registryPath, ownerToken);
      expect(existsSync(path)).toBe(false);
    } else {
      expect(() => isServerAuthorityLeaseReleased(registryPath, ownerToken)).toThrow(
        ServerAuthorityLeaseVerificationError,
      );
      expect(existsSync(path)).toBe(true);
    }
  },
);

test('a missing lease is not created or treated as proof of retirement', () => {
  const { ownerToken, registryPath, path } = fixture();
  expect(() => isServerAuthorityLeaseReleased(registryPath, ownerToken)).toThrow(
    ServerAuthorityLeaseVerificationError,
  );
  expect(existsSync(path)).toBe(false);
});

test('WAL read concurrency cannot be mistaken for a released ownership lease', () => {
  const { ownerToken, registryPath, path } = fixture();
  mkdirSync(join(path, '..'), { recursive: true });
  const database = new DatabaseSync(path);
  try {
    database.exec(
      'PRAGMA journal_mode=WAL; CREATE TABLE lease (owner_token TEXT PRIMARY KEY) STRICT',
    );
    database.prepare('INSERT INTO lease VALUES (?)').run(ownerToken);
    database.exec('BEGIN EXCLUSIVE');
    try {
      isServerAuthorityLeaseReleased(registryPath, ownerToken);
      expect.fail('WAL mode must not prove lease retirement');
    } catch (error) {
      expect(error).toBeInstanceOf(ServerAuthorityLeaseVerificationError);
      expect((error as Error).cause).toBeInstanceOf(SyntaxError);
      expect(((error as Error).cause as Error).message).toContain('DELETE-mode file locking');
    }
  } finally {
    database.close();
  }
});

test.each(['complete', 'empty-file', 'empty-table'] as const)(
  'an unreferenced %s lease is reclaimed only under a serialized registry transaction',
  (state) => {
    const { registryPath, path, ownerToken } = fixture();
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '');
    if (state !== 'empty-file') {
      const lease = new DatabaseSync(path);
      lease.exec('CREATE TABLE lease (owner_token TEXT PRIMARY KEY) STRICT');
      if (state === 'complete') lease.prepare('INSERT INTO lease VALUES (?)').run(ownerToken);
      lease.close();
    }
    const registry = new DatabaseSync(registryPath);
    registry.exec('CREATE TABLE server_authority (owner_token TEXT PRIMARY KEY) STRICT');
    try {
      expect(() =>
        collectServerAuthorityLeaseOrphansUnderRegistryTransaction(
          registryPath,
          registry,
          new Set(),
        ),
      ).toThrow('held registry transaction');
      expect(existsSync(path)).toBe(true);
      registry.exec('BEGIN IMMEDIATE');
      collectServerAuthorityLeaseOrphansUnderRegistryTransaction(registryPath, registry, new Set());
      registry.exec('COMMIT');
      expect(existsSync(path)).toBe(false);
    } finally {
      registry.close();
    }
  },
);

test('orphan collection preserves an unregistered live lease and every referenced lease', () => {
  const { registryPath, path, ownerToken } = fixture();
  const release = acquireServerAuthorityLease(registryPath, ownerToken);
  const registry = new DatabaseSync(registryPath);
  try {
    registry.exec(
      'CREATE TABLE server_authority (owner_token TEXT PRIMARY KEY) STRICT; BEGIN IMMEDIATE',
    );
    collectServerAuthorityLeaseOrphansUnderRegistryTransaction(registryPath, registry, new Set());
    expect(existsSync(path)).toBe(true);
    registry.prepare('INSERT INTO server_authority VALUES (?)').run(ownerToken);
    collectServerAuthorityLeaseOrphansUnderRegistryTransaction(
      registryPath,
      registry,
      new Set([ownerToken]),
    );
    expect(existsSync(path)).toBe(true);
    registry.exec('COMMIT');
  } finally {
    registry.close();
    release();
  }
});

test('an unlink failure cannot undo a completed lease release and its orphan can be reclaimed', () => {
  const { registryPath, path, ownerToken } = fixture();
  const release = acquireServerAuthorityLease(registryPath, ownerToken);
  const unlink = vi.spyOn(fsTraced, 'tracedUnlinkSync').mockImplementationOnce(() => {
    throw Object.assign(new Error('Cleanup busy'), { code: 'EBUSY' });
  });
  expect(() => release()).not.toThrow();
  expect(isServerAuthorityLeaseReleased(registryPath, ownerToken)).toBe(true);
  release();
  expect(unlink).toHaveBeenCalledTimes(1);
  unlink.mockRestore();
  const registry = new DatabaseSync(registryPath);
  try {
    registry.exec(
      'CREATE TABLE server_authority (owner_token TEXT PRIMARY KEY) STRICT; BEGIN IMMEDIATE',
    );
    collectServerAuthorityLeaseOrphansUnderRegistryTransaction(registryPath, registry, new Set());
    registry.exec('COMMIT');
    expect(existsSync(path)).toBe(false);
  } finally {
    registry.close();
  }
});

test('failed lease construction preserves its primary error despite cleanup failures', () => {
  const { registryPath, ownerToken } = fixture();
  const primary = new Error('Primary SQLite fault');
  const close = DatabaseSync.prototype.close;
  vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementationOnce(() => {
    throw primary;
  });
  vi.spyOn(DatabaseSync.prototype, 'close').mockImplementationOnce(function () {
    close.call(this);
    throw new Error('Secondary close fault');
  });
  vi.spyOn(fsTraced, 'tracedUnlinkSync').mockImplementationOnce(() => {
    throw Object.assign(new Error('Secondary unlink fault'), { code: 'EBUSY' });
  });
  expect(() => acquireServerAuthorityLease(registryPath, ownerToken)).toThrow(primary);
});
