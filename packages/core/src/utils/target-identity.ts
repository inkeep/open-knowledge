import { toWikiLinkSlug } from './slug.ts';

export type TargetKind = 'document' | 'folder' | 'file';

interface IdentityRule {
  readonly unicode: 'NFC';
  readonly case: 'sensitive' | 'insensitive';
}

export const TARGET_IDENTITY = {
  document: { unicode: 'NFC', case: 'sensitive' },
  folder: { unicode: 'NFC', case: 'sensitive' },
  file: { unicode: 'NFC', case: 'insensitive' },
} as const satisfies Record<TargetKind, IdentityRule>;

export type IdentityKey<K extends TargetKind> = string & {
  readonly __brand: 'IdentityKey';
  readonly __kind: K;
};

export type DependencySlug = string & { readonly __brand: 'DependencySlug' };

export function leafKey(kind: TargetKind, segment: string): string {
  const rule = TARGET_IDENTITY[kind];
  const normalized = segment.normalize(rule.unicode);
  return rule.case === 'insensitive' ? normalized.toLowerCase() : normalized;
}

export function wikiAssetPathKey(path: string): string {
  return leafKey('file', path);
}

export function compareSpellings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function identityKey<K extends TargetKind>(kind: K, path: string): IdentityKey<K> {
  const segments = path.split('/');
  const last = segments.length - 1;
  return segments
    .map((segment, index) => leafKey(index === last ? kind : 'folder', segment))
    .join('/') as IdentityKey<K>;
}

export function dependencySlug(path: string): DependencySlug {
  const fileKey = identityKey('file', path);
  return (toWikiLinkSlug(fileKey) || fileKey) as DependencySlug;
}
