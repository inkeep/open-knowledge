
import { rewriteEmbedUrl } from '@inkeep/open-knowledge-core';
import { useEffect, useRef } from 'react';
import { useJsxComponentHost } from './jsx-host-context.tsx';
import { ResizeHandles } from './ResizeHandles.tsx';

interface EmbedProps {
  src?: string;
  title?: string;
  width?: string;
  height?: string;
  align?: 'left' | 'center' | 'right';
}

const DEFAULT_HEIGHT = '26rem';
const DEFAULT_TITLE = 'Embedded content';

const HTTP_SCHEME_RE = /^https?:\/\//i;

function isCrossOriginUrl(src: string): boolean {
  try {
    return new URL(src).origin !== window.location.origin;
  } catch {
    return false;
  }
}

function isEmbedSrcSafe(src: string | undefined): boolean {
  if (typeof src !== 'string') return false;
  if (!HTTP_SCHEME_RE.test(src)) return false;
  if (!isCrossOriginUrl(src)) return false;
  return true;
}

export function Embed({ src, title, width, height }: EmbedProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const host = useJsxComponentHost();

  const initialStyle = {
    width: width || undefined,
    height: height || DEFAULT_HEIGHT,
  };

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    el.style.width = width || '';
    el.style.height = height || DEFAULT_HEIGHT;
  }, [width, height]);

  if (!isEmbedSrcSafe(src)) {
    let message = 'Embed a URL';
    if (typeof src === 'string' && src.length > 0) {
      message = HTTP_SCHEME_RE.test(src)
        ? 'Embed only supports cross-origin URLs'
        : 'URL must start with http:// or https://';
    }
    return (
      <div className="ok-embed ok-embed--placeholder" contentEditable={false}>
        <span>{message}</span>
      </div>
    );
  }

  const writeSize = (next: { width: number; height: number }) => {
    if (!host) return;
    const { editor, getPos } = host;
    const pos = getPos();
    if (typeof pos !== 'number') return;
    try {
      const node = editor.state.doc.nodeAt(pos);
      if (!node || node.type.name !== 'jsxComponent') return;
      const props = (node.attrs.props as Record<string, unknown>) ?? {};
      const nextProps = {
        ...props,
        width: `${Math.round(next.width)}px`,
        height: `${Math.round(next.height)}px`,
      };
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(pos, null, {
          ...node.attrs,
          props: nextProps,
          sourceDirty: true,
        }),
      );
    } catch (err) {
      if (err instanceof RangeError) return;
      throw err;
    }
  };

  const iframeSrc = rewriteEmbedUrl(src);
  const referrerPolicy = iframeSrc !== src ? 'strict-origin-when-cross-origin' : 'no-referrer';

  return (
    <div className="ok-embed" style={initialStyle} ref={wrapperRef} contentEditable={false}>
      <iframe
        title={title || DEFAULT_TITLE}
        src={iframeSrc}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation"
        referrerPolicy={referrerPolicy}
        loading="lazy"
        className="ok-embed-frame"
      />
      {host ? (
        <ResizeHandles
          targetRef={wrapperRef}
          bounds={{
            minWidth: 192,
            maxWidth: 2000,
            minHeight: 128,
            maxHeight: Math.round(window.innerHeight * 0.9),
          }}
          onResize={(size) => {
            const el = wrapperRef.current;
            if (!el) return;
            el.style.width = `${size.width}px`;
            el.style.height = `${size.height}px`;
          }}
          onResizeEnd={writeSize}
        />
      ) : null}
    </div>
  );
}
