import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CommentIndex } from '../comments/comment-index.ts';
import { CommentService } from '../comments/comment-service.ts';
import { CommentThreadStore } from '../comments/thread-store.ts';
import { loggerFactory } from '../logger.ts';
import { createCommentRoutes } from './comment-routes.ts';

function buildGroup() {
  const log = loggerFactory.getLogger('test');
  return createCommentRoutes({
    commentService: new CommentService({
      store: new CommentThreadStore(join(tmpdir(), 'ok-comment-routes-test-none'), log),
      index: new CommentIndex(),
      getDocBody: () => null,
      getDocFrontmatter: () => null,
    }),
    getPrincipal: undefined,
    signalChannel: undefined,
  });
}

describe('createCommentRoutes table', () => {
  test('registers exactly the two comment paths', () => {
    expect([...buildGroup().paths].sort()).toEqual(['/api/comment', '/api/comments'].sort());
  });

  test('both paths are mutating — URL-keyed, GET arms included', () => {
    const { table } = buildGroup();
    for (const path of ['/api/comments', '/api/comment']) {
      expect(table.isMutating(path), path).toBe(true);
    }
  });
});
