import {
  buildRelativeMarkdownHref,
  type ClassifiedLinkTarget,
  classifyMarkdownHref,
  type DocLinkTarget,
} from '@inkeep/open-knowledge-core';
import { hashFromAssetPath, hashFromDocName } from '../lib/doc-hash';
import { dispatchAssetClick } from './asset-dispatch';
import { isSafeNavigationUrl } from './safe-navigation-url';

export function getCurrentDocNameFromHash(locationHash = window.location.hash): string {
  const hashMatch = locationHash.match(/^#\/([^?#]+)/);
  return hashMatch ? decodeURIComponent(hashMatch[1]) : '';
}

export function classifyCurrentMarkdownHref(
  href: string,
  locationHash = window.location.hash,
): ClassifiedLinkTarget | null {
  return classifyMarkdownHref(href, getCurrentDocNameFromHash(locationHash));
}

export function toInternalHashHref({
  docName,
  anchor,
}: Pick<DocLinkTarget, 'docName' | 'anchor'>): string {
  return hashFromDocName(docName, anchor);
}

export function openHashHrefInNewTab(href: string): void {
  // Gate on scheme allowlist. Authored URLs can contain
  // `javascript:`, `data:`, `vbscript:` etc. that reach `window.open`
  // unfiltered and execute arbitrary JS in the viewer's origin. Relative
  // hash-hrefs like `#/docName` return false from isSafeNavigationUrl —
  // they're safe to pass to window.open because same-origin navigation
  // cannot carry JS, but isSafeNavigationUrl doesn't know that. We treat
  // any URL the parser rejects OR that starts with '#' as same-origin and
  // let it through.
  if (href.startsWith('#') || isSafeNavigationUrl(href)) {
    window.open(href, '_blank', 'noopener,noreferrer');
  } else {
    // Refuse silently — authored navigation to a non-safe scheme is
    // treated the same as an empty URL. No telemetry here because this
    // is a user-authored-content path; the PropPanel's Edit UI surfaces
    // the URL so the author can see and fix it.
    // eslint-disable-next-line no-console
    console.warn('[safe-nav] blocked non-safe scheme:', href);
  }
}

function navigateToInternalHashHref(resolved: Pick<DocLinkTarget, 'docName' | 'anchor'>): void {
  window.location.assign(toInternalHashHref(resolved));
}

export function openInternalHashHrefInNewTab(
  resolved: Pick<DocLinkTarget, 'docName' | 'anchor'>,
): void {
  openHashHrefInNewTab(toInternalHashHref(resolved));
}

/**
 * Navigate to the in-app asset preview for a content-root-relative asset
 * path — the same surface the sidebar opens on asset selection. Setting the
 * `#/__asset__/…` hash lets App.tsx's central hashchange handler own the
 * target transition (`{ kind: 'asset' }` → `EditorArea` renders
 * `AssetPreview`) + tab state, exactly like `navigateToInternalHashHref`
 * does for docs. `assetPath` is leading-slash-free (matches
 * `resolveAssetProjectPath` output + the sidebar's `entry.path`).
 *
 * Module-private — `activateAssetLink` is the only caller (the link/wiki-embed
 * extensions route through that seam, never here directly).
 */
function navigateToAssetPreview(assetPath: string): void {
  window.location.assign(hashFromAssetPath(assetPath));
}

interface ActivateAssetLinkParams {
  /** Raw href the dispatcher's web fallback opens (the form the user authored). */
  url: string;
  /** Content-root-relative canonical path (from `resolveAssetProjectPath`). */
  projectRelPath: string;
  /** Lowercased extension without dot. */
  ext: string;
  /** Basename for user-facing display in the OS-delegation path. */
  title: string;
  /** Cmd/Ctrl/middle-click — the OS-delegation escape hatch. */
  newTab: boolean;
}

interface ActivateAssetLinkDeps {
  navigate?: (assetPath: string) => void;
  dispatch?: typeof dispatchAssetClick;
}

/**
 * Single routing seam for activating an asset link chip — shared by the
 * link-mark path (`internal-link.ts`) and the drop-time wiki-embed node path
 * (`wiki-link-embed.ts`) so the two never drift.
 *
 *   - Bare click → navigate to the in-app asset preview (sidebar parity).
 *     HTML / archives / Office docs / etc. land on the preview screen with
 *     "Open file" + "View as text" affordances instead of
 *     being handed straight to the OS.
 *   - Cmd/Ctrl/middle-click → `dispatchAssetClick` with `forceOsDelegation`
 *     so the file opens in the OS default app (Electron) or a new tab (web).
 *     Preserves the browser-muscle-memory "open in a new context" gesture.
 *
 * Scope: this seam is the markdown-link asset family only. The `[[wikilink]]`
 * asset chips (`wiki-link.ts` / `wiki-link-source.ts`) also navigate to the
 * same preview on bare click, but keep their own modifier-click rule (open
 * the preview hash in a new tab, not OS delegation) and are intentionally not
 * routed through here.
 *
 * Deps are injectable for tests; production callers pass none.
 */
export function activateAssetLink(
  { url, projectRelPath, ext, title, newTab }: ActivateAssetLinkParams,
  deps: ActivateAssetLinkDeps = {},
): void {
  const navigate = deps.navigate ?? navigateToAssetPreview;
  const dispatch = deps.dispatch ?? dispatchAssetClick;
  if (newTab) {
    void dispatch({ url, projectRelPath, ext, title, forceOsDelegation: true });
    return;
  }
  navigate(projectRelPath);
}

export function shouldOpenInNewTab(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return event.metaKey || event.ctrlKey;
}

/**
 * Shared click handler for the link prop-panels' clickable destination text
 * (InternalLinkPropPanel + WikiLinkPropPanel). Routes the click through the
 * chip's `handlePrimary` (passed as `onNavigate`) so the panel and the chip
 * navigate identically — the `href` on the `<a>` exists only for native
 * middle-click / right-click affordances.
 */
export function handleChipLinkClick(
  event: { metaKey: boolean; ctrlKey: boolean; preventDefault: () => void },
  onNavigate: (newTab: boolean) => boolean,
  onClose: () => void,
): void {
  const newTab = shouldOpenInNewTab(event);
  // onNavigate runs handlePrimary, which navigates synchronously
  // (window.location.assign / window.open). If it handled the click, suppress
  // the native <a> navigation so we don't double-navigate.
  if (!onNavigate(newTab)) return;
  event.preventDefault();
  // Same-tab nav can leave the editor mounted, so close the now-stale panel.
  // New-tab nav keeps the current view — leave the panel open, matching the
  // chip-click path (which also only deactivates on same-tab navigation).
  if (!newTab) onClose();
}

function navigateToAnchorHref(anchor: string, locationHash = window.location.hash): void {
  const currentDocName = getCurrentDocNameFromHash(locationHash);
  if (!currentDocName) return;

  const element = document.getElementById(anchor);
  if (element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  window.location.assign(hashFromDocName(currentDocName, anchor));
}

export function navigateToMarkdownTarget(
  target: ClassifiedLinkTarget,
  locationHash = window.location.hash,
): void {
  if (target.kind === 'doc') {
    navigateToInternalHashHref(target);
    return;
  }

  if (target.kind === 'anchor') {
    navigateToAnchorHref(target.anchor, locationHash);
    return;
  }

  openHashHrefInNewTab(target.url);
}

export function buildCurrentRelativeMarkdownHref(
  targetDocName: string,
  anchor: string | null,
  locationHash = window.location.hash,
): string {
  const sourceDocName = getCurrentDocNameFromHash(locationHash);
  return buildRelativeMarkdownHref(sourceDocName, targetDocName, anchor);
}
