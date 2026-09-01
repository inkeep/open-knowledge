import { Trans } from '@lingui/react/macro';
import { useEffect, useRef } from 'react';
import { OkBlobRunner } from '@/components/OkBlobRunner';

interface OkBlobRunnerPageProps {
  autoStart?: boolean;
}

export function OkBlobRunnerPage({ autoStart = false }: OkBlobRunnerPageProps = {}) {
  const pageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    pageRef.current?.focus();
  }, []);

  return (
    <div
      ref={pageRef}
      tabIndex={-1}
      className="flex h-full w-full flex-col items-center justify-center gap-8 px-6 py-8 outline-none"
    >
      <div className="flex flex-col items-center gap-1 text-center">
        <h1 className="text-2xl font-light tracking-tighter text-balance">
          <Trans>Blob Run</Trans>
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">
          <Trans>Space to jump, down arrow to duck. That is the whole game.</Trans>
        </p>
      </div>
      {}
      <div className="w-full">
        <OkBlobRunner autoStart={autoStart} />
      </div>
    </div>
  );
}
