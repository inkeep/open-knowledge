/**
 * Shared label resolver for `BlockChainEntry` consumers, per precedent #31: descriptor
 * `displayName`, then `name`, then the entry's `componentName` for the wildcard case, with
 * `unregisteredSuffix` appending ` (unregistered)` for assistive-technology surfaces.
 */

import type { BlockChainEntry } from '../extensions/selection-state-plugin.ts';
import { getDescriptor } from '../registry/index.ts';

interface EntryLabelOptions {
  unregisteredSuffix?: boolean;
}

export function getEntryLabel(entry: BlockChainEntry, opts: EntryLabelOptions = {}): string {
  const descriptor = getDescriptor(entry.componentName);
  if (descriptor.name === '*') {
    return opts.unregisteredSuffix ? `${entry.componentName} (unregistered)` : entry.componentName;
  }
  return descriptor.displayName ?? descriptor.name;
}
