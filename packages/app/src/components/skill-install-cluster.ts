/**
 * Imperative shadow-DOM injection that draws each skill row's install state as a
 * cluster of agent brand icons (installed / detected) or an "Install" pill
 * (uninstalled), replacing the old install-state TEXT badge. Runs from a
 * `MutationObserver` on Pierre's shadow root — the same pattern as
 * `applyExtensionBadges` (see `file-tree-extension-badge.ts`).
 *
 * Why imperative + cloned nodes, not React: Pierre renders rows inside a
 * STYLE-ISOLATED shadow root — Tailwind/shadcn classes don't cross the boundary,
 * so a React `<TargetIcon>` rendered here would lose its brand color. Instead the
 * caller keeps a hidden light-DOM pool of `<TargetIcon>`s (real brand colors +
 * theme, computed by React) and we CLONE the rendered `<svg>` into each row. The
 * cloned node keeps its inline `--ok-brand-color`; {@link SKILL_INSTALL_CLUSTER_CSS}
 * (injected via Pierre's unsafe-CSS channel) re-applies that var as `color` inside
 * the shadow root. Monochrome brands (OpenCode/Pi) have no var and inherit the
 * row's text color, which is the intended treatment.
 *
 * Mutation-loop avoidance: each row's cluster carries a content KEY; we rebuild
 * only when the key changes, so our own writes don't re-trigger the host observer
 * into an infinite loop. Pierre re-renders overwrite our injections; the observer
 * re-applies them on the next tick.
 */

import { AGENT_CLUSTER_MAX } from '@/components/AgentIconCluster';

const CLUSTER_ATTR = 'data-ok-install-cluster';
const KEY_ATTR = 'data-ok-cluster-key';
const PILL_ATTR = 'data-ok-install-pill';
const PILL_PATH_ATTR = 'data-ok-install-path';
const POOL_KEY_ATTR = 'data-ok-host-pool-key';
/** The marks' description, mirrored onto `aria-label`. Deliberately NOT a native
 *  `title`: the row already owns the tooltip that explains where a skill lives,
 *  and a second bubble on the marks read as a rendering glitch. */
const HINT_ATTR = 'data-ok-cluster-hint';

/**
 * Styles for the injected cluster + pill, passed through Pierre's `unsafeCSS`
 * (Tailwind can't reach the shadow root). `--ok-brand-color` is set inline on
 * each cloned brand `<svg>` by `TargetIcon`; re-applying it as `color` here is
 * what restores the brand color after the clone crosses the shadow boundary.
 */
export const SKILL_INSTALL_CLUSTER_CSS = `
  [${CLUSTER_ATTR}] {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    margin-left: 0.375rem;
    margin-right: 0.25rem;
    align-self: center;
    flex-shrink: 0;
  }
  [${CLUSTER_ATTR}] svg {
    width: 0.875rem;
    height: 0.875rem;
    /* Colored brands carry an inline --ok-brand-color; monochrome brands
       (OpenCode/Pi/generic) have none and must fall back to a NEUTRAL foreground,
       not inherit the row's (sometimes blue) currentColor. */
    color: var(--ok-brand-color, var(--muted-foreground));
  }
  [${CLUSTER_ATTR}] [data-ok-install-overflow] {
    font-size: 0.6875rem;
    color: color-mix(in oklab, var(--muted-foreground) 80%, transparent);
  }
  [${PILL_ATTR}] {
    display: inline-flex;
    align-items: center;
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    padding: 0.05rem 0.4rem;
    border-radius: 0.375rem;
    border: 1px solid color-mix(in oklab, var(--muted-foreground) 35%, transparent);
    color: color-mix(in oklab, var(--muted-foreground) 90%, transparent);
    background: transparent;
    cursor: pointer;
    line-height: 1.3;
  }
  [${PILL_ATTR}]:hover {
    color: var(--foreground);
    border-color: color-mix(in oklab, var(--foreground) 55%, transparent);
  }
`;

/** Row install state, resolved per tree path by the caller. `null` → no cluster
 *  (built-in rows keep their native lock icon; non-skill rows get nothing). */
export type RowInstallDecor =
  | { readonly kind: 'icons'; readonly poolKeys: readonly string[]; readonly title: string }
  | { readonly kind: 'install'; readonly title: string }
  | null;

export interface InstallClusterOptions {
  /** Resolve a row's tree path to its install decoration. */
  readonly decorFor: (treePath: string) => RowInstallDecor;
  /** Hidden light-DOM pool of `<TargetIcon>`s to clone brand `<svg>`s from,
   *  each under `[data-ok-host-pool-key="<id>"]`. */
  readonly iconPool: HTMLElement | null;
  /** Localized "Install" label for the uninstalled pill. */
  readonly installLabel: string;
  /** Bumped whenever the pool re-renders (theme change) so stale clones rebuild. */
  readonly version: string;
}

