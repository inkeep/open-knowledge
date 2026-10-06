import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LOCAL_DIR, OK_DIR, SERVER_AUTHORITY_REGISTRY_FILENAME } from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import {
  normalizeFsPath,
  tracedChmodSync,
  tracedMkdirSync,
  tracedWriteFileSync,
} from './fs-traced.ts';
import { getLogger } from './logger.ts';
import {
  acquireServerAuthorityLease,
  collectServerAuthorityLeaseOrphansUnderRegistryTransaction,
  isServerAuthorityLeaseReleased,
  removeReleasedServerAuthorityLease,
  SERVER_AUTHORITY_LEASE_PROTOCOL,
  ServerAuthorityLeaseVerificationError,
} from './server-authority-lease.ts';
import { withSpanSync } from './telemetry.ts';

export type ContentScope =
  | { readonly kind: 'tree'; readonly path: string; readonly excluded: readonly string[] }
  | { readonly kind: 'file'; readonly path: string };

export interface ServerAuthorityHolder {
  readonly projectDir: string;
  readonly scope: ContentScope;
  readonly pid: number;
  readonly serverInstanceId: string;
}

type ServerAuthorityVerification =
  | { kind: 'held' }
  | { kind: 'protocol-mismatch'; protocol: string }
  | { kind: 'failed'; error: ServerAuthorityLeaseVerificationError };

function ownershipRegistryRecovery(registryPath: string | undefined): string {
  return `Run ok stop all and confirm every OpenKnowledge server under this OS account has exited. Then back up and remove ${registryPath ?? 'the named ownership registry'} together with its -journal file if present, keeping them together as one backup. Never remove either while a server is running.`;
}

function unverifiedOwnershipMessage(
  existing: ServerAuthorityHolder,
  registryPath: string | undefined,
  verification: Exclude<ServerAuthorityVerification, { kind: 'held' }>,
): string {
  const prefix = `Existing content ownership for ${existing.scope.path} in ${existing.projectDir} could not be verified. `;
  if (verification.kind === 'protocol-mismatch')
    return `${prefix}The ownership protocol ${verification.protocol} is not supported by this runtime. Update every OpenKnowledge runtime to a compatible version; no ownership record was cleared.`;
  const error = verification.error;
  const detail = `Lease ${error.leasePath}: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}. `;
  const recovery = ownershipRegistryRecovery(registryPath);
  return (
    prefix +
    detail +
    (error.kind === 'unavailable'
      ? `Lease access may be temporarily unavailable. First check access to the named lease and retry. If the failure persists, use manual recovery: ${recovery}`
      : recovery)
  );
}

export class ServerAuthorityCollisionError extends Error {
  readonly existing: ServerAuthorityHolder;
  readonly verifiedLease: boolean;
  readonly leasePath: string | undefined;

  constructor(
    existing: ServerAuthorityHolder,
    registryPath?: string,
    verification: ServerAuthorityVerification = { kind: 'held' },
  ) {
    super(
      verification.kind === 'held'
        ? `OpenKnowledge content ownership is already held by ${existing.scope.kind === 'file' ? `a single-file preview of ${existing.scope.path}` : `the project server for ${existing.projectDir}`} (pid ${existing.pid}, content ${existing.scope.path}). Close that session before opening an overlapping content scope.`
        : unverifiedOwnershipMessage(existing, registryPath, verification),
      verification.kind === 'failed' ? { cause: verification.error } : undefined,
    );
    this.name = 'ServerAuthorityCollisionError';
    this.existing = existing;
    this.verifiedLease = verification.kind === 'held';
    this.leasePath = verification.kind === 'failed' ? verification.error.leasePath : undefined;
  }
}

export class ServerAuthorityRegistryError extends Error {
  readonly kind:
    | 'unavailable'
    | 'unsupported-version'
    | 'retired-version'
    | 'invalid-data'
    | 'contention'
    | 'unknown';
  readonly registryPath: string | undefined;

