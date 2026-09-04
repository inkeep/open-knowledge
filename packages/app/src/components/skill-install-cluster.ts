import { AGENT_CLUSTER_MAX } from '@/components/AgentIconCluster';

const CLUSTER_ATTR = 'data-ok-install-cluster';
const KEY_ATTR = 'data-ok-cluster-key';
const PILL_ATTR = 'data-ok-install-pill';
const PILL_PATH_ATTR = 'data-ok-install-path';
const POOL_KEY_ATTR = 'data-ok-host-pool-key';
const HINT_ATTR = 'data-ok-cluster-hint';

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

export type RowInstallDecor =
  | { readonly kind: 'icons'; readonly poolKeys: readonly string[]; readonly title: string }
  | { readonly kind: 'install'; readonly title: string }
  | null;

export interface InstallClusterOptions {
  readonly decorFor: (treePath: string) => RowInstallDecor;
  readonly iconPool: HTMLElement | null;
  readonly installLabel: string;
  readonly version: string;
}

export function installPillFromEvent(
  target: EventTarget | null,
): { path: string; rect: DOMRect } | null {
  if (!(target instanceof Element)) return null;
  const pill = target.closest(`[${PILL_ATTR}]`);
  const path = pill?.getAttribute(PILL_PATH_ATTR);
  if (!pill || !path) return null;
  return { path, rect: pill.getBoundingClientRect() };
}

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
    if (decor.kind === 'install') existing.setAttribute(PILL_PATH_ATTR, treePath);
    existing.setAttribute(HINT_ATTR, decor.title);
    existing.setAttribute('title', decor.title);
    existing.setAttribute('aria-label', decor.title);
    return;
  }

  const doc = row.ownerDocument;
  const container = existing ?? doc.createElement('span');
  container.setAttribute(CLUSTER_ATTR, '');
  container.setAttribute(KEY_ATTR, key);
  container.setAttribute(HINT_ATTR, decor.title);
  container.setAttribute('title', decor.title);
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

export const HOST_POOL_KEY_ATTR: string = POOL_KEY_ATTR;
