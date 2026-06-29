export type EntryPoint =
  | 'create-new'
  | 'create-new-nested-redirect'
  | 'pick-existing'
  | 'recents'
  | 'deep-link'
  | 'drag-drop'
  | 'share-receive';

const ENTRY_POINT_VALUES: ReadonlySet<EntryPoint> = new Set([
  'create-new',
  'create-new-nested-redirect',
  'pick-existing',
  'recents',
  'deep-link',
  'drag-drop',
  'share-receive',
]);

export function isEntryPoint(value: unknown): value is EntryPoint {
  return typeof value === 'string' && ENTRY_POINT_VALUES.has(value as EntryPoint);
}
