import type { ContentFilter } from './content-filter.ts';

type ExclusionReadOpts = NonNullable<Parameters<ContentFilter['isExcluded']>[1]>;
type PathReadOpts = NonNullable<Parameters<ContentFilter['isPathIgnored']>[1]>;

const _combinedSyncAndBypass: ExclusionReadOpts = {
  bypassFilters: true,
  // @ts-expect-error — sync admission and Show All Files are mutually exclusive.
  syncScope: { pathBase: 'project' },
};
// @ts-expect-error — asset serving never accepts the sync-only capability.
const _syncScopedAssetServe: PathReadOpts = { syncScope: { pathBase: 'project' } };
void _combinedSyncAndBypass;
void _syncScopedAssetServe;
