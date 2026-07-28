import { Trans } from '@lingui/react/macro';
import { Loader2 } from 'lucide-react';

/**
 * Shown while the bundled CLI removes the OpenKnowledge footprint.
 *
 * Purely cosmetic and deliberately inert: there is nothing to answer and no way
 * out, because main prevents this window from closing until the cleanup it is
 * covering has finished.
 */
export function UninstallProgressScreen() {
  return (
    <main className="grid h-dvh place-items-center bg-background text-foreground">
      <div role="status" className="max-w-vw px-7 py-7 text-center">
        <Loader2
          aria-hidden="true"
          className="mx-auto mb-4 size-8 animate-spin text-primary motion-reduce:animate-none"
        />
        <h1 className="mb-2 font-medium text-base leading-none">
          {/* biome-ignore lint/plugin/microcopy-ellipsis: the uninstall migration to React is a
              pure render-swap — this heading is carried over verbatim from the screen it replaces,
              and a copy-parity gate compares the two. Reword both surfaces together or neither. */}
          <Trans>Removing OpenKnowledge files…</Trans>
        </h1>
        <p className="text-muted-foreground text-sm leading-relaxed">
          <Trans>This may take a moment. Your markdown content is kept.</Trans>
        </p>
      </div>
    </main>
  );
}
