import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';

export const mdManager = new MarkdownManager({
  extensions: sharedExtensions,
  deriveStructuralFreshness: true,
});
