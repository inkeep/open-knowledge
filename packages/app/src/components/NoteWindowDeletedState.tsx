/**
 * What a popped-out note window shows once its document is deleted.
 *
 * Deliberately a terminal state rather than a redirect or an auto-close. The
 * window is a place the user parked a specific document, often on another
 * monitor: closing it out from under them loses the position they chose, and
 * navigating it somewhere else turns a one-document window into a surface it was
 * never meant to be. Saying plainly that the document is gone, and letting them
 * close the window themselves, is the only option that does not act on their
 * behalf.
 */

import { Trans } from '@lingui/react/macro';
import { useEffect, useRef } from 'react';
import { UserText } from '@/components/UserText';
import { Button } from '@/components/ui/button';

export function NoteWindowDeletedState({ docName }: { docName: string }) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // This replaces the editor surface, so move focus to the one actionable
  // control. A keyboard user who was editing when the document was deleted would
  // otherwise be stranded on `document.body` with no reachable affordance.
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
      {/* The name is user content, so it renders as data rather than being
          folded into the sentence above — no interpolation to mis-translate —
          and through `UserText` so its writing direction comes from the name
          itself rather than the interface language. */}
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
