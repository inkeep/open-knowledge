import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { atomicWriteFileSync } from '@inkeep/open-knowledge-core/server';
import { escapeDisplayPath } from '../utils/escape-display-path.ts';
import { isObject } from '../utils/is-object.ts';

export type PiTrustGrantPrevious = { present: false } | { present: true; value: unknown };

interface PiTrustGrantRecord {
  version: 1;
  cwd: string;
  configuredTrustPath: string;
  canonicalTrustPath: string;
  state: 'pending' | 'committed';
  previous: PiTrustGrantPrevious;
}

export interface PiTrustGrantReceipt {
  path: string;
  record: PiTrustGrantRecord;
}

function digest(path: string): string {
  return createHash('sha256').update(path).digest('hex');
}

function receiptsRoot(home: string): string {
  return join(resolve(home), '.ok', 'pi-trust');
}

function receiptsDirectory(home: string, cwd: string): string {
  return join(receiptsRoot(home), digest(resolve(cwd)));
}

function receiptPath(home: string, cwd: string, canonicalTrustPath: string): string {
  return join(receiptsDirectory(home, cwd), `${digest(canonicalTrustPath)}.json`);
}

export class PiTrustReceiptError extends Error {
  constructor(path: string, detail: string, remedy: string, cause?: unknown) {
    super(
      `Pi trust receipt at ${escapeDisplayPath(path)} ${escapeDisplayPath(detail)}; ${escapeDisplayPath(remedy)}`,
      { cause },
    );
    this.name = 'PiTrustReceiptError';
  }
}

function receiptFsError(path: string, operation: string, cause: unknown): PiTrustReceiptError {
  const code = (cause as NodeJS.ErrnoException).code;
  const detail = cause instanceof Error ? cause.message : String(cause);
  let remedy: string;
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      remedy = 'check receipt and parent-directory permissions, then retry';
      break;
    case 'ENOENT':
      remedy = 'the location no longer exists; restore access to its expected location, then retry';
      break;
    default:
      remedy = 'check the path and available storage, then retry';
  }
  return new PiTrustReceiptError(path, `could not ${operation}: ${detail}`, remedy, cause);
}

function directoryExists(path: string): boolean {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw receiptFsError(path, 'be inspected', error);
  }
  if (!stat.isDirectory()) {
    throw new PiTrustReceiptError(
      path,
      'is not a regular directory',
      'restore the intended receipt directory without a symlink, then retry',
    );
  }
  return true;
}

function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function parseRecord(value: unknown, path: string): PiTrustGrantRecord {
  if (
    !isObject(value) ||
    !hasKeys(value, [
      'version',
      'cwd',
      'configuredTrustPath',
      'canonicalTrustPath',
      'state',
      'previous',
    ]) ||
    value.version !== 1 ||
    typeof value.cwd !== 'string' ||
    value.cwd !== resolve(value.cwd) ||
    typeof value.configuredTrustPath !== 'string' ||
    value.configuredTrustPath !== resolve(value.configuredTrustPath) ||
    typeof value.canonicalTrustPath !== 'string' ||
    value.canonicalTrustPath !== resolve(value.canonicalTrustPath) ||
    (value.state !== 'pending' && value.state !== 'committed') ||
    !isObject(value.previous)
  ) {
    throw new PiTrustReceiptError(
      path,
      'has invalid contents',
      'restore a valid ownership record from a backup without guessing its trust decision, then retry',
    );
  }
  let previous: PiTrustGrantPrevious;
  if (value.previous.present === false && hasKeys(value.previous, ['present'])) {
    previous = { present: false };
  } else if (value.previous.present === true && hasKeys(value.previous, ['present', 'value'])) {
    previous = { present: true, value: value.previous.value };
  } else {
    throw new PiTrustReceiptError(
      path,
      'has an invalid previous decision',
      'restore the recorded previous decision from a backup without guessing its value, then retry',
    );
  }
  return {
    version: 1,
    cwd: value.cwd,
    configuredTrustPath: value.configuredTrustPath,
    canonicalTrustPath: value.canonicalTrustPath,
    state: value.state,
    previous,
  };
}

