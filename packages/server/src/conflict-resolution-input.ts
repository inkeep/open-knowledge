import { ConflictMarkersInContentError } from './conflict-errors.ts';
import { containsUnresolvedConflictBlock } from './reconciliation.ts';

export function requireConflictResolutionContent(
  file: string,
  content: string | undefined,
): string {
  if (content === undefined) {
    throw new Error(`[conflicts] strategy 'content' requires content parameter`);
  }
  if (containsUnresolvedConflictBlock(content)) {
    throw new ConflictMarkersInContentError({ file });
  }
  return content;
}
