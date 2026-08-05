/**
 * PageHeader — the cover banner + page-icon surface above the editor body.
 *
 * Reads `icon` + (`banner` ?? `cover`) from the document's frontmatter
 * (Y.Text('source') YAML region) via the same `bindFrontmatterDoc` binding
 * `PropertyPanel` uses. `banner` (Obsidian convention) is preferred over
 * `cover` (Notion convention) — vaults imported from either substrate render
 * without a rename. When only one is set, that key wins.
 *
 * Vertical focal position (`banner_y` / `cover_y`, 0.0–1.0) rides on the
 * source key. A drag interaction on the cover updates the paired `_y` key —
 * commit-on-release, single CRDT write per drag.
 *
 * Renders three states (driven by which frontmatter keys resolve to
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
 * The H1 inside the TipTap body remains the document's actual title —
 * assistive tech sees the drag slider (a real interactive control with
 * `role="slider"` + keyboard support) as the only exposed element in this
 * region; the decorative cover image and icon are unnamed `<img>` tags with
 * empty alt.
 */

import type { HocuspocusProvider } from '@hocuspocus/provider';
import {
  bindFrontmatterDoc,
  type FrontmatterBinding,
  type FrontmatterSnapshot,
  readFmKeys,
  readFmRegionWithError,
} from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { useEffect, useRef, useState } from 'react';
import {
  focalYToObjectPosition,
  parseFocalY,
  pickCoverKey,
  type ResolvedPageCover,
  type ResolvedPageIcon,
  resolvePageCover,
  resolvePageIcon,
} from '@/components/page-header-utils';
import { withPreviewTabPromotion } from '@/editor/preview-tab-promotion';

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
  // Kept in a ref so the drag handler can commit into it without the
  // component needing to re-render on binding creation.
  const bindingRef = useRef<FrontmatterBinding | null>(null);

  useEffect(() => {
    // Wrapped like PropertyPanel's: a cover reframe is a user edit, and it
    // reaches the editors as a sync-origin Y.Text change they can't attribute.
    const next = withPreviewTabPromotion(
      bindFrontmatterDoc(provider),
      provider.configuration.name ?? '',
    );
    bindingRef.current = next;
    setSnapshot(next.current());
    const unsub = next.subscribe((s) => {
      setSnapshot(s);
    });
    return () => {
      unsub();
      next.dispose();
      bindingRef.current = null;
    };
  }, [provider]);

  const icon = resolvePageIcon(snapshot.map.icon);
  const coverKey = pickCoverKey(snapshot.map);
  const cover = coverKey
    ? resolvePageCover(snapshot.map[coverKey])
    : ({ kind: 'unsupported', value: '' } as ResolvedPageCover);
  const focalY = coverKey ? parseFocalY(snapshot.map[`${coverKey}_y`]) : null;

  const hasCover = cover.kind === 'url' || cover.kind === 'path';
  const hasIcon = icon.kind !== 'unsupported';

  if (!hasCover && !hasIcon) return null;

  return (
    <div
      className="page-header editor-content-aligned"
      data-has-cover={hasCover ? 'true' : 'false'}
      data-has-icon={hasIcon ? 'true' : 'false'}
      data-testid="page-header"
    >
      {hasCover && coverKey ? (
        <CoverBanner
          cover={cover}
          focalY={focalY}
          onCommitFocalY={(y) => {
            const b = bindingRef.current;
            if (!b) return;
            const result = b.patch({ [`${coverKey}_y`]: y });
            if (!result.ok) {
              // Same log-and-continue posture as PropertyPanel.commitPatch:
              // silent-drop hides malformed-YAML + region-too-large failures
              // from the operator. The frame reverts visually because the
              // subscribe callback won't fire; the console breadcrumb is the
              // only signal the write was rejected.
              console.warn('[PageHeader] focal-Y patch rejected:', result.error);
            }
          }}
        />
      ) : null}
      {hasIcon ? <PageIconBlock icon={icon} hasCover={hasCover} /> : null}
    </div>
  );
}

