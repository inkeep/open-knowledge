import type { PropDef } from '@inkeep/open-knowledge-core';
import { plural, t } from '@lingui/core/macro';

export function formatContainerAriaLabel(
  componentLabel: string,
  _childName: string | undefined,
  childCount: number,
): string {
  if (childCount <= 0) return t`${componentLabel} (empty)`;
  return t`${componentLabel} with ${plural(childCount, {
    one: '# item',
    other: '# items',
  })}`;
}

export function getAutoFocusedPropName(props: PropDef[]): string | null {
  for (const p of props) {
    if (p.type !== 'string') continue;
    if (p.hidden === true) continue;
    if (p.advanced === true) continue;
    if (p.autoFocus === true) return p.name;
  }
  return null;
}

export function humanizePropName(name: string): string {
  if (!name) return name;
  const spaced = name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
