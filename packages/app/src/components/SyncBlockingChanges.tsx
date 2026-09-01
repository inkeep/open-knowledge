import { Trans } from '@lingui/react/macro';
import { Terminal } from 'lucide-react';
import { useState } from 'react';
import { requestTerminalCommand } from '@/components/handoff/terminal-command-events';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { resolveBlockingChanges } from '@/lib/resolve-blocking';

function terminalAvailable(): boolean {
  return typeof window !== 'undefined' && window.okDesktop != null;
}

export function SyncBlockingChanges({ paths }: { paths: readonly string[] }) {
  const [pending, setPending] = useState<'commit' | null>(null);
  const [failed, setFailed] = useState(false);

  if (paths.length === 0) return null;

  async function run(action: 'commit') {
    setPending(action);
    setFailed(false);
    try {
      await resolveBlockingChanges(action);
      setPending(null);
    } catch {
      setFailed(true);
      setPending(null);
    }
  }

  const busy = pending !== null;

  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <div className="flex flex-col gap-0.5">
        <span id="sync-blocking-heading" className="text-xs font-medium text-foreground">
          <Trans>Changed here and on the remote</Trans>
        </span>
        <span className="text-2xs text-muted-foreground">
          <Trans>
            Sync is paused. Commit these local edits to continue, or sort them out in a terminal.
          </Trans>
        </span>
      </div>

      {}
      {}
      <ul
        aria-labelledby="sync-blocking-heading"
        className="flex max-h-28 flex-col gap-1 overflow-y-auto overscroll-contain"
        data-testid="sync-blocking-list"
      >
        {paths.map((path) => (
          <li
            key={path}
            title={path}
            className="min-w-0 truncate font-mono text-2xs text-foreground"
          >
            {path}
          </li>
        ))}
      </ul>

      {}
      {failed && (
        <p role="alert" className="text-xs text-destructive" data-testid="sync-blocking-error">
          <Trans>That did not go through. Check the server logs and try again.</Trans>
        </p>
      )}

      <Button
        size="xs"
        disabled={busy}
        onClick={() => void run('commit')}
        data-testid="sync-blocking-commit"
      >
        {pending === 'commit' && <Spinner aria-hidden="true" data-icon="inline-start" />}
        <Trans>Commit and sync</Trans>
      </Button>

      {terminalAvailable() && (
        <Button
          variant="link-muted"
          size="xs"
          className="self-start p-0"
          disabled={busy}
          onClick={() => requestTerminalCommand('git-status')}
          data-testid="sync-blocking-terminal"
        >
          <Terminal data-icon="inline-start" />
          <Trans>Resolve in terminal</Trans>
        </Button>
      )}
    </div>
  );
}