  constructor(kind: 'unavailable', registryPath: undefined, cause: unknown);
  constructor(kind: ServerAuthorityRegistryError['kind'], registryPath: string, cause: unknown);
  constructor(
    kind: ServerAuthorityRegistryError['kind'],
    registryPath: string | undefined,
    cause: unknown,
  ) {
    const headers: Record<ServerAuthorityRegistryError['kind'], string> = {
      'unsupported-version': 'This runtime does not support the content ownership registry version',
      'retired-version':
        'This runtime no longer reads the retired pre-release content ownership registry layout',
      contention: 'The content ownership registry is being updated by another runtime',
      unavailable: 'The content ownership registry cannot be accessed',
      'invalid-data': 'The content ownership registry contains invalid data',
      unknown: 'The content ownership registry could not be read or updated',
    };
    const remedies: Record<ServerAuthorityRegistryError['kind'], string> = {
      'unsupported-version': 'Update every OpenKnowledge runtime to a compatible version.',
      'retired-version': ownershipRegistryRecovery(registryPath),
      contention: 'Another runtime is updating the registry; try starting again.',
      unavailable:
        'Check the named location and its permissions; the default registry requires a registered, writable OS-account home.',
      'invalid-data': ownershipRegistryRecovery(registryPath),
      unknown:
        'Check the underlying error before retrying. The registry has not been reset and ownership protection cannot be disabled.',
    };
    super(
      `${headers[kind]}. ${registryPath === undefined ? 'The OS-account home could not be resolved' : `Registry: ${registryPath}`}. ` +
        `${cause instanceof Error ? cause.message : String(cause)}. ${remedies[kind]}`,
      { cause },
    );
    this.name = 'ServerAuthorityRegistryError';
    this.kind = kind;
    this.registryPath = registryPath;
  }
}

export function classifyServerAuthorityRegistryError(
  error: unknown,
): ServerAuthorityRegistryError['kind'] {
  const value =
    typeof error === 'object' && error !== null
      ? (error as { errcode?: unknown; code?: unknown })
      : undefined;
  const code = typeof value?.errcode === 'number' ? value.errcode & 0xff : undefined;
  if (code === 5 || code === 6) return 'contention';
  if (code === 11 || code === 26 || error instanceof z.ZodError || error instanceof SyntaxError)
    return 'invalid-data';
  if (
    typeof value?.code === 'string' &&
    ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EROFS', 'ERR_SYSTEM_ERROR'].includes(value.code)
  )
    return 'unavailable';
  return 'unknown';
}

const pathSchema = z
  .string()
  .min(1)
  .refine((path) => !path.includes('\0') && isAbsolute(path) && normalize(path) === path);
const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), path: pathSchema }),
  z
    .object({ kind: z.literal('tree'), path: pathSchema, excluded: z.array(pathSchema) })
    .refine(({ path, excluded }) =>
      excluded.every(
        (excludedPath) => relative(path, excludedPath) !== '' && containsPath(path, excludedPath),
      ),
    ),
]);
const holderRowSchema = z.object({
  server_instance_id: z.string().min(1),
  owner_token: z.uuid(),
  pid: z.number().int().positive(),
  lease_protocol: z.string().min(1),
  project_dir: pathSchema,
  scope_json: z.string(),
  started_at: z.iso.datetime(),
});
const exitReleases = new Set<() => void>();
let exitHandlerRegistered = false;

function containsPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function contentScopeContainsPath(scope: ContentScope, path: string): boolean {
  return (
    isAbsolute(path) &&
    containsPath(scope.path, path) &&
    (scope.kind === 'file'
      ? relative(scope.path, path) === ''
      : !scope.excluded.some((excluded) => containsPath(excluded, path)))
  );
}

export function contentScopesOverlap(left: ContentScope, right: ContentScope): boolean {
  if (left.kind === 'file') return contentScopeContainsPath(right, left.path);
  if (right.kind === 'file') return contentScopeContainsPath(left, right.path);
  const deeperRoot = containsPath(left.path, right.path) ? right.path : left.path;
  return contentScopeContainsPath(left, deeperRoot) && contentScopeContainsPath(right, deeperRoot);
}

