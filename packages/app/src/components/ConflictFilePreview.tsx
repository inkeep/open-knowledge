/**
 * ConflictFilePreview — renders a single file through Pierre's vanilla File
 * class for delete-vs-modify resolution surfaces.
 *
 * overflow:'wrap' is mandatory (not optional): the default 'scroll' produces
 * 17.4x horizontal overflow on a 2,800-char prose paragraph, making the file
 * unreadable behind a scrollbar. The file header is always visible so an empty
 * file does not collapse to an unidentifiable sliver.
 */

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
    // Focusable and named for the same reason as ConflictView's diff region:
    // this renders read-only, so it has no focusable descendants at all and a
    // keyboard user cannot scroll it. They are being asked to choose between
    // keeping a deletion and restoring the file — against a body they cannot
    // read past the first screen.
    <section
      ref={containerRef}
      // Read-only, so it has no focusable descendants at all — without a tab
      // stop the body cannot be scrolled by keyboard. The user is being asked
      // to choose between keeping a deletion and restoring the file, against
      // content they could otherwise only read the first screen of.
      // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard-focusable scroll container — this render has no focusable descendants at all, so without the stop the body cannot be scrolled by keyboard. Same pattern as SyncStatusBadge's scroll container.
      tabIndex={0}
      aria-label={t`Preview of ${filename}`}
      className="conflict-view h-full overflow-y-auto subtle-scrollbar"
    />
  );
}