/** The Install pill a click landed on: its skill tree path + screen rect (to
 *  anchor the install menu), or null when the click wasn't on a pill. */
export function installPillFromEvent(
  target: EventTarget | null,
): { path: string; rect: DOMRect } | null {
  if (!(target instanceof Element)) return null;
  const pill = target.closest(`[${PILL_ATTR}]`);
  const path = pill?.getAttribute(PILL_PATH_ATTR);
  if (!pill || !path) return null;
  return { path, rect: pill.getBoundingClientRect() };
}

/**
 * Inject/refresh install clusters across every row under `root`. Idempotent —
 * a row whose content key is unchanged is skipped. Safe to call from a
 * `MutationObserver` and on first paint.
 */
export function applyInstallClusters(root: ParentNode, opts: InstallClusterOptions): void {
  for (const row of root.querySelectorAll<HTMLElement>('[data-type="item"][data-item-path]')) {
    const treePath = row.dataset.itemPath;
    if (!treePath) {
      removeCluster(row);
      continue;
    }
    const decor = opts.decorFor(treePath);
    if (!decor) {
      removeCluster(row);
      continue;
    }
    upsertCluster(row, treePath, decor, opts);
  }
}

function removeCluster(row: HTMLElement): void {
  row.querySelector(`[${CLUSTER_ATTR}]`)?.remove();
}

function clusterKey(decor: NonNullable<RowInstallDecor>, version: string): string {
  return decor.kind === 'install'
    ? `install|${version}`
    : `icons|${decor.poolKeys.join(',')}|${version}`;
}

function upsertCluster(
  row: HTMLElement,
  treePath: string,
  decor: NonNullable<RowInstallDecor>,
  opts: InstallClusterOptions,
): void {
  const key = clusterKey(decor, opts.version);
  const existing = row.querySelector<HTMLElement>(`[${CLUSTER_ATTR}]`);
  if (existing?.getAttribute(KEY_ATTR) === key) {
    // Cheap refresh: the pill's path can change if a row is reused for a
    // different skill while the key (kind+version) matches — keep it in sync.
    if (decor.kind === 'install') existing.setAttribute(PILL_PATH_ATTR, treePath);
    existing.setAttribute(HINT_ATTR, decor.title);
    existing.setAttribute('aria-label', decor.title);
    return;
  }

  const doc = row.ownerDocument;
  const container = existing ?? doc.createElement('span');
  container.setAttribute(CLUSTER_ATTR, '');
  container.setAttribute(KEY_ATTR, key);
  container.setAttribute(HINT_ATTR, decor.title);
  // `aria-label` on a bare span (role=generic) is ignored by assistive tech, so
  // the row's only install-state disclosure was silently invisible. `role="img"`
  // makes the label the element's accessible name; the children are aria-hidden.
  container.setAttribute('role', 'img');
  container.setAttribute('aria-label', decor.title);
  container.replaceChildren();

  if (decor.kind === 'install') {
    const pill = doc.createElement('button');
    pill.type = 'button';
    pill.setAttribute(PILL_ATTR, '');
    pill.setAttribute(PILL_PATH_ATTR, treePath);
    pill.setAttribute('aria-label', decor.title);
    pill.textContent = opts.installLabel;
    container.appendChild(pill);
  } else {
    const shown = decor.poolKeys.slice(0, AGENT_CLUSTER_MAX);
    for (const poolKey of shown) {
      const svg = opts.iconPool
        ?.querySelector(`[${POOL_KEY_ATTR}="${poolKey}"] svg`)
        ?.cloneNode(true);
      if (svg instanceof SVGElement) {
        // Strip the brand icon's own `<title>`/aria-label ("Cursor icon"), else it
        // shows as a per-icon tooltip that shadows the cluster's real "Installed
        // in …" title on hover. The whole cluster carries that title instead.
        svg.querySelector('title')?.remove();
        svg.removeAttribute('aria-label');
        svg.setAttribute('aria-hidden', 'true');
        container.appendChild(svg);
      }
    }
    const overflow = decor.poolKeys.length - shown.length;
    if (overflow > 0) {
      const more = doc.createElement('span');
      more.setAttribute('data-ok-install-overflow', '');
      more.textContent = `+${overflow}`;
      container.appendChild(more);
    }
  }

  if (!existing) {
    const actionSection = row.querySelector('[data-item-section="action"]');
    if (actionSection) actionSection.before(container);
    else row.appendChild(container);
  }
}

/** Pool key for the `[data-ok-host-pool-key]` slot to use for the pool render. */
export const HOST_POOL_KEY_ATTR: string = POOL_KEY_ATTR;
