/**
 * The comments family — `comments` (list/create) and `comment`
 * (read/mutate/remove) — natively routed as one group. The verb handlers were
 * already lifted into `comments/comment-api.ts`; this factory owns the
 * `createCommentApi` wiring and the route table so the extension's legacy
 * record loses the paths in the same change. The `CommentService` itself stays
 * in the extension (its store construction is coupled to the rename walk) and
 * arrives as a dep.
 *
 * Both paths are legacy `MUTATING_ROUTES` members, URL-keyed: every verb —
 * the GET list/read arms included — rides the mutating gate, exactly the
 * legacy admission. The mutating sub-handlers thread `extractActorIdentity`
 * inside `comment-api.ts`.
 */

import type { Principal } from '@inkeep/open-knowledge-core';
import { createCommentApi } from '../comments/comment-api.ts';
import type { CommentService } from '../comments/comment-service.ts';
import { type ApiRouteGroup, type ApiRouteRecord, createApiRouteGroup } from './api-pipeline.ts';
import { methodRouter } from './method-router.ts';

export interface CommentRouteDeps {
  commentService: CommentService;
  getPrincipal: (() => Principal | null) | undefined;
  /** The extension's CC1 nudge; only the `comments` channel is signalled here. */
  signalChannel: ((channel: 'files' | 'lint-config' | 'comments') => void) | undefined;
}

export function createCommentRoutes(deps: CommentRouteDeps): ApiRouteGroup {
  const { commentService, getPrincipal, signalChannel } = deps;

  const commentApi = createCommentApi({
    service: commentService,
    getPrincipal,
    onChanged: () => signalChannel?.('comments'),
  });
  const handleCommentsRoute = methodRouter(
    { GET: commentApi.list, POST: commentApi.create },
    { handler: 'comments' },
  );
  const handleCommentRoute = methodRouter(
    { GET: commentApi.read, POST: commentApi.mutate, DELETE: commentApi.remove },
    { handler: 'comment' },
  );

  const routes = {
    '/api/comments': handleCommentsRoute,
    '/api/comment': handleCommentRoute,
  } satisfies ApiRouteRecord;

  return createApiRouteGroup(routes, {
    mutating: ['/api/comments', '/api/comment'],
  });
}
