/**
 * Imperative shadow-DOM injection of each skill row's PROVENANCE mark — the
 * publisher avatar or plugin glyph that leads a row and says where it came from.
 *
 * Why imperative, when Pierre has a decoration slot: it gives each row exactly
 * ONE, and it is already spent. Built-ins hold it with their read-only lock and
 * plugin residents with their package glyph. That is the same wall
 * `applyInstallClusters` hit, so this follows it deliberately — same
 * `MutationObserver` host, same content-key skip, same clone-from-a-light-DOM-pool
 * trick for anything React needs to render (Tailwind does not cross the shadow
 * boundary, so a component rendered in here would lose its styling).
 *
 * Leading, never trailing. The row's two facts are different axes and must not
 * blur: origin leads, destination (install hosts, lock) trails where
 * `skill-install-cluster` already puts it. No mark means two things.
 *
 * Two shapes, decided by whether the source resolves to a URL. A mark with
 * nowhere to go is decorative (`aria-hidden`) — it identifies a source visually
 * and the row's own label already names it. A mark WITH a destination is a real
 * anchor: it carries its own accessible name, opens out of the app, and is
 * padded out to a 24px hit box so it clears the WCAG 2.5.8 target minimum that
 * the 14px glyph alone would fail.
 */

import { t } from '@lingui/core/macro';

const MARK_ATTR = 'data-ok-provenance-mark';
const KEY_ATTR = 'data-ok-provenance-key';

/**
 * Logins whose avatar failed to load — a deleted org, a non-GitHub source, or an
 * offline machine. Module-level and deliberately not cleared: within a session the
 * answer does not change, and re-requesting on every observer tick would hammer
 * the network for a 404 we already have.
 *
 * This exists because the failure has to be part of the CONTENT KEY. Removing the
 * mark on error would delete the node the key lives on, so the next pass would
 * rebuild it with the same failing `src`, and that rebuild is itself a `childList`
 * mutation the shadow-root observer reacts to — an unbounded loop.
 */
const failedAvatarLogins = new Set<string>();
const PLUGIN_POOL_KEY = 'ok-provenance-plugin';
const PIN_POOL_KEY = 'ok-provenance-pin';
const LIBRARY_POOL_KEY = 'ok-provenance-library';

/** Pool slot attribute for the light-DOM `<PackageIcon>` this clones. */
export const PROVENANCE_POOL_KEY_ATTR = 'data-ok-provenance-pool-key';
export const PROVENANCE_PLUGIN_POOL_KEY = PLUGIN_POOL_KEY;
export const PROVENANCE_PIN_POOL_KEY = PIN_POOL_KEY;
export const PROVENANCE_LIBRARY_POOL_KEY = LIBRARY_POOL_KEY;

/**
 * Styles for the injected mark, passed through Pierre's `unsafeCSS` — Tailwind
 * cannot reach the shadow root. Sized to sit with the row's own icon rather than
 * compete with it, and given a fixed box so a slow avatar does not reflow the
 * label when it lands.
 */
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

/** A row's provenance mark, resolved per tree path by the caller. `null` → none:
 *  a skill you authored, a member row whose group already names the source, or a
 *  source whose publisher cannot be resolved — the row's link is the disclosure
 *  there, so a mark would add nothing true. */
export type RowProvenanceMark =
  | {
      readonly kind: 'publisher';
      readonly login: string;
      readonly title: string;
      /** Destination for the mark, or absent when the source has none. */
      readonly href?: string;
    }
  | { readonly kind: 'plugin'; readonly title: string; readonly href?: string }
  /** The pinned-row glyph — same channel as provenance because it leads the
   *  row, and a pinned row's "why is this first" IS its provenance. */
  | { readonly kind: 'pin'; readonly title: string }
  /** A distribution source (repo/marketplace parent) with no resolvable
   *  publisher avatar — marked with a neutral library glyph. */
  | { readonly kind: 'library'; readonly title: string; readonly href?: string }
  | null;

