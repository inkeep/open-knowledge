/**
 * The resolution panel for a pre-merge overlap — the one sync pause the user
 * can clear from inside the app.
 *
 * The engine pauses when tracked files are dirty locally AND changed on the
 * remote, because `git merge` would refuse. Before this panel that state
 * rendered as a sentence naming three of the files, which told the user what
 * happened and left them to go find a terminal. Here the same state carries the
 * full list, the non-destructive action that ends it, and a way into the app's
 * own terminal for anyone who wants to drive it by hand.
 *
 * Deliberately NO Discard button. Reverting uncommitted work is unrecoverable —
 * git keeps no reflog for it — and the spec's ordering constraint is that the
 * destructive verb ships only once a recoverable snapshot exists behind it.
 * Until then a terminal is the honest escape: it makes the user type the
 * destructive command themselves, in a place where they can inspect first.
 *
 * Commit acts on the server's blocking set, never on a path this component
 * sends — see `resolveBlockingChanges`.
 */

import { Trans } from '@lingui/react/macro';
import { Terminal } from 'lucide-react';
import { useState } from 'react';
import { requestTerminalCommand } from '@/components/handoff/terminal-command-events';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { resolveBlockingChanges } from '@/lib/resolve-blocking';

/**
 * Whether the docked terminal exists to be opened. Desktop-only: the PTY lives
 * behind the Electron bridge, so in a browser the button would open nothing.
 */
function terminalAvailable(): boolean {
  return typeof window !== 'undefined' && window.okDesktop != null;
}

export function SyncBlockingChanges({ paths }: { paths: readonly string[] }) {
  const [pending, setPending] = useState<'commit' | null>(null);
  const [failed, setFailed] = useState(false);

  if (paths.length === 0) return null;

  // Clears `pending` on both paths rather than in a `finally`: React Compiler
  // cannot lower a try-statement with a finalizer, and fails the production
  // build on it (it type-checks and passes tests either way).
  async function run(action: 'commit') {
    setPending(action);
    setFailed(false);
    try {
      await resolveBlockingChanges(action);
      setPending(null);
    } catch {
      // Includes the 409 for "nothing is blocking any more". Both cases end the
      // same way for the user: the panel stays until the next status update
      // says otherwise, with a line saying the action did not take.
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

      {/* Capped height rather than a truncated list: the server already caps the
          set, and a scroll keeps a long one from pushing the actions out of
          reach in a popover the user cannot resize. */}
      {/* tabIndex: Chromium (so Electron) does not make scroll containers
          keyboard-focusable on its own, and every child here is plain text — so
          without it a keyboard user cannot read past roughly the seventh path
          in the very list they are being asked to act on. `overscroll-contain`
          keeps reaching the end from scroll-chaining to the surface behind. */}
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

      {/* role="alert": this appears after an explicit click inside a popover with
          no other announcement, so without a live region a screen-reader user
          gets silence on a failed action. */}
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
