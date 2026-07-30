/**
 * HTTP route module for comments — the app's door to the comment store
 * (agents reach comments through the dispatch payload, not this API; there is
 * no comments MCP surface in v1). Thin adapters over {@link CommentService}:
 * parse + validate the request, thread identity for attribution, call the
 * service, emit an RFC 9457 / schema-validated response.
 *
 * Wired into `api-extension.ts` as two `methodRouter` dispatchers:
 *   GET  /api/comments[?doc=<docName>]   list threads — one doc, or project-wide
 *   POST /api/comments                   create a thread { docName, start, end, body, queue? }
 *   GET    /api/comment?id=<threadId>    read one thread
 *   POST   /api/comment                  mutate { action, ... }
 *   DELETE /api/comment?id=<threadId>    delete a thread outright (destructive)
 *
 * Mutations multiplex on `action` so the route surface stays two paths:
 * `edit` | `resolve` | `reopen` | `replace` | `queue` | `unqueue`, plus the
 * dispatch pair `dispatch-prepare` / `dispatch-complete` and their batch forms
 * `dispatch-prepare-batch` / `dispatch-complete-batch` (an ordered `ids` array
 * — the reviewer's selection). Identity is threaded per mutation via
 * `extractActorIdentity` (the mutating sub-handlers below), the same boundary
 * rename/rollback use.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Principal } from '@inkeep/open-knowledge-core';
// The wire schemas live in core, shared with the app so neither side restates
// the other's shape. Only `CommentThreadMetaSchema` doubles as the on-disk
// shape; the envelopes below are wire-only.
import {
  CompleteBatchSuccessSchema,
  DeleteSuccessSchema,
  PrepareBatchSuccessSchema,
  PrepareDispatchSuccessSchema,
  QueueSuccessSchema,
  ThreadListSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import { extractActorIdentity } from '../extract-actor-identity.ts';
import { errorResponse } from '../http/error-response.ts';
import { readBoundedJsonBody } from '../http/request-validation.ts';
import { successResponse } from '../http/success-response.ts';
import {
  type CommentService,
  DocNotFoundError,
  PassageNotFoundError,
  PropertyNotFoundError,
  ThreadNotFoundError,
} from './comment-service.ts';
import { CommentThreadMetaSchema } from './types.ts';

export interface CommentApiDeps {
  service: CommentService;
  getPrincipal: (() => Principal | null) | undefined;
  /**
   * Fired after any successful mutation so connected clients refetch (the CC1
   * `comments` derived-view channel). Optional — omit in tests.
   */
  onChanged?: () => void;
}

export interface CommentApi {
  list: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  read: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  create: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  mutate: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  remove: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

const HANDLER = 'comments';
/** Tight body budget — comment payloads are small; matches loopback-only handlers. */
const BODY_LIMITS = { maxBytes: 64 * 1024, timeoutMs: 10_000 } as const;
/** Cap on one dispatch batch. Well above any realistic review pass; bounds the work per request. */
const BATCH_MAX = 200;

/**
 * Where the passage is: body offsets, or the quoted text for callers whose
 * coordinate system isn't body offsets (the rich-text editor has ProseMirror
 * positions, which markdown syntax + frontmatter make non-equivalent).
 */
const PassageRefSchema = {
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().optional(),
  quote: z.string().min(1).optional(),
  /**
   * Rendered text either side of the caller's selection — how a repeated quote
   * says which occurrence it meant. Bounded: it only has to out-score the other
   * candidates, not reproduce the document.
   */
  prefix: z.string().max(1000).optional(),
  suffix: z.string().max(1000).optional(),
} as const;

const CreateRequestSchema = z.object({
  docName: z.string().min(1),
  ...PassageRefSchema,
  /**
   * Comment on a frontmatter key instead of a body passage. The passage fields
   * above then apply to that VALUE rather than the body: send a `quote` to
   * comment on a passage inside it, or omit one to comment on the whole thing.
   */
  propertyKey: z.string().min(1).optional(),
  /** Steps into the key's value — `[2]` for the third tag, `["name"]` for a field. */
  propertyPath: z.array(z.union([z.string(), z.number().int().nonnegative()])).optional(),
  body: z.string(),
  /** Post straight into the dispatch queue (queue-first compose flow). */
  queue: z.boolean().optional(),
  summary: z.string().optional(),
});

/**
 * A thread id is a server-minted UUID, and the store joins it into a path. An
 * id is therefore never caller data in the ordinary sense: `../threads/<id>`
 * escapes the comments directory, and the ACP thread store one level over names
 * its files with the very same `.meta.json` / `.ndjson` pair — so an unvalidated
 * id on the delete route reaches real agent transcripts. Constraining the shape
 * here is what keeps every id a leaf name; nothing downstream re-checks.
 */
const ThreadIdSchema = z.uuid();

const MutateRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('edit'),
    id: ThreadIdSchema,
    body: z.string(),
    summary: z.string().optional(),
  }),
  z.object({ action: z.literal('resolve'), id: ThreadIdSchema, summary: z.string().optional() }),
  z.object({ action: z.literal('reopen'), id: ThreadIdSchema, summary: z.string().optional() }),
  z.object({
    action: z.literal('replace'),
    id: ThreadIdSchema,
    ...PassageRefSchema,
    summary: z.string().optional(),
  }),
  z.object({ action: z.literal('queue'), id: ThreadIdSchema, summary: z.string().optional() }),
  z.object({ action: z.literal('unqueue'), id: ThreadIdSchema, summary: z.string().optional() }),
  z.object({
    action: z.literal('dispatch-prepare'),
    id: ThreadIdSchema,
    summary: z.string().optional(),
  }),
  z.object({
    action: z.literal('dispatch-complete'),
    id: ThreadIdSchema,
    summary: z.string().optional(),
  }),
  // Batch forms. `ids` is the selected set in intended run order; the
  // client drives select/deselect and sends only what stays checked.
  z.object({
    action: z.literal('dispatch-prepare-batch'),
    ids: z.array(ThreadIdSchema).min(1).max(BATCH_MAX),
    summary: z.string().optional(),
  }),
  z.object({
    action: z.literal('dispatch-complete-batch'),
    ids: z.array(ThreadIdSchema).min(1).max(BATCH_MAX),
    summary: z.string().optional(),
  }),
]);

