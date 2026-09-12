import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isSkillSourceStateCode, type SkillSourceStateCode } from '@inkeep/open-knowledge-core';
import { atomicWriteFile } from '@inkeep/open-knowledge-core/server';
import { getLocalDir } from './config/paths.ts';
import { tracedAtomicFs, tracedMkdir } from './fs-traced.ts';
import { createKeyedSerializer } from './keyed-serializer.ts';
import { getLogger } from './logger.ts';

const RETAINED_FILENAME = 'skill-move-retained.json';
const SCHEMA_VERSION = 1;

export type SkillMoveScope = 'project' | 'global';

export interface SkillMoveRetentionRecord {
  retainedAt: string;
  from: string;
  to: string;
  sourceState: SkillSourceStateCode;
  reason: string;
  retainedContentHash: string;
}

interface SkillMoveRetainedStore {
  schema: number;
  retained: Record<string, SkillMoveRetentionRecord>;
}

export type SkillMoveRetentionRead =
  | { state: 'none' }
  | { state: 'unreadable'; reason: string; cause?: unknown }
  | { state: 'record'; record: SkillMoveRetentionRecord };

function retainedKey(scope: SkillMoveScope, name: string): string {
  return `${scope}:${name}`;
}

function retainedPath(base: string): string {
  return join(getLocalDir(base), RETAINED_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

type StoreRead =
  | { ok: true; store: SkillMoveRetainedStore }
  | { ok: false; reason: string; cause?: unknown };

const emptyStore = (): StoreRead => ({
  ok: true,
  store: { schema: SCHEMA_VERSION, retained: {} },
});

function readStore(base: string): StoreRead {
  const path = retainedPath(base);
  if (!existsSync(path)) return emptyStore();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return emptyStore();
    return {
      ok: false,
      reason: code ? `it could not be read (${code})` : 'it could not be read',
      cause: err,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'it is not valid JSON' };
  }
  if (!isRecord(parsed) || !isRecord(parsed.retained)) {
    return { ok: false, reason: 'its contents are not a retained-record ledger' };
  }
  if (parsed.schema !== SCHEMA_VERSION) {
    return {
      ok: false,
      reason:
        typeof parsed.schema === 'number'
          ? `it declares schema ${parsed.schema}, which this server does not understand (it writes schema ${SCHEMA_VERSION})`
          : `it declares a schema this server does not understand (it writes schema ${SCHEMA_VERSION})`,
    };
  }
  const retained: Record<string, SkillMoveRetentionRecord> = {};
  for (const [key, value] of Object.entries(parsed.retained)) {
    const fields = isRecord(value) ? value : {};
    retained[key] = {
      retainedAt: str(fields.retainedAt),
      from: str(fields.from),
      to: str(fields.to),
      sourceState: isSkillSourceStateCode(fields.sourceState) ? fields.sourceState : 'unknown',
      reason: str(fields.reason),
      retainedContentHash: str(fields.retainedContentHash),
    };
  }
  return { ok: true, store: { schema: SCHEMA_VERSION, retained } };
}

export function readSkillMoveRetention(
  base: string,
  scope: SkillMoveScope,
  name: string,
): SkillMoveRetentionRead {
  const read = readStore(base);
  if (!read.ok) {
    return {
      state: 'unreadable',
      reason: read.reason,
      ...(read.cause !== undefined ? { cause: read.cause } : {}),
    };
  }
  const record = read.store.retained[retainedKey(scope, name)];
  return record === undefined ? { state: 'none' } : { state: 'record', record };
}

const serializeRetainedWrite = createKeyedSerializer();

function mutateRetained(
  base: string,
  mutate: (retained: Record<string, SkillMoveRetentionRecord>) => boolean,
): Promise<void> {
  const path = retainedPath(base);
  return serializeRetainedWrite(path, async () => {
    const read = readStore(base);
    if (!read.ok) {
      getLogger('skill-move-retained').error(
        { event: 'skill-move-retained.unreadable', path, reason: read.reason },
        'refusing to rewrite the retained-destination ledger because it could not be read — rewriting it would replace every record it holds with this one',
      );
      throw new Error(`Refusing to rewrite ${path}: ${read.reason}`);
    }
    if (!mutate(read.store.retained)) return;
    await tracedMkdir(dirname(path), { recursive: true });
    await atomicWriteFile(path, `${JSON.stringify(read.store, null, 2)}\n`, { fs: tracedAtomicFs });
  });
}

export function recordSkillMoveRetention(
  base: string,
  scope: SkillMoveScope,
  name: string,
  record: SkillMoveRetentionRecord,
): Promise<void> {
  return mutateRetained(base, (retained) => {
    retained[retainedKey(scope, name)] = record;
    return true;
  });
}

export function clearSkillMoveRetention(
  base: string,
  scope: SkillMoveScope,
  name: string,
): Promise<void> {
  return mutateRetained(base, (retained) => {
    const key = retainedKey(scope, name);
    if (!(key in retained)) return false;
    delete retained[key];
    return true;
  });
}
