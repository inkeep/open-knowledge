import { lstatSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SERVER_AUTHORITY_LEASES_DIRNAME } from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import { tracedMkdirSync, tracedUnlinkSync, tracedWriteFileSync } from './fs-traced.ts';
import { getLogger } from './logger.ts';

export const SERVER_AUTHORITY_LEASE_PROTOCOL = 'sqlite-lifetime-lease:v1';
const heldLeases = new Set<string>();

export class ServerAuthorityLeaseVerificationError extends Error {
  readonly leasePath: string;
  readonly kind: 'missing' | 'invalid-data' | 'unavailable';
  constructor(leasePath: string, cause: unknown) {
    super(`Content ownership lease could not be verified at ${leasePath}`, { cause });
    this.name = 'ServerAuthorityLeaseVerificationError';
    this.leasePath = leasePath;
    const value = cause as { code?: string; errcode?: number };
    const sqliteCode = typeof value?.errcode === 'number' ? value.errcode & 0xff : undefined;
    this.kind =
      cause instanceof SyntaxError || sqliteCode === 1 || sqliteCode === 11 || sqliteCode === 26
        ? 'invalid-data'
        : value?.code === 'ENOENT'
          ? 'missing'
          : 'unavailable';
    if (sqliteCode === 14) {
      try {
        lstatSync(leasePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.kind = 'missing';
      }
    }
  }
}

function leasePath(registryPath: string, ownerToken: string): string {
  return resolve(
    dirname(registryPath),
    SERVER_AUTHORITY_LEASES_DIRNAME,
    `${z.uuid().parse(ownerToken)}.sqlite`,
  );
}

function cleanupLeaseFile(path: string): void {
  try {
    tracedUnlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    getLogger('server-authority').warn(
      { err: error, leasePath: path },
      'Retired ownership lease file cleanup failed',
    );
  }
}

export function acquireServerAuthorityLease(registryPath: string, ownerToken: string): () => void {
  const path = leasePath(registryPath, ownerToken);
  tracedMkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  tracedWriteFileSync(path, '', { flag: 'wx', mode: 0o600 });
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { timeout: 0 });
    database.exec('PRAGMA journal_mode=DELETE');
    database.exec('CREATE TABLE lease (owner_token TEXT PRIMARY KEY) STRICT');
    database.prepare('INSERT INTO lease VALUES (?)').run(ownerToken);
    database.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    try {
      database?.close();
    } catch (cleanupError) {
      getLogger('server-authority').warn(
        { err: cleanupError, leasePath: path },
        'Failed ownership lease close failed',
      );
    }
    cleanupLeaseFile(path);
    throw error;
  }
  heldLeases.add(path);
  let released = false;
  return () => {
    if (released) return;
    database.close();
    heldLeases.delete(path);
    released = true;
    cleanupLeaseFile(path);
  };
}

export function isServerAuthorityLeaseReleased(registryPath: string, ownerToken: string): boolean {
  const path = leasePath(registryPath, ownerToken);
  return probeReleasedLease(path, ownerToken, false);
}

function probeReleasedLease(
  path: string,
  ownerToken: string,
  allowUninitialized: boolean,
): boolean {
  if (heldLeases.has(path)) return false;
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true, timeout: 0 });
    try {
      database.exec('BEGIN EXCLUSIVE');
    } catch (error) {
      const code = (error as { errcode?: number }).errcode;
      if (typeof code === 'number' && ((code & 0xff) === 5 || (code & 0xff) === 6)) return false;
      throw error;
    }
    if (database.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete')
      throw new SyntaxError('Content ownership lease must use SQLite DELETE-mode file locking');
    if (
      allowUninitialized &&
      database.prepare('SELECT count(*) AS count FROM sqlite_schema').get()?.count === 0
    )
      return true;
    const persistedToken = database.prepare('SELECT owner_token FROM lease').get()?.owner_token;
    if (allowUninitialized && persistedToken === undefined) return true;
    if (persistedToken !== ownerToken)
      throw new SyntaxError('Content ownership lease token does not match its registry row');
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      error instanceof SyntaxError ||
      code === 'ERR_SQLITE_ERROR' ||
      ['EACCES', 'EPERM', 'ENOENT', 'EIO', 'EBUSY'].includes(code ?? '')
    )
      throw new ServerAuthorityLeaseVerificationError(path, error);
    throw error;
  } finally {
    database?.close();
  }
}

export function removeReleasedServerAuthorityLease(registryPath: string, ownerToken: string): void {
  cleanupLeaseFile(leasePath(registryPath, ownerToken));
}

export function collectServerAuthorityLeaseOrphansUnderRegistryTransaction(
  registryPath: string,
  registry: DatabaseSync,
  referenced: ReadonlySet<string>,
): void {
  if (!registry.isTransaction)
    throw new Error('Ownership lease collection requires a held registry transaction');
  const directory = resolve(dirname(registryPath), SERVER_AUTHORITY_LEASES_DIRNAME);
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.sqlite')) continue;
      const parsed = z.uuid().safeParse(entry.name.slice(0, -7));
      if (!parsed.success || referenced.has(parsed.data)) continue;
      const path = resolve(directory, entry.name);
      try {
        if (probeReleasedLease(path, parsed.data, true)) cleanupLeaseFile(path);
      } catch (error) {
        getLogger('server-authority').warn(
          { err: error, leasePath: path },
          'Unreferenced ownership lease could not be verified',
        );
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    getLogger('server-authority').warn(
      { err: error, leasePath: directory },
      'Ownership lease directory cleanup unavailable',
    );
  }
}
