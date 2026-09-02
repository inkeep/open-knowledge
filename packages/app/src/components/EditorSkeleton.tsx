import { useLingui } from '@lingui/react/macro';
import { Skeleton } from '@/components/ui/skeleton';

export function EditorSkeleton() {
  const { t } = useLingui();
  return (
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
