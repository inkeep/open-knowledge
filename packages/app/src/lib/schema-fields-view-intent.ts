/**
 * One-shot "open in Fields view" intent for schema files navigated to from the
 * Settings frontmatter plugin panel. The schema editor's view toggle persists a
 * user-global preference (`useLintConfigViewMode`, default `source`), but a
 * schema opened from Settings is an editing gesture — it should land on the
 * WYSIWYG Fields view regardless of that preference, without flipping the
 * persisted choice for every other config file.
 *
 * Two delivery paths, because the schema editor may or may not already be
 * mounted when the intent is recorded. Settings is a hash-routed overlay, so
 * the editor area underneath keeps its active target: requesting Fields for the
 * schema that is ALREADY active leaves the editor mounted (it is keyed by asset
 * path) and no mount-time read ever runs. Subscribers cover that case; the
 * pending slot covers the not-yet-mounted case.
 *
 * Single-slot rather than a set: only one navigation gesture is ever in flight,
 * and an intent nothing ever claims (deleted file, abandoned navigation) is
 * superseded by the next request instead of lingering to hijack a later open.
 *
 * Module-level and in-memory on purpose: the intent spans one hash navigation
 * within one window, so persistence would only let stale intents leak across
 * sessions.
 */

type FieldsViewListener = (assetPath: string) => void;

let pendingFieldsView: string | null = null;
const listeners = new Set<FieldsViewListener>();

/** Record that the next open of `assetPath` should start on the Fields view. */
export function requestSchemaFieldsView(assetPath: string): void {
  pendingFieldsView = assetPath;
  for (const listener of listeners) listener(assetPath);
}

/** Consume the intent for `assetPath`; true when one was pending. */
export function consumeSchemaFieldsView(assetPath: string): boolean {
  if (pendingFieldsView !== assetPath) return false;
  pendingFieldsView = null;
  return true;
}

/**
 * Subscribe to intents recorded while a schema editor is already mounted.
 * Returns an unsubscribe. The listener still has to `consume` — subscribing
 * does not claim, so an editor for an unrelated path leaves the intent for the
 * mount that follows the navigation.
 */
export function subscribeSchemaFieldsView(listener: FieldsViewListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
