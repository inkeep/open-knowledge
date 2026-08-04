import { useLingui } from '@lingui/react/macro';
import { ImageOff } from 'lucide-react';
import type { CSSProperties, ImgHTMLAttributes } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

type LoadingImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  width?: number | string;
  height?: number | string;
  loadingTestId?: string;
  slotTestId?: string;
  slotClassName?: string;
};

function hasIntrinsicDimensions(
  width: number | string | undefined,
  height: number | string | undefined,
): width is number {
  return typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0;
}

function computeSlotStyle(
  width: number | string | undefined,
  height: number | string | undefined,
  inherited: CSSProperties | undefined,
): CSSProperties | undefined {
  if (hasIntrinsicDimensions(width, height)) {
    return {
      ...inherited,
      width: `${width}px`,
      aspectRatio: `${width} / ${height}`,
    };
  }
  return inherited;
}

export function LoadingImage({
  width,
  height,
  loadingTestId = 'image-loading-skeleton',
  slotTestId = 'image-slot',
  slotClassName,
  className,
  onLoad,
  onError,
  src,
  style,
  alt = '',
  ...imgProps
}: LoadingImageProps) {
  const { t } = useLingui();
  const imgRef = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);
  const intrinsic = hasIntrinsicDimensions(width, height);
  const slotStyle = computeSlotStyle(width, height, style);

  // Cached or preloaded images may be `complete` at mount and never fire
  // onLoad after React commits — the skeleton would otherwise persist
  // forever and the <img> stay stuck at opacity-0. Treating `complete` as
  // the terminal-state signal (regardless of naturalWidth) also dismisses
  // the skeleton for cached failures whose onError may not re-fire, mirroring
  // the onError handler's semantics. `naturalWidth === 0` on a `complete`
  // img means the load actually failed (broken/404 cache) — surface that as
  // the error placeholder instead of leaving the reader looking at the
  // browser's tiny default broken-image glyph. Re-running on src change
  // resets both flags when the same instance is reused with a new src.
  // biome-ignore lint/correctness/useExhaustiveDependencies: src is the reactive trigger; the body reads imgRef.current (refs don't trigger re-runs) so biome treats src as unused.
  useLayoutEffect(() => {
    const img = imgRef.current;
    if (img?.complete) {
      setLoaded(true);
      setHasError(img.naturalWidth === 0);
    } else {
      setLoaded(false);
      setHasError(false);
    }
  }, [src]);

  if (hasError) {
    // A visible placeholder card replaces the browser's default 16x16
    // broken-image glyph so the reader can tell the asset is missing
    // instead of assuming the block rendered empty. Stays a `<span>` for
    // the same phrasing-content reason the slot is — Image.tsx wraps this
    // in `<Zoom wrapElement="span">` and markdown often lands `<img>`
    // inside `<p>`, where `<div>` is forbidden.
    const label = alt && alt.length > 0 ? alt : (src ?? '');
    return (
      <span
        data-testid={slotTestId}
        data-image-error="true"
        role="img"
        aria-label={t`Image failed to load: ${label}`}
        className={cn(
          'inline-flex max-w-full items-center gap-2 rounded-md border border-dashed border-border bg-muted/40 px-2 py-1 text-muted-foreground',
          slotClassName,
        )}
        style={intrinsic ? slotStyle : undefined}
      >
        <ImageOff aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
        <span className="text-xs font-medium">{t`Image failed to load`}</span>
        {src ? (
          <span className="max-w-[24ch] truncate font-mono text-[10px] opacity-70" title={src}>
            {src}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <span
      data-testid={slotTestId}
      className={cn(
        'relative inline-block overflow-hidden',
        // Pre-load only: reserve a 16:9 slot to prevent the "0x0 box → reflow"
        // symptom. Post-load, release the constraint so a consumer's
        // object-contain / max-h-full styling can govern the image's
        // natural shape — otherwise sidebar previews would be locked at 16:9
        // forever, letterboxing portrait assets.
        !intrinsic && !loaded && 'aspect-[16/9] w-full max-w-full',
        slotClassName,
      )}
      style={slotStyle}
    >
      {!loaded && (
        // Inline-content the skeleton element directly rather than reaching for
        // shadcn `<Skeleton>` (which is a `<div>`). The slot is a `<span>`
        // because `Image.tsx`'s `<Zoom wrapElement="span">` constrains its
        // child to phrasing content (markdown often lands `<img>` inside `<p>`,
        // where `<div>` is forbidden). Reusing Skeleton's visual classes here
        // keeps the appearance identical while preserving the inline content
        // model.
        <span
          data-testid={loadingTestId}
          role="status"
          aria-busy="true"
          aria-label={t`Loading image`}
          className="absolute inset-0 animate-pulse rounded-md bg-muted motion-reduce:animate-none"
        />
      )}
      <img
        {...imgProps}
        ref={imgRef}
        src={src}
        alt={alt}
        width={width}
        height={height}
        className={cn(
          'block max-w-full transition-opacity motion-reduce:transition-none',
          loaded ? 'opacity-100' : 'opacity-0',
          className,
        )}
        onLoad={(event) => {
          setLoaded(true);
          setHasError(false);
          onLoad?.(event);
        }}
        onError={(event) => {
          // Route into the placeholder branch on next render — the
          // skeleton also dismisses so screen readers stop announcing
          // aria-busy="true" forever.
          setLoaded(true);
          setHasError(true);
          onError?.(event);
        }}
      />
    </span>
  );
}
