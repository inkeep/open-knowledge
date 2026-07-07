/**
 * Image — DIY renderer for the lowercase `img` canonical.
 *
 * Renders the descriptor's 12-prop surface — 2 common (src + alt) + 10
 * advanced (width + height + srcset + sizes + loading + title + decoding +
 * fetchpriority + crossorigin + referrerpolicy) — wrapped in
 * `react-medium-image-zoom`'s `Zoom` always-on (no descriptor prop). Pixel
 * `width` / `height` are layout-shift specialists; most authors lay images
 * out via CSS or container width and don't pin pixel dimensions. When
 * Frame v2 lands as a compositional wrapper, `<Frame zoom={false}>` will be
 * the opt-out path; today there is no opt-out.
 *
 * `wrapElement="span"` is load-bearing: HTML spec forbids `<div>` inside
 * `<p>`, and MDX parsing often lands `<img>` inside a paragraph (tight image
 * links, markdown `![alt](src)` after autolink/CommonMark promotion).
 *
 * `zoomMargin={20}` matches the upstream-docs-lib default — the zoom-modal's
 * padding from the viewport edge when expanded. `zoomImg={{ sizes: undefined }}`
 * forces the zoom-view image to NOT inherit the authored `sizes` attribute
 * (which would constrain the zoomed rendering to the thumbnail's breakpoints).
 *
 * `loading` defaults to `'lazy'` when undefined — matches browser-default
 * behavior for images below the fold but avoids silently loading any image
 * eagerly on mount.
 *
 * `caption` is NOT a prop on this descriptor — Frame v2 (compositional
 * wrapper) is the canonical home for caption + border + decorations.
 *
 * HTML-attr lowercase ↔ React camelCase translation happens here at the JSX
 * boundary: `srcset → srcSet`, `fetchpriority → fetchPriority`,
 * `crossorigin → crossOrigin`, `referrerpolicy → referrerPolicy`. The
 * descriptor stores the HTML-spec spelling so emitted MDX matches the spec
 * exactly; React's intrinsic `<img>` type expects camelCase.
 */

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
  // advanced — HTML-native attrs, lowercase per the HTML spec
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

/**
 * Bare `<img>` — the leaf rendered inside `<Zoom>`. Delegates to LoadingImage
 * so the rendered DOM reserves layout space and shows a Skeleton placeholder
 * until the inner `<img>.load` event fires, then swaps to the loaded image
 * without document reflow. Translates lowercase HTML-attr names to React's
 * camelCase at this JSX boundary.
 */
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

/**
 * DIY Image. Descriptor-dispatched via `componentMap['img']`.
 *
 * The `Zoom` wrapper reads its child `<img>`'s `src` to build the zoom-view;
 * no manual `zoomImg.src` plumbing needed. We override `sizes` to `undefined`
 * so the zoom-view doesn't inherit a thumbnail-scoped sizes attribute.
 */
export function Image(props: ImageProps) {
  return (
    <Zoom wrapElement="span" zoomMargin={20} zoomImg={{ sizes: undefined }}>
      <BareImg {...props} />
    </Zoom>
  );
}