export function createCommentApi(deps: CommentApiDeps): CommentApi {
  const { service, getPrincipal, onChanged } = deps;

  async function list(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // `doc` absent = the project-wide view (the queue panel spans docs you do
    // not have open).
    const docName = new URL(req.url ?? '', 'http://localhost').searchParams.get('doc') ?? undefined;
    try {
      const threads = await service.listThreads(docName);
      successResponse(res, 200, ThreadListSuccessSchema, { threads }, { handler: HANDLER });
    } catch (e) {
      internalError(res, e, 'Failed to list comment threads.');
    }
  }

  /**
   * The `?id=` of a single-thread route, or null once a 400 has been sent.
   * Shared by `read` and `remove` so the two can't drift — `remove` is the
   * destructive one, and a validated id there is what keeps the store's
   * `join` on a leaf name (see {@link ThreadIdSchema}).
   */
  function threadIdParam(req: IncomingMessage, res: ServerResponse): string | null {
    const id = new URL(req.url ?? '', 'http://localhost').searchParams.get('id');
    if (!id) {
      badRequest(res, 'id query parameter is required.');
      return null;
    }
    if (!ThreadIdSchema.safeParse(id).success) {
      badRequest(res, 'id must be a comment thread UUID.');
      return null;
    }
    return id;
  }

  async function read(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const id = threadIdParam(req, res);
    if (id === null) return;
    try {
      const thread = await service.readThread(id);
      successResponse(res, 200, CommentThreadMetaSchema, thread, { handler: HANDLER });
    } catch (e) {
      if (e instanceof ThreadNotFoundError) return notFound(res, 'Comment thread not found.');
      internalError(res, e, 'Failed to read comment thread.');
    }
  }

  async function create(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = await parseBody(req, res, CreateRequestSchema);
    if (!parsed) return;
    const actor = extractActorIdentity(parsed as unknown as Record<string, unknown>, getPrincipal);
    if (actor.kind === 'invalid-summary') return badRequest(res, 'Summary must be a string.');
    const author = authorFromActor(actor);
    if (!author) return badRequest(res, 'A principal or agent identity is required to comment.');
    try {
      const meta = await service.createThread({
        docName: parsed.docName,
        start: parsed.start,
        end: parsed.end,
        quote: parsed.quote,
        prefix: parsed.prefix,
        suffix: parsed.suffix,
        propertyKey: parsed.propertyKey,
        propertyPath: parsed.propertyPath,
        author,
        body: parsed.body,
        queue: parsed.queue,
      });
      onChanged?.();
      successResponse(res, 201, CommentThreadMetaSchema, meta, { handler: HANDLER });
    } catch (e) {
      if (e instanceof DocNotFoundError) return notFound(res, 'Document not found.');
      if (e instanceof PassageNotFoundError) {
        return badRequest(res, 'The quoted passage is not in the document.');
      }
      if (e instanceof PropertyNotFoundError) {
        return badRequest(res, `That property is not in the document: ${e.message}`);
      }
      if (
        e instanceof RangeError ||
        (e instanceof Error && /invalid selection|is required/.test(e.message))
      ) {
        return badRequest(res, 'Selection range is invalid for the document.');
      }
      internalError(res, e, 'Failed to create comment thread.');
    }
  }

  async function mutate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = await parseBody(req, res, MutateRequestSchema);
    if (!parsed) return;
    const actor = extractActorIdentity(parsed as unknown as Record<string, unknown>, getPrincipal);
    if (actor.kind === 'invalid-summary') return badRequest(res, 'Summary must be a string.');
    try {
      switch (parsed.action) {
        case 'edit': {
          // Identity gate, not attribution: the service records no author for an
          // edit (the event log that did was dropped). Kept because a mutation
          // arriving from nobody is worth refusing on its own.
          if (!authorFromActor(actor)) {
            return badRequest(res, 'An identity is required to edit a comment.');
          }
          const meta = await service.editComment(parsed.id, parsed.body);
          return ok(res, meta);
        }
        case 'resolve':
          return ok(res, await service.resolve(parsed.id));
        case 'reopen':
          return ok(res, await service.reopen(parsed.id));
        case 'replace':
          return ok(
            res,
            await service.replaceAnchor(parsed.id, {
              start: parsed.start,
              end: parsed.end,
              quote: parsed.quote,
              prefix: parsed.prefix,
              suffix: parsed.suffix,
            }),
          );
        case 'queue': {
          const result = await service.queueForDispatch(parsed.id);
          onChanged?.();
          return successResponse(res, 200, QueueSuccessSchema, result, { handler: HANDLER });
        }
        case 'unqueue':
          return ok(res, await service.unqueue(parsed.id));
        case 'dispatch-prepare': {
          const result = await service.prepareDispatch(parsed.id);
          onChanged?.();
          return successResponse(res, 200, PrepareDispatchSuccessSchema, result, {
            handler: HANDLER,
          });
        }
        case 'dispatch-complete':
          return ok(res, await service.completeDispatch(parsed.id));
        case 'dispatch-prepare-batch': {
          const results = await service.prepareDispatchBatch(parsed.ids);
          onChanged?.();
          return successResponse(
            res,
            200,
            PrepareBatchSuccessSchema,
            { results },
            {
              handler: HANDLER,
            },
          );
        }
        case 'dispatch-complete-batch': {
          const results = await service.completeDispatchBatch(parsed.ids);
          onChanged?.();
          return successResponse(
            res,
            200,
            CompleteBatchSuccessSchema,
            { results },
            {
              handler: HANDLER,
            },
          );
        }
      }
    } catch (e) {
      if (e instanceof ThreadNotFoundError) return notFound(res, 'Comment thread not found.');
      if (e instanceof DocNotFoundError) return notFound(res, 'Document not found.');
      if (e instanceof PassageNotFoundError) {
        return badRequest(res, 'The quoted passage is not in the document.');
      }
      if (e instanceof PropertyNotFoundError) {
        return badRequest(res, `That property is not in the document: ${e.message}`);
      }
      if (e instanceof Error && /invalid selection|is required/.test(e.message)) {
        return badRequest(res, 'Selection range is invalid for the document.');
      }
      internalError(res, e, 'Failed to update comment thread.');
    }
  }

  /** Emit a mutation result + signal connected clients to refetch. */
  /**
   * DELETE a thread outright — the one destructive operation on this surface.
   *
   * Distinct from `unqueue` (drop from the batch, keep the comment) and from
   * `resolve` (close it, keep the history). Deliberately a separate HTTP verb
   * rather than another `action`, so it can never be reached by a body typo on
   * a mutate call. Both files are removed; the conversation does not survive.
   */
  async function remove(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const id = threadIdParam(req, res);
    if (id === null) return;
    try {
      await service.delete(id);
      onChanged?.();
      successResponse(res, 200, DeleteSuccessSchema, { threadId: id }, { handler: HANDLER });
    } catch (e) {
      internalError(res, e, 'Failed to delete comment thread.');
    }
  }

  function ok(res: ServerResponse, meta: unknown): void {
    onChanged?.();
    successResponse(res, 200, CommentThreadMetaSchema, meta, { handler: HANDLER });
  }

  return { list, read, create, mutate, remove };
}

