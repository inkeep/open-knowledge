import { hashFromDocName } from '@/lib/doc-hash';

/**
 * Open a managed-artifact doc (skill/template) as the ACTIVE editor tab.
 *
 * Navigates by setting the URL hash — OK's nav source of truth. `onHashChange`
 * (NavigationHandler) then resolves the managed-artifact hash to a `{kind:'doc'}`
 * target via `openTargetTransition`, which fully activates the tab. Going through
 * the hash (rather than calling `openTarget` directly) is load-bearing: it keeps
 * the hash consistent with the active doc, so the nav effect can't later re-read
 * a stale hash and navigate away (`openTarget` activates but leaves the hash
 * pointing at the previous doc). It also closes the Settings dialog when open,
 * since Settings is itself hash-driven (`#settings`).
 */
export function openManagedArtifactTab(docName: string): void {
  if (typeof window === 'undefined') return;
  const hash = hashFromDocName(docName);
  if (window.location.hash !== hash) window.location.hash = hash;
}
