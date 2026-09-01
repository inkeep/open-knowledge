import {
  buildRelativeMarkdownHref,
  type ClassifiedLinkTarget,
  classifyMarkdownHref,
  type DocLinkTarget,
} from '@inkeep/open-knowledge-core';
import { hashFromAssetPath, hashFromDocName } from '../lib/doc-hash';
import { openExternalUrl } from '../lib/external-link';
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
  if (href.startsWith('#') || isSafeNavigationUrl(href)) {
    window.open(href, '_blank', 'noopener,noreferrer');
  } else {
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

function navigateToAssetPreview(assetPath: string): void {
  window.location.assign(hashFromAssetPath(assetPath));
}

interface ActivateAssetLinkParams {
  url: string;
  projectRelPath: string;
  ext: string;
  title: string;
  newTab: boolean;
}

interface ActivateAssetLinkDeps {
  navigate?: (assetPath: string) => void;
  dispatch?: typeof dispatchAssetClick;
}

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

export function handleChipLinkClick(
  event: { metaKey: boolean; ctrlKey: boolean; preventDefault: () => void },
  onNavigate: (newTab: boolean) => boolean,
  onClose: () => void,
): void {
  const newTab = shouldOpenInNewTab(event);
  if (!onNavigate(newTab)) return;
  event.preventDefault();
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

  if (target.kind === 'external') {
    openExternalUrl(target.url);
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
