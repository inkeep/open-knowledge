/**
 * Mount site: `EditorActivityPool`'s per-document column, BETWEEN `DocumentBoundary` and
 * `PropertyPanel`, so the cover/icon shares the Y.Doc lifecycle of the open document AND scrolls
 * with the editor body (precedent #18(b) — keep all per-doc UI inside the boundary).
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
  const bindingRef = useRef<FrontmatterBinding | null>(null);

  useEffect(() => {
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
  const [dragY, setDragY] = useState<number | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ clientY: number; focal: number } | null>(null);
  const displayY = dragY ?? focalY;
  const objectPosition = focalYToObjectPosition(displayY);
  const percent = Math.round((displayY ?? 0.5) * 100);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
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
    } catch {}
    const committed = dragY;
    setDragY(null);
    if (committed !== null && committed !== focalY) {
      onCommitFocalY(Math.round(committed * 100) / 100);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
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
      {}
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
        {}
        <img
          src={cover.value}
          alt=""
          draggable={false}
          loading="lazy"
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
  return (
    <span className={overlay} data-testid="page-header-icon" data-kind={icon.kind}>
      <img
        src={icon.value}
        alt=""
        draggable={false}
        referrerPolicy="no-referrer"
        className="page-header-icon-img"
      />
    </span>
  );
}