function immutableScope(value: unknown): ContentScope {
  const scope = scopeSchema.parse(value);
  return scope.kind === 'file'
    ? Object.freeze(scope)
    : Object.freeze({ ...scope, excluded: Object.freeze(scope.excluded) });
}

function authoritySpan<T>(operation: 'acquire' | 'release', registryPath: string, fn: () => T): T {
  return withSpanSync(
    'fs.serverAuthority',
    {
      attributes: {
        'fs.operation': 'serverAuthority',
        'fs.path': normalizeFsPath(registryPath),
        'fs.path.role': 'ok-internal',
        'fs.sqlite.operation': operation,
      },
    },
    fn,
  );
}

export function acquireServerAuthority(options: {
  scope: ContentScope;
  projectDir: string;
  serverInstanceId: string;
  registryPath?: string;
}): { scope: ContentScope; release: () => void } {
  const scope = immutableScope(options.scope);
  const projectDir = pathSchema.parse(options.projectDir);
  const serverInstanceId = z.string().min(1).parse(options.serverInstanceId);
  let osHome: string;
  try {
    osHome = userInfo().homedir;
  } catch (error) {
    if (options.registryPath === undefined) {
      throw new ServerAuthorityRegistryError('unavailable', undefined, error);
    }
    osHome = dirname(options.registryPath);
  }
  const registryPath =
    options.registryPath ?? resolve(osHome, OK_DIR, LOCAL_DIR, SERVER_AUTHORITY_REGISTRY_FILENAME);
  pathSchema.parse(registryPath);
  const ownerToken = randomUUID();
  let releaseLease: (() => void) | undefined;
  const db = authoritySpan('acquire', registryPath, () => {
    let database: DatabaseSync | undefined;
    const prunedLeases: Array<{
      token: string;
      projectDir: string;
      scopeKind: ContentScope['kind'];
      startedAt: string;
    }> = [];
    try {
      tracedMkdirSync(dirname(registryPath), { recursive: true, mode: 0o700 });
      try {
        tracedWriteFileSync(registryPath, '', { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      tracedChmodSync(registryPath, 0o600);
      database = new DatabaseSync(registryPath, { timeout: 5_000 });
      database.exec('BEGIN IMMEDIATE');
      const version = database.prepare('PRAGMA user_version').get()?.user_version;
      const emptyLegacy =
        version === 1 &&
        database
          .prepare('PRAGMA table_info(server_authority)')
          .all()
          .map((column) => column.name)
          .join(',') ===
          'server_instance_id,owner_token,pid,hostname,machine_id,project_dir,scope_json,started_at' &&
        database.prepare('SELECT count(*) AS count FROM server_authority').get()?.count === 0;
      if (version !== 0 && version !== 2 && !emptyLegacy) {
        throw new ServerAuthorityRegistryError(
          version === 1 ? 'retired-version' : 'unsupported-version',
          registryPath,
          new Error(`Registry layout version ${version} is not supported by this runtime`),
        );
      }
      if (database.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete')
        throw new ServerAuthorityRegistryError(
          'unsupported-version',
          registryPath,
          new Error('Content ownership requires SQLite DELETE-mode file locking'),
        );
      if (emptyLegacy) database.exec('DROP TABLE server_authority');
      database.exec(`
        CREATE TABLE IF NOT EXISTS server_authority (
          server_instance_id TEXT PRIMARY KEY,
          owner_token TEXT NOT NULL,
          pid INTEGER NOT NULL,
          lease_protocol TEXT NOT NULL,
          project_dir TEXT NOT NULL,
          scope_json TEXT NOT NULL,
          started_at TEXT NOT NULL
        ) STRICT;
        PRAGMA user_version = 2;
      `);
      const holders = database
        .prepare('SELECT * FROM server_authority')
        .all()
        .map((rawRow) => {
          const row = holderRowSchema.parse(rawRow);
          return { row, scope: immutableScope(JSON.parse(row.scope_json)) };
        });
      collectServerAuthorityLeaseOrphansUnderRegistryTransaction(
        registryPath,
        database,
        new Set(holders.map(({ row }) => row.owner_token)),
      );
      for (const { row, scope: existingScope } of holders) {
        const overlaps =
          row.server_instance_id === serverInstanceId || contentScopesOverlap(scope, existingScope);
        if (!overlaps) continue;
        let verification: ServerAuthorityVerification =
          row.lease_protocol === SERVER_AUTHORITY_LEASE_PROTOCOL
            ? { kind: 'held' }
            : { kind: 'protocol-mismatch', protocol: row.lease_protocol };
        let leaseReleased = false;
        if (verification.kind === 'held') {
          try {
            leaseReleased = isServerAuthorityLeaseReleased(registryPath, row.owner_token);
          } catch (error) {
            if (!(error instanceof ServerAuthorityLeaseVerificationError)) throw error;
            verification = { kind: 'failed', error };
            getLogger('server-authority').warn(
              { err: error, registryPath },
              'Content ownership lease could not be verified',
            );
          }
        }
        if (leaseReleased) {
          database
            .prepare(
              'DELETE FROM server_authority WHERE server_instance_id = ? AND owner_token = ?',
            )
            .run(row.server_instance_id, row.owner_token);
          prunedLeases.push({
            token: row.owner_token,
            projectDir: row.project_dir,
            scopeKind: existingScope.kind,
            startedAt: row.started_at,
          });
          continue;
        }
        throw new ServerAuthorityCollisionError(
          {
            projectDir: row.project_dir,
            scope: existingScope,
            pid: row.pid,
            serverInstanceId: row.server_instance_id,
          },
          registryPath,
          verification,
        );
      }
      releaseLease = acquireServerAuthorityLease(registryPath, ownerToken);
      database
        .prepare(
          'INSERT INTO server_authority (server_instance_id, owner_token, pid, lease_protocol, project_dir, scope_json, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          serverInstanceId,
          ownerToken,
          process.pid,
          SERVER_AUTHORITY_LEASE_PROTOCOL,
          projectDir,
          JSON.stringify(scope),
          new Date().toISOString(),
        );
      database.exec('COMMIT');
      for (const holder of prunedLeases) {
        getLogger('server-authority').info(
          {
            projectDir: holder.projectDir,
            scopeKind: holder.scopeKind,
            startedAt: holder.startedAt,
            registryPath,
          },
          'Reclaimed released content ownership lease',
        );
        removeReleasedServerAuthorityLease(registryPath, holder.token);
      }
      return database;
    } catch (error) {
      database?.close();
      try {
        releaseLease?.();
      } catch (cleanupError) {
        getLogger('server-authority').warn(
          { err: cleanupError },
          'Content ownership lease cleanup failed',
        );
      }
      if (
        error instanceof ServerAuthorityCollisionError ||
        error instanceof ServerAuthorityRegistryError
      )
        throw error;
      throw new ServerAuthorityRegistryError(
        classifyServerAuthorityRegistryError(error),
        registryPath,
        error,
      );
    }
  });

  let released = false;
  const release = (): void => {
    if (released) return;
    authoritySpan('release', registryPath, () => {
      db.prepare(`
        DELETE FROM server_authority
        WHERE server_instance_id = ? AND owner_token = ?
      `).run(serverInstanceId, ownerToken);
      db.close();
      releaseLease?.();
    });
    released = true;
    exitReleases.delete(release);
  };
  exitReleases.add(release);
  if (!exitHandlerRegistered) {
    exitHandlerRegistered = true;
    process.prependOnceListener('exit', () => {
      for (const releaseAtExit of exitReleases) {
        try {
          releaseAtExit();
        } catch (error) {
          getLogger('server-authority').warn(
            { err: error },
            'Content ownership exit release failed',
          );
        }
      }
    });
  }
  return { scope, release };
}