/** Read + Zod-validate a JSON body; emits a 400 and returns null on failure. */
async function parseBody<T extends z.ZodType>(
  req: IncomingMessage,
  res: ServerResponse,
  schema: T,
): Promise<z.infer<T> | null> {
  let raw: Buffer;
  try {
    raw = await readBoundedJsonBody(req, BODY_LIMITS);
  } catch {
    badRequest(res, 'Request body could not be read.');
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    badRequest(res, 'Request body must be valid JSON.');
    return null;
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    badRequest(res, 'Request body is invalid.');
    return null;
  }
  return result.data;
}

function authorFromActor(actor: ReturnType<typeof extractActorIdentity>): string | null {
  if (actor.kind === 'agent' || actor.kind === 'principal') return actor.writerId;
  return null;
}

function badRequest(res: ServerResponse, message: string): void {
  errorResponse(res, 400, 'urn:ok:error:invalid-request', message, { handler: HANDLER });
}
function notFound(res: ServerResponse, message: string): void {
  errorResponse(res, 404, 'urn:ok:error:not-found', message, { handler: HANDLER });
}
function internalError(res: ServerResponse, cause: unknown, message: string): void {
  errorResponse(res, 500, 'urn:ok:error:internal-server-error', message, {
    handler: HANDLER,
    cause,
  });
}
