import type { ServerResponse } from 'node:http';
import type { Conflict, ConflictKind, ReconcileReason, ResolveStrategy } from './conflict-kinds.ts';
import { strategiesFor } from './conflict-kinds.ts';
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

export class DocInConflictError extends Error {
  readonly file: string;
  override readonly name = 'DocInConflictError' as const;

  constructor(opts: { file: string }) {
    super(`Document is in conflict: ${opts.file}`);
    this.file = opts.file;
  }
}

export interface DocInConflictEnvelope {
  detail: string;
  conflict?: { kind: ConflictKind; reason?: ReconcileReason };
  resolutionOptions: readonly ResolveStrategy[];
}

export function docInConflictEnvelope(conflict?: Conflict): DocInConflictEnvelope {
  const reason: ReconcileReason | undefined =
    conflict?.kind === 'reconcile' ? conflict.reason : undefined;
  return {
    detail:
      'The document is in a conflict state. Call conflicts({ kind: "content" }) + resolve_conflict before retrying.',
    ...(conflict === undefined
      ? {}
      : { conflict: { kind: conflict.kind, ...(reason === undefined ? {} : { reason }) } }),
    resolutionOptions:
      conflict === undefined ? RESOLUTION_OPTIONS : strategiesFor(conflict.kind, reason),
  };
}

export function respondDocInConflict(
  res: ServerResponse,
  err: DocInConflictError,
  handler: string,
  conflict?: Conflict,
): void {
  console.warn(
    JSON.stringify({
      event: 'doc-in-conflict-write-refused',
      handler,
      'doc.name': stripDocExtension(err.file),
    }),
  );
  const { detail, ...envelope } = docInConflictEnvelope(conflict);
  errorResponse(res, 409, 'urn:ok:error:doc-in-conflict', 'Document is in conflict.', {
    handler,
    detail,
    extensions: { file: conflict?.file ?? err.file, ...envelope },
  });
}

export type ConflictMarkerRefusal = 'strategy-not-offered' | 'markers-in-content';

export class ConflictMarkersInContentError extends Error {
  readonly file: string;
  readonly refusal: ConflictMarkerRefusal;
  override readonly name = 'ConflictMarkersInContentError' as const;

  constructor(opts: { file: string; refusal?: ConflictMarkerRefusal }) {
    super(`Resolution for ${opts.file} still contains conflict markers`);
    this.file = opts.file;
    this.refusal = opts.refusal ?? 'markers-in-content';
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
