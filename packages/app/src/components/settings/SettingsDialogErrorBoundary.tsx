
import { Trans, useLingui } from '@lingui/react/macro';
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary';
import { Button } from '@/components/ui/button';

function SettingsBodyErrorFallback({ error }: FallbackProps) {
  const { t } = useLingui();
  const message =
    error instanceof Error && /dynamically imported module|Failed to fetch/i.test(error.message)
      ? t`A newer version may have been deployed since this tab opened.`
      : t`Something went wrong loading the settings panel.`;
  return (
    <div
      role="alert"
      aria-labelledby="settings-body-error-title"
      data-slot="settings-body-error-boundary"
      className="flex h-full flex-col items-center justify-center gap-5 p-8 text-center"
    >
      <div className="flex flex-col items-center gap-1">
        <h3
          id="settings-body-error-title"
          className="font-heading text-base leading-none font-medium"
        >
          <Trans>Settings failed to load</Trans>
        </h3>
        <p className="max-w-xs text-sm text-muted-foreground">{message}</p>
      </div>
      <Button variant="default" onClick={() => window.location.reload()}>
        <Trans>Reload</Trans>
      </Button>
    </div>
  );
}

export function SettingsDialogErrorBoundary({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBoundary
      fallbackRender={(props) => <SettingsBodyErrorFallback {...props} />}
      onError={(error, info) => {
        console.error(
          '[SettingsDialogErrorBoundary] rendered fallback for Settings body',
          error,
          info.componentStack,
        );
      }}
    >
      {children}
    </ErrorBoundary>
  );
}
