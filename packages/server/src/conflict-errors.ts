import type { ServerResponse } from 'node:http';
import type { Document } from '@hocuspocus/server';
import type * as Y from 'yjs';
import type { ResolveStrategy } from './conflict-storage.ts';
import { stripDocExtension } from './doc-extensions.ts';
import { errorResponse } from './http/error-response.ts';

export const RESOLUTION_OPTIONS = [
  'mine',
  'theirs',
  'content',
  'delete',
] as const satisfies readonly ResolveStrategy[];

type _ExhaustiveResolveStrategy =
  Exclude<ResolveStrategy, (typeof RESOLUTION_OPTIONS)[number]> extends never
    ? true
    : [
        'RESOLUTION_OPTIONS missing ResolveStrategy member:',
        Exclude<ResolveStrategy, (typeof RESOLUTION_OPTIONS)[number]>,
      ];
const _exhaustiveResolveStrategy: _ExhaustiveResolveStrategy = true;

export function isDocInConflict(document: Document): boolean {
  return frozenDocLifecycleStatus(document) === 'conflict';
}

export const FROZEN_LIFECYCLE_STATUSES = ['deleted-upstream', 'renamed', 'conflict'] as const;
export type FrozenLifecycleStatus = (typeof FROZEN_LIFECYCLE_STATUSES)[number];

function isFrozenLifecycleStatus(value: unknown): value is FrozenLifecycleStatus {
  return (FROZEN_LIFECYCLE_STATUSES as readonly unknown[]).includes(value);
}

export function frozenDocLifecycleStatus(document: Y.Doc): FrozenLifecycleStatus | null {
  const status = document.getMap('lifecycle').get('status');
  return isFrozenLifecycleStatus(status) ? status : null;
}

export class DocInConflictError extends Error {
  readonly file: string;
  override readonly name = 'DocInConflictError' as const;

  constructor(opts: { file: string }) {
    super(`Document is in conflict: ${opts.file}`);
    this.file = opts.file;
  }
}

export function respondDocInConflict(
  res: ServerResponse,
  err: DocInConflictError,
  handler: string,
): void {
  console.warn(
    JSON.stringify({
      event: 'doc-in-conflict-write-refused',
      handler,
      'doc.name': stripDocExtension(err.file),
    }),
  );
  errorResponse(res, 409, 'urn:ok:error:doc-in-conflict', 'Document is in conflict.', {
    handler,
    detail:
      'The document is in a merge-conflict state. Call conflicts({ kind: "content" }) + resolve_conflict before retrying.',
    extensions: {
      file: err.file,
      resolutionOptions: RESOLUTION_OPTIONS,
    },
  });
}

export class ConflictMarkersInContentError extends Error {
  readonly file: string;
  override readonly name = 'ConflictMarkersInContentError' as const;

  constructor(opts: { file: string }) {
    super(`Resolution for ${opts.file} still contains conflict markers`);
    this.file = opts.file;
  }
}

export class NoConflictTrackedError extends Error {
  readonly file: string;
  override readonly name = 'NoConflictTrackedError' as const;

  constructor(opts: { file: string }) {
    super(`[conflicts] no conflict tracked for file: ${opts.file}`);
    this.file = opts.file;
  }
}
