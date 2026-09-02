import { Trans } from '@lingui/react/macro';
import { useEffect, useRef } from 'react';
import { UserText } from '@/components/UserText';
import { Button } from '@/components/ui/button';

export function NoteWindowDeletedState({ docName }: { docName: string }) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  return (
    <div
      data-testid="note-window-deleted-state"
      className="flex h-full flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <h2 className="font-medium text-base text-foreground">
        <Trans>This document was deleted</Trans>
      </h2>
      {}
      <p className="max-w-md break-all text-muted-foreground text-sm">
        <UserText>{docName}</UserText>
      </p>
      <Button
        ref={closeButtonRef}
        variant="secondary"
        onClick={() => {
          window.close();
        }}
      >
        <Trans>Close window</Trans>
      </Button>
    </div>
  );
}
