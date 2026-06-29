
import { toDesktopAssetHref } from '@inkeep/open-knowledge-core';
import type { ImgHTMLAttributes } from 'react';
import Zoom from 'react-medium-image-zoom';
import { LoadingImage } from '@/components/ui/loading-image';

interface ImageProps {
  src?: string;
  alt?: string;
  width?: number | string;
  height?: number | string;
  title?: string;
  loading?: 'eager' | 'lazy';
  srcset?: string;
  sizes?: string;
  decoding?: 'sync' | 'async' | 'auto';
  fetchpriority?: 'high' | 'low' | 'auto';
  crossorigin?: '' | 'anonymous' | 'use-credentials';
  referrerpolicy?: ImgHTMLAttributes<HTMLImageElement>['referrerPolicy'];
}

function resolveLoading(loading: 'eager' | 'lazy' | undefined): 'eager' | 'lazy' {
  return loading ?? 'lazy';
}

function coerceDimension(value: number | string | undefined): number | string | undefined {
  if (typeof value !== 'string') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : value;
}

function BareImg(props: ImageProps) {
  return (
    <LoadingImage
      src={props.src === undefined ? undefined : toDesktopAssetHref(props.src)}
      alt={props.alt ?? ''}
      width={coerceDimension(props.width)}
      height={coerceDimension(props.height)}
      title={props.title}
      loading={resolveLoading(props.loading)}
      srcSet={props.srcset}
      sizes={props.sizes}
      decoding={props.decoding}
      fetchPriority={props.fetchpriority}
      crossOrigin={props.crossorigin}
      referrerPolicy={props.referrerpolicy}
    />
  );
}

export function Image(props: ImageProps) {
  return (
    <Zoom wrapElement="span" zoomMargin={20} zoomImg={{ sizes: undefined }}>
      <BareImg {...props} />
    </Zoom>
  );
}
