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
  targetExistence?: ImageTargetExistence;
};

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
  const [reloadNonce, setReloadNonce] = useState(0);
  const intrinsic = hasIntrinsicDimensions(width, height);
  const slotStyle = computeSlotStyle(width, height, style);

  // biome-ignore lint/correctness/useExhaustiveDependencies: src + reloadNonce drive the reactive trigger; the effect body reads imgRef.current so biome flags them as unused.
  useLayoutEffect(() => {
    const img = imgRef.current;
    if (img?.complete) {
      setLoaded(true);
      setHasError(false);
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

  const errorKind: ImageErrorKind =
    targetExistence === 'missing' ? 'not-found' : hasError ? 'undisplayable' : null;

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
      data-image-error={errorKind ? 'true' : undefined}
      data-image-error-kind={errorKind ?? undefined}
      className={cn(
        'relative inline-block overflow-hidden',
        !intrinsic && !loaded && !errorKind && 'aspect-[16/9] w-full max-w-full',
        slotClassName,
      )}
      style={slotStyle}
    >
      {!loaded && !errorKind && (
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
        key={reloadNonce}
        ref={imgRef}
        src={src}
        alt={alt}
        width={width}
        height={height}
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
          setLoaded(true);
          setHasError(true);
          onError?.(event);
        }}
      />
      {errorKind && (
        <span
          role="img"
          aria-label={errorAriaLabel}
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
