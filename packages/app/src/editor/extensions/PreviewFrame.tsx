import type { RefObject } from 'react';
import { buildPreviewDocumentMessage, PREVIEW_FRAME_URL } from './preview-iframe-header';

interface PreviewFrameProps {
  html: string;
  title: string;
  className?: string;
  frameRef?: RefObject<HTMLIFrameElement | null>;
  onLoad?: () => void;
}

export function PreviewFrame({ html, title, className, frameRef, onLoad }: PreviewFrameProps) {
  return (
    <iframe
      key={html}
      ref={frameRef}
      title={title}
      src={PREVIEW_FRAME_URL}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className={className}
      onLoad={(event) => {
        event.currentTarget.contentWindow?.postMessage(buildPreviewDocumentMessage(html), '*');
        onLoad?.();
      }}
    />
  );
}
