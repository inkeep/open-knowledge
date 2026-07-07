/**
 * Shared label resolver for `BlockChainEntry` consumers (SelectionAnnouncer,
 * and any future selection-consuming UI — link editor, image caption,
 * collaborator presence pin, per Precedent #31).
 *
 * Fallback ladder:
 *   1. registered descriptor's `displayName`
 *   2. registered descriptor's `name`
 *   3. entry's `componentName` (wildcard case — descriptor name/displayName
 *      are both `'*'`, useless as trail labels)
 *
 * `unregisteredSuffix: true` appends ` (unregistered)` in the wildcard case —
 * appropriate for assistive-technology announcements where AT users benefit
 * from knowing why a label is unfamiliar. Visual surfaces leave it off to
 * avoid repeated noise.
 */

import type { BlockChainEntry } from '../extensions/selection-state-plugin.ts';
import { getDescriptor } from '../registry/index.ts';

interface EntryLabelOptions {
  /** Append ` (unregistered)` when the descriptor resolves to the wildcard
   *  `'*'`. Default `false` (visual surfaces); `true` for AT announcements. */
  unregisteredSuffix?: boolean;
}

export function getEntryLabel(entry: BlockChainEntry, opts: EntryLabelOptions = {}): string {
  const descriptor = getDescriptor(entry.componentName);
  if (descriptor.name === '*') {
    return opts.unregisteredSuffix ? `${entry.componentName} (unregistered)` : entry.componentName;
  }
  return descriptor.displayName ?? descriptor.name;
}
