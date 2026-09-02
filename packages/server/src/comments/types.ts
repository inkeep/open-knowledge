import type { CommentThreadMeta } from '@inkeep/open-knowledge-core';

export {
  type Anchor,
  type CommentTarget,
  type CommentThreadMeta,
  CommentThreadMetaSchema,
  type PropertyPath,
} from '@inkeep/open-knowledge-core';

export type CommentThreadPatch = Partial<
  Pick<CommentThreadMeta, 'docName' | 'anchor' | 'state' | 'queued' | 'latestComment' | 'updatedAt'>
>;
