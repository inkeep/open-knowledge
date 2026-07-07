/**
 * PageHeader — the cover banner + page-icon surface above the editor body.
 *
 * Reads `icon` + `cover` from the document's frontmatter (Y.Text('source')
 * YAML region) via the same `bindFrontmatterDoc` binding `PropertyPanel`
 * uses. Renders three states (driven by which frontmatter keys resolve to
 * supported values per `page-header-utils.ts`):
 *
 *   1. **cover + icon**: full-width cover banner; icon overlays the bottom-
 *      left of the cover (Notion-style — half the icon sits on top of the
 *      cover, half hangs below into the property panel's gutter).
 *   2. **cover only**: just the banner.
 *   3. **icon only**: a small icon row above the property panel (no
 *      banner).
 *   4. **neither**: render nothing — zero layout shift for docs that
 *      don't opt in.
 *
 * Mount site: `EditorActivityPool`'s per-document column, BETWEEN
 * `DocumentBoundary` and `PropertyPanel`, so the cover/icon shares the
 * Y.Doc lifecycle of the open document AND scrolls with the editor
 * body (precedent #18(b) — keep all per-doc UI inside the boundary).
 *
 * The `aria-hidden` attribute marks the header as decoration; the
 * H1 inside the TipTap body remains the document's actual title. This
 * avoids fighting screen readers over which surface to announce.
 */

import type { HocuspocusProvider } from '@hocuspocus/provider';
import {
  bindFrontmatterDoc,
  type FrontmatterSnapshot,
  readFmKeys,
  readFmRegionWithError,
} from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';
import {
  type ResolvedPageCover,
  type ResolvedPageIcon,
  resolvePageCover,
  resolvePageIcon,
} from '@/components/page-header-utils';

interface PageHeaderProps {
  provider: HocuspocusProvider;
}

/**
 * Read the initial frontmatter snapshot synchronously from the provider
 * — same direct-read pattern as `PropertyPanel.readInitialSnapshot`. We
 * read the source bytes once and parse, avoiding the
 * allocate-binding-and-immediately-dispose pattern an earlier draft of
 * this file used.
 */
function readInitialSnapshot(provider: HocuspocusProvider): FrontmatterSnapshot {
  const ytext = provider.document.getText('source').toString();
  const { map, parseError } = readFmRegionWithError(ytext);
  const keys = readFmKeys(ytext);
  return { map, keys, parseError };
}

export function PageHeader({ provider }: PageHeaderProps) {
  const [snapshot, setSnapshot] = useState<FrontmatterSnapshot>(() =>
    readInitialSnapshot(provider),
  );

  useEffect(() => {
    // Closure-scoped binding — there is no consumer that reads the
    // binding from React state, so a `useState` slot would just pay
    // for an extra unmount-time render. Lifecycle is bounded by the
    // effect: `subscribe()` runs while mounted, `unsub()` + `dispose()`
    // run on cleanup.
    const next = bindFrontmatterDoc(provider);
    setSnapshot(next.current());
    const unsub = next.subscribe((s) => {
      setSnapshot(s);
    });
    return () => {
      unsub();
      next.dispose();
    };
  }, [provider]);

  const icon = resolvePageIcon(snapshot.map.icon);
  const cover = resolvePageCover(snapshot.map.cover);

  const hasCover = cover.kind === 'url' || cover.kind === 'path';
  const hasIcon = icon.kind !== 'unsupported';

  if (!hasCover && !hasIcon) return null;

  return (
    <div
      className="page-header editor-content-aligned"
      data-has-cover={hasCover ? 'true' : 'false'}
      data-has-icon={hasIcon ? 'true' : 'false'}
      aria-hidden="true"
      data-testid="page-header"
    >
      {hasCover ? <CoverBanner cover={cover} /> : null}
      {hasIcon ? <PageIconBlock icon={icon} hasCover={hasCover} /> : null}
    </div>
  );
}

function CoverBanner({ cover }: { cover: ResolvedPageCover }) {
  // `<img>` (not CSS `background-image`) so the browser's native loader
  // shows the image, respects `loading="lazy"`, and an `onError` could
  // fall back to a placeholder later. `draggable={false}` so cover-drag
  // doesn't accidentally start a media drag-out gesture from the
  // editor.
  return (
    <div className="page-header-cover" data-testid="page-header-cover">
      <img
        src={cover.value}
        alt=""
        draggable={false}
        loading="lazy"
        // `cover.value` can be an attacker-controlled external host
        // (`url` kind). Match `Embed` / `CodeBlockView` / `Image` —
        // never leak the doc path + query params in Referer.
        referrerPolicy="no-referrer"
        className="page-header-cover-img"
      />
    </div>
  );
}

function PageIconBlock({ icon, hasCover }: { icon: ResolvedPageIcon; hasCover: boolean }) {
  const overlay = hasCover ? 'page-header-icon page-header-icon--with-cover' : 'page-header-icon';
  if (icon.kind === 'emoji') {
    return (
      <span className={overlay} data-testid="page-header-icon" data-kind="emoji">
        {icon.value}
      </span>
    );
  }
  // `url` / `path` — rendered as an `<img>`. `path` is already
  // `toDesktopAssetHref`-wrapped in resolvePageIcon.
  return (
    <span className={overlay} data-testid="page-header-icon" data-kind={icon.kind}>
      <img
        src={icon.value}
        alt=""
        draggable={false}
        // External-host icons leak Referer without this — same posture
        // as the cover banner above.
        referrerPolicy="no-referrer"
        className="page-header-icon-img"
      />
    </span>
  );
}
