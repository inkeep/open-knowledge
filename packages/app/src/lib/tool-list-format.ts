/**
 * Shared formatting for the AI-tool lists both setup surfaces name in their
 * checkbox labels (first-launch consent, create-project). Its own module rather
 * than an export off either dialog: `McpConsentDialogBody` is deliberately
 * `React.lazy()`-loaded, so importing a helper from it would drag the whole
 * dialog into the eager bundle.
 */

/**
 * Render tool labels as a locale-correct conjunction ("Claude, Cursor and
 * Codex"). `Intl.ListFormat` rather than a joined string because the separator
 * and the final conjunction differ per locale, and this list is the user's
 * collapsed view of exactly which tools get written to.
 *
 * `locale` is required, matching the sibling `formatInstalls` — every call site
 * passes `i18n.locale`, and one optional / one required signature for the same
 * parameter invites a caller to wonder which is authoritative. It is normalized
 * away when empty: `i18n.locale` is `''` before Lingui activates, and `Intl`
 * rejects an empty string rather than treating it as unspecified.
 */
export function formatToolList(labels: readonly string[], locale: string): string {
  return new Intl.ListFormat(locale || undefined, {
    style: 'long',
    type: 'conjunction',
  }).format(labels);
}
