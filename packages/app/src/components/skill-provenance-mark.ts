import { t } from '@lingui/core/macro';

const MARK_ATTR = 'data-ok-provenance-mark';
const KEY_ATTR = 'data-ok-provenance-key';

const failedAvatarLogins = new Set<string>();
const PLUGIN_POOL_KEY = 'ok-provenance-plugin';
const PIN_POOL_KEY = 'ok-provenance-pin';
const LIBRARY_POOL_KEY = 'ok-provenance-library';

export const PROVENANCE_POOL_KEY_ATTR = 'data-ok-provenance-pool-key';
export const PROVENANCE_PLUGIN_POOL_KEY = PLUGIN_POOL_KEY;
export const PROVENANCE_PIN_POOL_KEY = PIN_POOL_KEY;
export const PROVENANCE_LIBRARY_POOL_KEY = LIBRARY_POOL_KEY;

export const SKILL_PROVENANCE_MARK_CSS = `
  [${MARK_ATTR}][data-ok-pin-mark] svg { color: var(--trees-fg-muted, var(--muted-foreground)); }
  [${MARK_ATTR}] {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 0.875rem;
    height: 0.875rem;
    flex-shrink: 0;
    margin-inline-end: 0.25rem;
    align-self: center;
  }
  /* A mark WITH a destination is a real target, so it gets a 24px hit box —
     padding grown and margin pulled back by the same amount, so the glyph and
     the label sit exactly where the decorative mark's do. */
  a[${MARK_ATTR}] {
    padding: 0.3125rem;
    margin: -0.3125rem;
    margin-inline-end: -0.0625rem;
    border-radius: 0.25rem;
    box-sizing: content-box;
  }
  a[${MARK_ATTR}]:hover { background-color: var(--trees-bg-hover, rgb(127 127 127 / 0.18)); }
  [${MARK_ATTR}] img {
    width: 100%;
    height: 100%;
    border-radius: 0.1875rem;
    object-fit: cover;
    display: block;
  }
  [${MARK_ATTR}] svg {
    width: 100%;
    height: 100%;
    /* Matches the native package decoration a plugin resident carries on the
       trailing edge, so the same glyph does not read as two different states
       depending on which side of the row it sits. Muted here made the group
       row look like the fainter, subordinate mention of the two. */
    color: var(--trees-fg);
  }
`;

export type RowProvenanceMark =
  | {
      readonly kind: 'publisher';
      readonly login: string;
      readonly title: string;
      readonly href?: string;
    }
  | { readonly kind: 'plugin'; readonly title: string; readonly href?: string }
  | { readonly kind: 'pin'; readonly title: string }
  | { readonly kind: 'library'; readonly title: string; readonly href?: string }
  | null;

export interface ProvenanceMarkOptions {
  readonly markFor: (treePath: string) => RowProvenanceMark;
  readonly iconPool: HTMLElement | null;
  readonly version: string;
}

function markKey(mark: NonNullable<RowProvenanceMark>, version: string): string {
  const href = mark.kind === 'pin' ? '' : (mark.href ?? '');
  if (mark.kind !== 'publisher') return `${mark.kind}|${href}|${version}`;
  const failed = failedAvatarLogins.has(mark.login) ? '|failed' : '';
  return `publisher|${mark.login}${failed}|${href}|${version}`;
}

export function applyProvenanceMarks(root: ParentNode, opts: ProvenanceMarkOptions): void {
  for (const row of root.querySelectorAll<HTMLElement>('[data-type="item"][data-item-path]')) {
    const treePath = row.dataset.itemPath;
    const mark = treePath ? opts.markFor(treePath) : null;
    if (!mark) {
      row.querySelector(`[${MARK_ATTR}]`)?.remove();
      continue;
    }
    upsertMark(row, mark, opts);
  }
}

function upsertMark(
  row: HTMLElement,
  mark: NonNullable<RowProvenanceMark>,
  opts: ProvenanceMarkOptions,
): void {
  const key = markKey(mark, opts.version);
  const existing = row.querySelector<HTMLElement>(`[${MARK_ATTR}]`);
  if (existing?.getAttribute(KEY_ATTR) === key) {
    existing.setAttribute('title', mark.title);
    return;
  }

  const doc = row.ownerDocument;
  const wantsLink = mark.kind !== 'pin' && mark.href !== undefined;
  const reusable = existing && existing.tagName === (wantsLink ? 'A' : 'SPAN') ? existing : null;
  if (existing && !reusable) existing.remove();
  const container = reusable ?? doc.createElement(wantsLink ? 'a' : 'span');
  container.setAttribute(MARK_ATTR, '');
  container.setAttribute(KEY_ATTR, key);
  container.setAttribute('title', mark.title);
  if (mark.kind === 'pin') container.setAttribute('data-ok-pin-mark', '');
  else container.removeAttribute('data-ok-pin-mark');
  if (wantsLink && container instanceof HTMLAnchorElement) {
    container.href = mark.href ?? '';
    container.target = '_blank';
    container.rel = 'noreferrer noopener';
    container.setAttribute('aria-label', t`${mark.title} (opens in a new tab)`);
    container.removeAttribute('aria-hidden');
    container.onclick = (e) => e.stopPropagation();
  } else {
    container.setAttribute('aria-hidden', 'true');
  }
  container.replaceChildren();

  if (mark.kind === 'publisher') {
    if (failedAvatarLogins.has(mark.login)) {
    } else {
      const img = doc.createElement('img');
      img.src = `https://github.com/${encodeURIComponent(mark.login)}.png?size=96`;
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener(
        'error',
        () => {
          failedAvatarLogins.add(mark.login);
          img.remove();
          container.setAttribute(KEY_ATTR, markKey(mark, opts.version));
        },
        { once: true },
      );
      container.appendChild(img);
    }
  } else {
    const poolKey =
      mark.kind === 'pin'
        ? PIN_POOL_KEY
        : mark.kind === 'library'
          ? LIBRARY_POOL_KEY
          : PLUGIN_POOL_KEY;
    const svg = opts.iconPool
      ?.querySelector(`[${PROVENANCE_POOL_KEY_ATTR}="${poolKey}"] svg`)
      ?.cloneNode(true);
    if (!(svg instanceof SVGElement)) {
      if (!reusable) return;
      container.remove();
      return;
    }
    svg.removeAttribute('aria-label');
    svg.setAttribute('aria-hidden', 'true');
    container.appendChild(svg);
  }

  if (!reusable) {
    const iconSection = row.querySelector('[data-item-section="icon"]');
    if (iconSection) iconSection.after(container);
    else row.prepend(container);
  }
}
