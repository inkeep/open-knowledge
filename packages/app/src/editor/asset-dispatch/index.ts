/**
 * Public surface of the asset-click dispatcher. Controlled barrel —
 * re-exports only what external consumers import through the module
 * boundary.
 *
 * Today the only external consumer is `dispatchAssetClick` (called from
 * `internal-link.ts handlePrimary` + `InternalLinkPropPanel` asset branch +
 * `asset-context-menu.ts`). Follow-on viewer PRs (PDF.js, image lightbox,
 * video/audio read-time promotion) will register via
 * `assetViewerRegistry.register(viewer)` — those PRs add the registry +
 * `AssetViewer` type to the barrel surface at the point of use. Knip
 * strips re-exports with no current importer to prevent dead public API
 * drift, so the barrel grows organically as external consumers materialize.
 *
 * Internal implementation (intentionally NOT re-exported): the
 * `DispatchAssetClickDeps` test-only dep shape, the `defaultOpenAssetTab`
 * web-fallback helper, the private `byExt` Map inside the registry.
 *
 * Matches the barrel convention used by sibling editor modules
 * (`source-polish/index.ts`, `clipboard/index.ts`). See
 * `clipboard/index.ts` for the pattern statement.
 */

export { dispatchAssetClick } from './dispatcher.ts';
