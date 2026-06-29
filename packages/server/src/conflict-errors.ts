
import type { ServerResponse } from 'node:http';
import type { Document } from '@hocuspocus/server';
import type { ResolveStrategy } from './conflict-storage.ts';
import { stripDocExtension } from './doc-extensions.ts';
import { errorResponse } from './http/error-response.ts';

const RESOLUTION_OPTIONS = [
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
  return document.getMap('lifecycle').get('status') === 'conflict';
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
