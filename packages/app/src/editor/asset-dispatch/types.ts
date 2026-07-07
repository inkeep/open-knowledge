/**
 * Asset-click dispatcher types.
 *
 * Consumed by `dispatcher.ts` (renderer routing logic), `registry.ts`
 * (module-level singleton), and the renderer hook-up sites
 * (`internal-link.ts` handlePrimary + `InternalLinkPropPanel` asset branch
 * + the node-interaction-bridge on `wiki-link-embed`).
 *
 * The surface is deliberately minimal: the context object carries everything
 * a viewer or the fallback path needs, and the registry is a thin `Map<ext, viewer>`.
 *
 * Implements the "renderer handler + main-process safety net" two-layer
 * click-interception pattern.
 */

/**
 * Per-click context the dispatcher routes on. Built by the caller —
 * `internal-link.ts` handlePrimary for the mark path, the node-bridge
 * handlePrimary for the drop-time `WikiLinkEmbed` node path.
 *
 * Fields kept readonly to make the struct trivially safe to pass across the
 * dispatch chain (viewer → main-process IPC → logging).
 */
export interface AssetClickContext {
  /**
   * Raw href from the markdown — the form the user authored. Used by the web
   * fallback (`window.open`). For wiki-embed the form is the resolved href
   * the renderer computed from `![[file.ext]]` + basename-index lookup;
   * for hand-authored markdown-link it's the `./path` exactly as written.
   */
  readonly url: string;
  /**
   * Project-root-relative, canonical path. Computed by the caller using
   * `resolveAssetProjectPath(url, sourceDocName)` from `link-targets.ts`.
   * This is what the Electron main-process handler expects — `openAssetSafely`
   * resolves it against `ProjectContext.projectPath + realpath +
   * isPathWithinProject` for containment.
   *
   * Separate from `url` because a URL like `../shared.pdf` can't be passed
   * directly to `shell.openPath`; the dispatcher's Electron branch needs the
   * resolved project path.
   */
  readonly projectRelPath: string;
  /**
   * Lowercased extension without dot — the registry lookup key. Sourced from
   * `AssetLinkTarget.ext` so normalization is already done.
   */
  readonly ext: string;
  /** Basename of the asset for user-facing display (titles, menus, logs). */
  readonly title: string;
  /**
   * Cmd/Ctrl+click OR middle-click — forces OS delegation, skipping the
   * registry. Even if a PDF viewer is registered, the user's explicit
   * "open in new context" gesture wins. Browser-muscle-memory equivalent
   * of `<a target="_blank">` Cmd+click on a link.
   */
  readonly forceOsDelegation: boolean;
}

/**
 * A renderer-side viewer for a class of asset extensions. Registered by
 * future PRs (PDF.js, image lightbox, video/audio inline) via
 * `assetViewerRegistry.register(viewer)`.
 *
 * Empty registry is the shipped state — the dispatcher falls through to
 * OS delegation (Electron) or `window.open` (web) for every click until a
 * viewer registers.
 */
export interface AssetViewer {
  /**
   * Lowercased extensions this viewer handles. A viewer can handle multiple
   * (e.g. an image lightbox registering `['png', 'jpg', 'jpeg', 'gif',
   * 'webp']`). The registry maps each ext → this viewer; the dispatcher does
   * a single `lookup(ctx.ext)` call.
   */
  readonly exts: readonly string[];
  /**
   * Renderer-side entry point. The viewer is responsible for mounting its UI
   * (React portal, modal, full-window overlay) and tearing it down on close.
   * Fire-and-forget from the dispatcher's POV — no return value, no promise.
   */
  render(ctx: AssetClickContext): void;
}

/**
 * Result of `AssetViewerRegistry.lookup(ext)`. Discriminated union so callers
 * cannot accidentally pass a possibly-undefined viewer into `.render()` —
 * `ok: true` narrows `viewer` to present.
 *
 * The `ok` field name is the repo-wide convention for boolean-discriminated
 * result envelopes (HTTP / IPC / lookup), matching `Map.set`-style "this
 * succeeded" semantics rather than `Map.has`-style "this contains."
 */
export type AssetViewerLookupResult =
  | { readonly ok: true; readonly viewer: AssetViewer }
  | { readonly ok: false };
