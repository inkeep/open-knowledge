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
  // the terminal-state signal dismisses the skeleton in that case.
  // Re-running on src change resets both flags when the same instance is
  // reused with a new src (e.g. AssetPreview switching assets).
  // biome-ignore lint/correctness/useExhaustiveDependencies: src drives the reactive trigger only; the effect body reads imgRef.current so biome flags src as unused.
  useLayoutEffect(() => {
    const img = imgRef.current;
    if (img?.complete) {
      setLoaded(true);
    } else {
      setLoaded(false);
    }
    // NOTE: don't try to infer error from `complete && naturalWidth === 0`
    // — per the HTML spec that shape is also produced by a successful
    // load of a dimensionless resource (SVG with only a viewBox, images
    // sized by CSS). onError is the only unambiguous signal.
    setHasError(false);
  }, [src]);

  // A visible placeholder overlay replaces the browser's default 16x16
  // broken-image glyph so the reader can tell the asset is missing instead
  // of assuming the block rendered empty. The <img> stays mounted (hidden
  // via CSS) so consumers that inspect the DOM — clipboard walker, prop
  // panel, e2e tests reading img.src — still find it with the authored
  // src, matching the storage-layer fidelity contract (bytes land verbatim
  // in the CRDT even when the render layer shows a fallback).
  //
  // Always announce on error: `alt` at this layer conflates "author opted
  // in to decorative" with "no alt was authored" (Image.tsx coerces
  // `props.alt ?? ''`, and `![](/x.png)` markdown reaches here with
  // alt=''). Silencing the pill for alt='' would silence broken
  // no-alt-authored images too.
  const errorLabel = alt && alt.length > 0 ? alt : (src ?? '');

  return (
    <span
      data-testid={slotTestId}
      data-image-error={hasError ? 'true' : undefined}
      className={cn(
        'relative inline-block overflow-hidden',
        // Pre-load only: reserve a 16:9 slot to prevent the "0x0 box → reflow"
        // symptom. Post-load, release the constraint so a consumer's
        // object-contain / max-h-full styling can govern the image's
        // natural shape — otherwise sidebar previews would be locked at 16:9
        // forever, letterboxing portrait assets.
        !intrinsic && !loaded && !hasError && 'aspect-[16/9] w-full max-w-full',
        slotClassName,
      )}
      style={slotStyle}
    >
      {!loaded && !hasError && (
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
        // `hidden` keeps the img in the DOM (queryable by tests + the
        // clipboard walker) but out of the visual + a11y trees when the
        // error placeholder is showing.
        hidden={hasError || undefined}
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
          // Route into the placeholder overlay on next render — the
          // skeleton also dismisses so screen readers stop announcing
          // aria-busy="true" forever.
          setLoaded(true);
          setHasError(true);
          onError?.(event);
        }}
      />
      {hasError && (
        <span
          role="img"
          aria-label={t`Image failed to load: ${errorLabel}`}
          className="inline-flex max-w-full items-center gap-2 rounded-md border border-dashed border-border bg-muted/40 px-2 py-1 text-muted-foreground"
        >
          <ImageOff aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
          <span className="text-xs font-medium">{t`Image failed to load`}</span>
          {src ? (
            <span className="max-w-[24ch] truncate font-mono text-xs opacity-70" title={src}>
              {src}
            </span>
          ) : null}
        </span>
      )}
    </span>
  );
}
