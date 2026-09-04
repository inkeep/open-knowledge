import { useLingui } from '@lingui/react/macro';
import { File as PierreFile } from '@pierre/diffs';
import { useEffect, useRef } from 'react';
import { okPierreTheme } from '@/lib/pierre-theme';

interface ConflictFilePreviewProps {
  filename: string;
  content: string;
}

export function ConflictFilePreview({ filename, content }: ConflictFilePreviewProps) {
  const { t } = useLingui();
  const containerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const inst = new PierreFile({ overflow: 'wrap', theme: okPierreTheme() });
    inst.render({
      file: { name: filename, contents: content },
      containerWrapper: container,
    });

    return () => {
      inst.cleanUp();
    };
  }, [filename, content]);

  return (
    <section
      ref={containerRef}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard-focusable scroll container — this render has no focusable descendants at all, so without the stop the body cannot be scrolled by keyboard. Same pattern as SyncStatusBadge's scroll container.
      tabIndex={0}
      aria-label={t`Preview of ${filename}`}
      className="conflict-view h-full overflow-y-auto subtle-scrollbar"
    />
  );
}
