import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CommentIndex } from '../comments/comment-index.ts';
import { CommentService } from '../comments/comment-service.ts';
import { CommentThreadStore } from '../comments/thread-store.ts';
import { loggerFactory } from '../logger.ts';
import { createCommentRoutes } from './comment-routes.ts';

/**
 * Table-level pins for the comments group's mutating declaration. The wire
 * cannot pin this: the read half of the DNS-rebinding defense applies the
 * identical loopback + workspace-Host checks to every `/api/*` request, so an
 * emptied mutating set changes no composition-suite response — only which
 * gate (and telemetry tag) fires first. The declared membership is pinned
 * here directly against the legacy `MUTATING_ROUTES` membership it
 * reproduces.
 */

function buildGroup() {
  const log = loggerFactory.getLogger('test');
  return createCommentRoutes({
    // Store directory is created lazily on first write, so a nonexistent
    // tmp path never touches disk at construction.
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
