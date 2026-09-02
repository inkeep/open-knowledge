import { formatFileSize } from '@inkeep/open-knowledge-core';
import { Trans } from '@lingui/react/macro';
import { ArrowLeft, FileWarning } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';

interface LargeFileEditorStateProps {
  docName: string;
  size: number;
  limit: number;
  backNav?: {
    previousDocName: string;
    onNavigateBack: (previousDocName: string) => void;
  };
}

export function LargeFileEditorState({ docName, size, limit, backNav }: LargeFileEditorStateProps) {
  const canGoBack = backNav !== undefined;
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (canGoBack) {
      backButtonRef.current?.focus();
    } else {
      headingRef.current?.focus();
    }
  }, [canGoBack]);

  return (
    <Empty
      role="status"
      aria-labelledby={titleId}
      data-slot="large-file-editor-state"
      className="h-full gap-8 p-8"
    >
      <EmptyMedia
        variant="icon"
        className="mb-0 size-16 rounded-full border bg-muted/40 text-muted-foreground"
      >
        <FileWarning className="size-9" aria-hidden="true" />
      </EmptyMedia>
      <EmptyHeader className="max-w-md gap-1">
        {}
        <EmptyTitle asChild className="text-2xl font-light outline-none">
          <h2 ref={headingRef} id={titleId} tabIndex={canGoBack ? undefined : -1}>
            <Trans>File too large to open</Trans>
          </h2>
        </EmptyTitle>
        <EmptyDescription>
          <Trans>
            {docName} is {formatFileSize(size)}. OpenKnowledge currently opens files up to{' '}
            {formatFileSize(limit)}.
          </Trans>
        </EmptyDescription>
      </EmptyHeader>
      {canGoBack ? (
        <EmptyContent>
          <Button
            ref={backButtonRef}
            variant="default"
            onClick={() => backNav.onNavigateBack(backNav.previousDocName)}
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            <Trans>Go back</Trans>
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