export interface ProvenanceMarkOptions {
  readonly markFor: (treePath: string) => RowProvenanceMark;
  /** Hidden light-DOM pool holding the `<PackageIcon>` to clone. */
  readonly iconPool: HTMLElement | null;
  /** Bumped when the pool re-renders (theme change) so stale clones rebuild. */
  readonly version: string;
}

function markKey(mark: NonNullable<RowProvenanceMark>, version: string): string {
  // The href is part of the key: it decides whether the node is an `<a>` or a
  // `<span>`, and a key that ignored it would keep the wrong element forever.
  const href = mark.kind === 'pin' ? '' : (mark.href ?? '');
  if (mark.kind !== 'publisher') return `${mark.kind}|${href}|${version}`;
  const failed = failedAvatarLogins.has(mark.login) ? '|failed' : '';
  return `publisher|${mark.login}${failed}|${href}|${version}`;
}

/**
 * Inject/refresh provenance marks across every row under `root`. Idempotent — a
 * row whose content key is unchanged is skipped, which is what keeps our own
 * writes from re-triggering the host observer into a loop.
 */
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
  // An element can't change tag in place, so a mark that gained or lost its
  // destination is rebuilt rather than mutated.
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
    // Opens outside the app; `noreferrer` implies `noopener` but both are stated
    // because a reader auditing this shouldn't have to know that.
    container.target = '_blank';
    container.rel = 'noreferrer noopener';
    // Interactive now, so it needs a real name — `title` alone is not one for
    // every AT, and the row's label says the source but not that this leaves.
    // The parenthetical is WCAG 2.4.4: a link that opens a new context has to
    // say so in its name, or a screen-reader user loses their place with no
    // warning. Same wording the sync badge already uses for its GitHub link.
    container.setAttribute('aria-label', t`${mark.title} (opens in a new tab)`);
    container.removeAttribute('aria-hidden');
    // The row is a tree item; a click on the mark must not also select it.
    container.onclick = (e) => e.stopPropagation();
  } else {
    // The label is the group row's own text, so a decorative mark adds nothing
    // an assistive reader needs — announcing "inkeep avatar" before
    // "open-knowledge-skills" is noise. Sighted users get it from `title`.
    container.setAttribute('aria-hidden', 'true');
  }
  container.replaceChildren();

  if (mark.kind === 'publisher') {
    // A login we already know 404s renders as an empty, reserved box rather than
    // a re-request. The key above carries the `failed` marker, so this state is
    // stable across passes instead of being rebuilt each tick.
    if (failedAvatarLogins.has(mark.login)) {
      // Nothing to append. An empty mark keeps the row's alignment identical to
      // its resolvable siblings — a source with no avatar must not shift its label.
    } else {
      const img = doc.createElement('img');
      // Same URL shape `PublisherAvatar` uses in Explore: no API call, no token.
      img.src = `https://github.com/${encodeURIComponent(mark.login)}.png?size=96`;
      img.alt = '';
      img.loading = 'lazy';
      // A deleted org, a non-GitHub source, or an offline machine must leave NO
      // mark rather than a broken-image glyph — and specifically not a fallback
      // package icon, which is the plugin mark and would read as the wrong thing.
      // Record the login so the next pass skips the request AND matches the key,
      // rather than removing the node the key lives on.
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
      // The pool has not mounted yet (first paint) or lost its slot. Bail without
      // leaving an empty box behind: an inserted-but-childless mark would take the
      // content key with it, so the row would keep its blank reservation for good
      // once the pool arrives. Leaving no mark lets the next pass build a real one.
      if (!reusable) return;
      container.remove();
      return;
    }
    svg.removeAttribute('aria-label');
    svg.setAttribute('aria-hidden', 'true');
    container.appendChild(svg);
  }

  if (!reusable) {
    // Leading edge: after the row's own file/folder icon, before its label.
    const iconSection = row.querySelector('[data-item-section="icon"]');
    if (iconSection) iconSection.after(container);
    else row.prepend(container);
  }
}
