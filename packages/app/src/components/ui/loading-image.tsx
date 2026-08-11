import { useLingui } from '@lingui/react/macro';
import { ImageOff } from 'lucide-react';
import type { CSSProperties, ImgHTMLAttributes } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { OPT_OUT_ATTR } from '@/editor/clipboard/clipboard-sanitize';
import type { ImageTargetExistence } from '@/editor/components/image-target-existence';
import { cn } from '@/lib/utils';

type LoadingImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  width?: number | string;
  height?: number | string;
  loadingTestId?: string;
  slotTestId?: string;
  slotClassName?: string;
  /**
   * Server/inventory-known existence of the target the src points at, kept
   * distinct from whether the `<img>` decoded. `'missing'` (proven absent)
   * renders the "Image not found" placeholder authoritatively — even before a
   * load attempt and even over a stale cached bitmap — so a deleted target
   * heals to the truthful state. `'exists'` / `'unknown'` never claim absence:
   * a decode/permission/serving failure there reads "Image couldn't be
   * displayed". Defaults to `'unknown'`.
   */
  targetExistence?: ImageTargetExistence;
};

/** Which truthful placeholder to show, or none. */
type ImageErrorKind = 'not-found' | 'undisplayable' | null;

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
  targetExistence = 'unknown',
  ...imgProps
}: LoadingImageProps) {
  const { t } = useLingui();
  const imgRef = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);
  // Bumped when a proven-missing target becomes present, to remount the
  // cached-failed <img> and force a fresh request (see the healing effect).
  const [reloadNonce, setReloadNonce] = useState(0);
  const intrinsic = hasIntrinsicDimensions(width, height);
  const slotStyle = computeSlotStyle(width, height, style);

  // Cached or preloaded images may be `complete` at mount and never fire
  // onLoad/onError after React commits — the skeleton would otherwise persist
  // forever and the <img> stay stuck at opacity-0. Treating `complete` as
  // the terminal-state signal dismisses the skeleton in that case.
  // Re-running on src / reloadNonce change resets both flags when the same
  // instance is reused with a new src (AssetPreview switching assets) or
  // remounted to re-request a now-present target.
  // biome-ignore lint/correctness/useExhaustiveDependencies: src + reloadNonce drive the reactive trigger; the effect body reads imgRef.current so biome flags them as unused.
  useLayoutEffect(() => {
    const img = imgRef.current;
    if (img?.complete) {
      // `complete && naturalWidth === 0` is NOT read as failure: per the HTML
      // spec that shape is also a successful load of a dimensionless resource
      // (SVG with only a viewBox, images sized by CSS). Treat complete as
      // loaded and let decode() — the only unambiguous cached signal — flip to
      // error when the bytes genuinely can't be decoded.
      setLoaded(true);
      setHasError(false);
      // R7/R10 boundary: HTMLImageElement.decode() is a browser API; a real
      // EncodingError rejection is the cached decode/serve failure this handler
      // exists for (fresh loads take the onError path instead). Absent in
      // jsdom (feature-detected out), covered for real by the browser e2e.
      if (typeof img.decode === 'function') {
        let cancelled = false;
        void img.decode().then(
          () => {},
          () => {
            if (!cancelled) setHasError(true);
          },
        );
        return () => {
          cancelled = true;
        };
      }
    } else {
      setLoaded(false);
      setHasError(false);
    }
  }, [src, reloadNonce]);

  // Heal a proven-missing target that becomes present (created / renamed on
  // disk — the CC1 `files` push flips `targetExistence`). The cached <img>
  // still holds its failed fetch, so reset and bump the remount nonce to
  // re-request the now-existing bytes rather than sit on "not found".
  const prevExistenceRef = useRef(targetExistence);
  useEffect(() => {
    const prev = prevExistenceRef.current;
    prevExistenceRef.current = targetExistence;
    if (prev === 'missing' && targetExistence !== 'missing') {
      setLoaded(false);
      setHasError(false);
      setReloadNonce((n) => n + 1);
    }
  }, [targetExistence]);

  // Target-existence truth is authoritative over image-render truth: a proven-
  // absent target says "not found" regardless of any cached bitmap; only when
  // the target is present or unknown does a decode/serve failure say
  // "couldn't be displayed" (never claiming absence it can't prove).
  const errorKind: ImageErrorKind =
    targetExistence === 'missing' ? 'not-found' : hasError ? 'undisplayable' : null;

  // Always announce on error: `alt` at this layer conflates "author opted in to
  // decorative" with "no alt was authored" (Image.tsx coerces `props.alt ?? ''`,
  // and `![](/x.png)` reaches here with alt=''). Silencing for alt='' would
  // silence broken no-alt-authored images too. The label carries target context.
  const errorLabel = alt && alt.length > 0 ? alt : (src ?? '');
  const errorMessage =
    errorKind === 'not-found' ? t`Image not found` : t`Image couldn't be displayed`;
  const errorAriaLabel =
    errorKind === 'not-found'
      ? t`Image not found: ${errorLabel}`
      : t`Image couldn't be displayed: ${errorLabel}`;

  return (
    <span
      data-testid={slotTestId}
      // `data-image-error="true"` stays the exact marker the clipboard walker's
      // `unhideErrorSlotImages` scopes its hidden-<img> un-hide to — both
      // placeholder kinds carry it so a broken-but-portable image still pastes
      // as a plain <img> with its authored src.
      data-image-error={errorKind ? 'true' : undefined}
      data-image-error-kind={errorKind ?? undefined}
      className={cn(
        'relative inline-block overflow-hidden',
        // Pre-load only: reserve a 16:9 slot to prevent the "0x0 box → reflow"
        // symptom. Post-load, release the constraint so a consumer's
        // object-contain / max-h-full styling can govern the image's
        // natural shape — otherwise sidebar previews would be locked at 16:9
        // forever, letterboxing portrait assets.
        !intrinsic && !loaded && !errorKind && 'aspect-[16/9] w-full max-w-full',
        slotClassName,
      )}
      style={slotStyle}
    >
      {!loaded && !errorKind && (
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
        // Remount on heal so a cached-failed request is re-issued for a
        // now-present target. Same authored src is preserved (no cache-busting
        // query), keeping clipboard / DOM-inspection fidelity intact.
        key={reloadNonce}
        ref={imgRef}
        src={src}
        alt={alt}
        width={width}
        height={height}
        // `hidden` keeps the img in the DOM (queryable by tests + the
        // clipboard walker) but out of the visual + a11y trees when a
        // placeholder is showing.
        hidden={errorKind ? true : undefined}
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
      {errorKind && (
        <span
          role="img"
          aria-label={errorAriaLabel}
          // Render-layer chrome only: the clipboard walker strips opt-out
          // children from cross-app copies, so the pill text never pastes
          // as if it were document content. The hidden <img> sibling stays
          // in the clone and carries the authored src (the walker's
          // error-slot un-hide pass drops the hidden attr from the clone).
          {...{ [OPT_OUT_ATTR]: 'true' }}
          className="ok-image-error-placeholder box-border inline-grid max-w-full grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 rounded-md border border-dashed px-2 py-1 text-foreground"
        >
          <ImageOff aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0">
            <span className="ok-image-error-message block text-xs font-medium">{errorMessage}</span>
            {src ? (
              <span
                className="ok-image-error-target block max-w-[24ch] truncate font-mono text-xs"
                title={src}
              >
                {src}
              </span>
            ) : null}
          </span>
        </span>
      )}
    </span>
  );
}
