import type { ConflictAuthority } from './conflict-authority.ts';

declare const authority: ConflictAuthority;

// @ts-expect-error a working-tree conflict without theirsSha is not constructible
authority.raise({ kind: 'working-tree', file: 'a.md' });
