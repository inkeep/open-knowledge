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
