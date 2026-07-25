/**
 * One-shot "open in Fields view" intent for schema files navigated to from the
 * Settings frontmatter plugin panel. The schema editor's view toggle persists a
 * user-global preference (`useLintConfigViewMode`, default `source`), but a
 * schema opened from Settings is an editing gesture — it should land on the
 * WYSIWYG Fields view regardless of that preference, without flipping the
 * persisted choice for every other config file.
 *
 * Module-level and in-memory on purpose: the intent spans one hash navigation
 * within one window, so persistence would only let stale intents leak across
 * sessions.
 */

const pendingFieldsView = new Set<string>();

/** Record that the next open of `assetPath` should start on the Fields view. */
export function requestSchemaFieldsView(assetPath: string): void {
  pendingFieldsView.add(assetPath);
}

/** Consume the intent for `assetPath`; true when one was pending. */
export function consumeSchemaFieldsView(assetPath: string): boolean {
  return pendingFieldsView.delete(assetPath);
}