function readReceipt(home: string, cwd: string, path: string): PiTrustGrantReceipt {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw receiptFsError(path, 'be inspected', error);
  }
  if (!stat.isFile()) {
    throw new PiTrustReceiptError(
      path,
      'is not a regular file',
      'restore the intended receipt as a regular file without a symlink, then retry',
    );
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw receiptFsError(path, 'be read', error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PiTrustReceiptError(
      path,
      'is not valid JSON',
      'repair its JSON syntax without changing the recorded decision, then retry',
      error,
    );
  }
  const record = parseRecord(parsed, path);
  if (record.cwd !== resolve(cwd) || path !== receiptPath(home, cwd, record.canonicalTrustPath)) {
    throw new PiTrustReceiptError(
      path,
      'does not match its project or trust-store location',
      'restore the ownership record to its original project and trust-store location, then retry',
    );
  }
  return { path, record };
}

function matchingReceipt(home: string, receipt: PiTrustGrantReceipt): PiTrustGrantReceipt {
  const { record, path } = receipt;
  for (const directory of [receiptsRoot(home), receiptsDirectory(home, record.cwd)]) {
    if (!directoryExists(directory)) {
      throw new PiTrustReceiptError(
        directory,
        'no longer exists',
        'restore access to the expected receipt directory, then retry',
      );
    }
  }
  const current = readReceipt(home, record.cwd, path);
  if (!isDeepStrictEqual(current.record, record)) {
    throw new PiTrustReceiptError(
      path,
      'changed while its trust decision was being updated',
      'retry to read its current ownership record',
    );
  }
  return current;
}

export function preparePiTrustGrant(
  home: string,
  cwd: string,
  configuredTrustPath: string,
  canonicalTrustPath: string,
  previous: PiTrustGrantPrevious,
): PiTrustGrantReceipt {
  const record: PiTrustGrantRecord = {
    version: 1,
    cwd: resolve(cwd),
    configuredTrustPath: resolve(configuredTrustPath),
    canonicalTrustPath: resolve(canonicalTrustPath),
    state: 'pending',
    previous,
  };
  const path = receiptPath(home, record.cwd, record.canonicalTrustPath);
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (!isDeepStrictEqual(parseRecord(JSON.parse(serialized), path), record)) {
    throw new PiTrustReceiptError(
      path,
      'cannot preserve the previous decision as JSON',
      'provide the original decision as a JSON value before retrying',
    );
  }
  directoryExists(receiptsRoot(home));
  directoryExists(dirname(path));
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch (error) {
    throw receiptFsError(dirname(path), 'be created', error);
  }
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    throw receiptFsError(path, 'be inspected', error);
  }
  if (existing) {
    throw new PiTrustReceiptError(
      path,
      'already exists',
      'reconcile the existing ownership record before recording another grant',
    );
  }
  try {
    atomicWriteFileSync(path, serialized, { mode: 0o600 });
  } catch (error) {
    throw receiptFsError(path, 'be written', error);
  }
  return { path, record };
}

export function commitPiTrustGrant(
  home: string,
  receipt: PiTrustGrantReceipt,
): PiTrustGrantReceipt {
  const current = matchingReceipt(home, receipt);
  if (current.record.state !== 'pending') {
    throw new PiTrustReceiptError(
      current.path,
      'is already committed',
      'use the current ownership record without committing it again',
    );
  }
  const record: PiTrustGrantRecord = { ...current.record, state: 'committed' };
  try {
    atomicWriteFileSync(current.path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    throw receiptFsError(current.path, 'be committed', error);
  }
  return { path: current.path, record };
}

export function listPiTrustGrants(home: string, cwd: string): PiTrustGrantReceipt[] {
  if (!directoryExists(receiptsRoot(home))) return [];
  const directory = receiptsDirectory(home, cwd);
  if (!directoryExists(directory)) return [];
  let names: string[];
  try {
    names = readdirSync(directory).sort();
  } catch (error) {
    throw receiptFsError(directory, 'be listed', error);
  }
  return names
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .map((name) => readReceipt(home, cwd, join(directory, name)));
}

export function forgetPiTrustGrant(home: string, receipt: PiTrustGrantReceipt): void {
  const current = matchingReceipt(home, receipt);
  try {
    unlinkSync(current.path);
  } catch (error) {
    throw receiptFsError(current.path, 'be removed after reconciling its grant', error);
  }
  for (const directory of [dirname(current.path), receiptsRoot(home)]) {
    try {
      rmdirSync(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOENT') {
        throw receiptFsError(directory, 'be removed after reconciling its grant', error);
      }
    }
  }
}
