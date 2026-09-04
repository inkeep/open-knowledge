import { Trans } from '@lingui/react/macro';
import { Spinner } from '@/components/ui/spinner';

export function UninstallProgressScreen() {
  return (
    <main className="grid h-dvh place-items-center bg-background text-foreground">
      <div role="status" className="max-w-vw px-7 py-7 text-center">
        <Spinner aria-hidden="true" className="mx-auto mb-4 size-8 text-primary" />
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
