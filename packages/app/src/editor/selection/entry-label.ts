import { t } from '@lingui/core/macro';
import type { BlockChainEntry } from '../extensions/selection-state-plugin.ts';
import { getDescriptor } from '../registry/index.ts';

interface EntryLabelOptions {
  unregisteredSuffix?: boolean;
}

export function getEntryLabel(entry: BlockChainEntry, opts: EntryLabelOptions = {}): string {
  const descriptor = getDescriptor(entry.componentName);
  if (descriptor.name === '*') {
    const componentName = entry.componentName;
    return opts.unregisteredSuffix ? t`${componentName} (unregistered)` : componentName;
  }
  return descriptor.displayName ?? descriptor.name;
}
