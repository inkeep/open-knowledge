import { useLingui } from '@lingui/react/macro';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Cold-load editor skeleton used as the Suspense fallback in the hybrid
 * Activity + Suspense render tree. Mirrors the editor content column grid so
 * the layout does not jump when real content streams in.
 *
 * This only renders on cold load when there is no prior document content to
 * preserve (warm nav keeps the previous Activity entry visible during the
 * transition instead of flashing this skeleton).
 */
export function EditorSkeleton() {
  const { t } = useLingui();
  return (
    // Reuse the tiptap-editor grid so skeleton lines sit in the same content column
    <div
      className="tiptap-editor pt-10"
      role="status"
      aria-busy="true"
      aria-label={t`Loading document`}
    >
      <div className="space-y-3">
        <Skeleton className="h-9 w-2/5 mt-6 mb-5" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    </div>
  );
}
