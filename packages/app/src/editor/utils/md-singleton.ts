/**
 * Per precedent #15, the underlying remark plugins are idempotent under re-entry, so one manager
 * safely serves every call.
 */

import { sharedExtensions } from '@inkeep/open-knowledge-core/extensions/shared';
import { MarkdownManager } from '@inkeep/open-knowledge-core/markdown';

let manager: MarkdownManager | null = null;

export function getSharedMarkdownManager(): MarkdownManager {
  manager ||= new MarkdownManager({ extensions: sharedExtensions });
  return manager;
}
