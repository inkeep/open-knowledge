/**
 * Decides whether a failed read-only viewer should offer to hand the file to
 * another application, and builds the dispatch context when it should.
 *
 * Two things this exists to keep straight, both of which the naive "link to the
 * URL we just fetched" shape got wrong:
 *
 *   - The handoff target is the FILE, addressed by its project-relative path,
 *     not the `/api/asset-text` URL whose failure produced the pane. That URL
 *     answers the same way a second time.
 *   - A 404 is the one status that CONFIRMS there is nothing to hand over, so
 *     it is the one that suppresses the affordance: the caller gets `undefined`
 *     and renders no control. No other failure refutes the file's existence -
 *     too large and binary both prove it exists, and a transport failure says
 *     nothing either way - so those keep the affordance rather than hide a
 *     working handoff behind an unprovable guess.
 */

import { ASSET_EXTENSIONS, toDesktopAssetHref } from '@inkeep/open-knowledge-core';

/** Everything `dispatchAssetClick` needs, resolved at the error-pane boundary. */
export interface ViewerOpenFileTarget {
  /** Project-relative path — what the desktop bridge resolves and contains. */
  readonly projectRelPath: string;
  /** Lowercased, dot-stripped extension. */
  readonly ext: string;
  /** Basename, for menus and logs. */
  readonly title: string;
  /** Web fallback target: the byte-serving asset endpoint, opened in a new tab. */
  readonly url: string;
}

interface ResolveViewerOpenFileArgs {
  /** Absent for loader-backed sources (skill bundles) that have no content-dir path. */
  readonly assetPath: string | undefined;
  readonly fileName: string;
  readonly extension: string;
  readonly httpStatus: number | undefined;
}

export function resolveViewerOpenFile({
  assetPath,
  fileName,
  extension,
  httpStatus,
}: ResolveViewerOpenFileArgs): ViewerOpenFileTarget | undefined {
  if (!assetPath) return undefined;
  if (httpStatus === 404) return undefined;
  const ext = extension.toLowerCase();
  // Only the web fallback reads the URL: the dispatcher's Electron branch hands
  // `projectRelPath` to the bridge and returns without touching it. The origin
  // wrap is therefore inert here - it no-ops precisely when `window.okDesktop`
  // is absent, which is the only case that gets this far - and is kept so the
  // field stays a complete, self-contained target if a future dispatch path
  // does open it.
  //
  // `/api/asset` serves bytes uncapped, which is what the common too-large
  // failure needs, but its serve allowlist admits only `ASSET_EXTENSIONS`. The
  // few types the viewer reaches through the ungated byte path instead
  // (`.mmd`, `.canvas`, ...) are absent from it and would answer 404 there, so
  // they get the endpoint that does serve them. That one is size-capped, so
  // this only recovers failures that were not about size - but an endpoint
  // that provably cannot serve the file is never the better target.
  const endpoint = ASSET_EXTENSIONS.has(ext) ? '/api/asset' : '/api/asset-text';
  return {
    projectRelPath: assetPath,
    ext,
    title: fileName,
    url: toDesktopAssetHref(`${endpoint}?path=${encodeURIComponent(assetPath)}`),
  };
}
