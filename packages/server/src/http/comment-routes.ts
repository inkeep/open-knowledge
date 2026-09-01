import type { Principal } from '@inkeep/open-knowledge-core';
import { createCommentApi } from '../comments/comment-api.ts';
import type { CommentService } from '../comments/comment-service.ts';
import { type ApiRouteGroup, type ApiRouteRecord, createApiRouteGroup } from './api-pipeline.ts';
import { methodRouter } from './method-router.ts';

export interface CommentRouteDeps {
  commentService: CommentService;
  getPrincipal: (() => Principal | null) | undefined;
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