interface CoverBannerProps {
  cover: ResolvedPageCover;
  focalY: number | null;
  onCommitFocalY: (y: number) => void;
}

function CoverBanner({ cover, focalY, onCommitFocalY }: CoverBannerProps) {
  const { t } = useLingui();
  // Drag state: while pointer is down we render `dragY` instead of `focalY`
  // for live feedback; on release we commit once. Keyboard adjustment
  // commits immediately (no drag session).
  //
  // The drag is DELTA-based (image moves WITH the pointer, not TO it) — a
  // pure click would otherwise snap the focal point to wherever the pointer
  // landed, jerking the frame on every mousedown. We store the initial
  // client-Y + initial focal-Y at pointerdown and apply the delta on each
  // move. dragY stays null until the first move, so a click that never moves
  // never commits.
  const [dragY, setDragY] = useState<number | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ clientY: number; focal: number } | null>(null);
  const displayY = dragY ?? focalY;
  const objectPosition = focalYToObjectPosition(displayY);
  const percent = Math.round((displayY ?? 0.5) * 100);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // Non-primary buttons (right-click, middle-click) shouldn't drag.
    if (e.button !== 0) return;
    // Skip touch: a swipe across the full-width 200px banner is far more
    // often the user trying to scroll the doc than reframe the cover.
    // Repositioning on touch will get its own explicit affordance later.
    if (e.pointerType === 'touch') return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStartRef.current = { clientY: e.clientY, focal: focalY ?? 0.5 };
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const start = dragStartRef.current;
    const el = wrapperRef.current;
    if (!start || !el) return;
    const rect = el.getBoundingClientRect();
    if (rect.height === 0) return;
    // Delta is inverted: `object-position` Y% counts from the TOP of the
    // image, so dragging the pointer DOWN should DECREASE focalY (the frame
    // scrolls up over the image → the image visibly moves down, WITH the
    // pointer). Without the negation, drag polarity reads as scroll — image
    // moves against the finger.
    const delta = (start.clientY - e.clientY) / rect.height;
    let next = start.focal + delta;
    if (next < 0) next = 0;
    if (next > 1) next = 1;
    setDragY(next);
  }

  function releaseDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragStartRef.current) return;
    dragStartRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Pointer capture may have been lost already (e.g. window blur);
      // release throws in that case and the state cleanup below is what
      // matters.
    }
    const committed = dragY;
    setDragY(null);
    if (committed !== null && committed !== focalY) {
      onCommitFocalY(Math.round(committed * 100) / 100);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Arrow keys follow the WAI-ARIA slider pattern (Up/Right = increase,
    // Down/Left = decrease). focalY is measured from the top of the image
    // (0 = top, 1 = bottom), so ArrowUp INCREASES focalY → shows more of
    // the image bottom. That aligns with drag: dragging up over the frame
    // reveals more of the image bottom, same as ArrowUp.
    const current = focalY ?? 0.5;
    let next: number | null = null;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') next = Math.min(1, current + 0.05);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') next = Math.max(0, current - 0.05);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = 1;
    else return;
    e.preventDefault();
    onCommitFocalY(Math.round(next * 100) / 100);
  }

  return (
    <div className="page-header-cover" data-testid="page-header-cover">
      {/* Interactive slider wraps the img; the img itself stays decorative
          (empty alt). The slider is the only element in this region that
          participates in the a11y tree. */}
      <div
        ref={wrapperRef}
        role="slider"
        tabIndex={0}
        aria-label={t`Cover focal position`}
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={t`${percent}% from top`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={releaseDrag}
        onPointerCancel={releaseDrag}
        onKeyDown={onKeyDown}
        className="page-header-cover-slider"
        data-testid="page-header-cover-slider"
        data-dragging={dragY !== null || undefined}
      >
        {/* `<img>` (not CSS `background-image`) so the browser's native
            loader shows the image, respects `loading="lazy"`, and an
            `onError` could fall back to a placeholder later. */}
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
          style={{ objectPosition }}
        />
      </div>
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
