
import { Trans } from '@lingui/react/macro';
import { type ReactElement, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { getMountAbortController, subscribeMountStalled } from '@/editor/mount-promise';

interface MountStalledAffordanceProps {
  docName: string;
}

export function MountStalledAffordance({
  docName,
}: MountStalledAffordanceProps): ReactElement | null {
  const [stalledDocs, setStalledDocs] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const unsubscribe = subscribeMountStalled((stalledDocName) => {
      setStalledDocs((prev) => {
        if (prev.has(stalledDocName)) return prev;
        const next = new Set(prev);
        next.add(stalledDocName);
        return next;
      });
    });
    return unsubscribe;
  }, []);

  if (!stalledDocs.has(docName)) return null;

  function handleCancel(): void {
    const controller = getMountAbortController(docName);
    controller?.abort();
    setStalledDocs((prev) => {
      if (!prev.has(docName)) return prev;
      const next = new Set(prev);
      next.delete(docName);
      return next;
    });
  }

  return (
    <div className="absolute inset-x-0 bottom-8 z-20 flex justify-center text-xs text-muted-foreground">
      <span>
        <Trans>Still loading</Trans>
      </span>
      <Button variant="link" size="sm" className="h-auto px-2 py-0 text-xs" onClick={handleCancel}>
        <Trans>Cancel</Trans>
      </Button>
    </div>
  );
}
