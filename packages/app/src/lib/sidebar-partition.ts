import type { EmbeddedHost } from '@inkeep/open-knowledge-core';

export type Partition = 'above' | 'below' | 'embedded';
export type SidebarState = 'open' | 'collapsed';
export type SidebarSide = 'left' | 'right';

export const LEFT_COLLAPSE_THRESHOLD = 1024;
// Staggered with the left's 1024 (Tailwind `lg`) so the right panel collapses
// FIRST as the viewport narrows — editor breathing room arrives before the
// left disappears. ≥1280: both expanded; 1024–1279: right collapsed, left
// expanded; <1024: both collapsed.
export const RIGHT_COLLAPSE_THRESHOLD = 1280;

const THRESHOLDS = {
  left: LEFT_COLLAPSE_THRESHOLD,
  right: RIGHT_COLLAPSE_THRESHOLD,
} as const satisfies Record<SidebarSide, number>;

export function resolvePartition(
  embeddedHost: EmbeddedHost,
  viewportWidth: number,
  sidebar: SidebarSide,
): Partition {
  if (embeddedHost != null) return 'embedded';
  return viewportWidth >= THRESHOLDS[sidebar] ? 'above' : 'below';
}

export function smartDefault(partition: Partition): SidebarState {
  return partition === 'above' ? 'open' : 'collapsed';
}
