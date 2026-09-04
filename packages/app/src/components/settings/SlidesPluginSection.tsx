import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, TerminalIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CopyButton } from '@/components/CopyButton';
import {
  requestTerminalCommand,
  terminalCommandFor,
} from '@/components/handoff/terminal-command-events';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { dispatchExternalLinkClick } from '@/lib/external-link';
import { isSettingsHashOpen } from '@/lib/use-settings-route';
import { SettingsSectionHeader } from './SettingsSectionHeader';

const INSTALL_COMMAND = terminalCommandFor('install-slidev') ?? '';

const SLIDEV_INSTALL_DOCS = 'https://sli.dev/guide/install';

const SLIDEV_DOCS = 'https://openknowledge.ai/docs/plugins/slidev';

type Availability =
  | { kind: 'checking' }
  | { kind: 'available'; source: 'global' | 'project-local' }
  | { kind: 'missing' }
  | { kind: 'check-failed' }
  | { kind: 'unsupported' };

function useSlidevStatus(): Availability {
  const [availability, setAvailability] = useState<Availability>({ kind: 'checking' });

  useEffect(() => {
    let active = true;
    const probe = () => {
      const slides = window.okDesktop?.slides;
      if (slides == null) {
        setAvailability({ kind: 'unsupported' });
        return;
      }
      slides
        .status()
        .then((result) => {
          if (!active) return;
          setAvailability(
            result.available ? { kind: 'available', source: result.source } : { kind: 'missing' },
          );
        })
        .catch((err: unknown) => {
          console.warn('[slides] settings availability probe failed:', err);
          if (active) setAvailability({ kind: 'check-failed' });
        });
    };
    probe();
    window.addEventListener('focus', probe);
    return () => {
      active = false;
      window.removeEventListener('focus', probe);
    };
  }, []);

  return availability;
}

function canRunInTerminal(): boolean {
  const bridge = window.okDesktop;
  return bridge?.terminal != null && bridge.config?.ptyAvailable === true;
}

function StatusRow({ availability }: { availability: Availability }) {
  const { t } = useLingui();

  if (availability.kind === 'checking') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="slides-status-checking">
        <Trans>Checking for Slidev</Trans>
      </p>
    );
  }

  if (availability.kind === 'check-failed') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="slides-status-check-failed">
        <Trans>
          We couldn't check whether Slidev is installed. Return to this window to retry.
        </Trans>
      </p>
    );
  }

  if (availability.kind === 'unsupported') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="slides-status-unsupported">
        <Trans>Slidev decks open in the OpenKnowledge desktop app only.</Trans>
      </p>
    );
  }

  if (availability.kind === 'available') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="slides-status-available">
        {availability.source === 'project-local' ? (
          <Trans>Slidev found in this project. Decks will use the project's version.</Trans>
        ) : (
          <Trans>Slidev found on your system.</Trans>
        )}
      </p>
    );
  }

  return (
    <div className="space-y-3" data-testid="slides-status-missing">
      {}
      <p className="text-sm text-amber-600 dark:text-amber-400">
        <Trans>
          Slidev isn't installed, so the Slidev action stays hidden. Install it, then return to this
          window.
        </Trans>
      </p>
      <InputGroup>
        <InputGroupInput
          readOnly
          value={INSTALL_COMMAND}
          aria-label={t`Slidev install command`}
          className="font-mono text-xs"
          data-testid="slides-install-command"
          onFocus={(e) => e.currentTarget.select()}
        />
        <InputGroupAddon align="inline-end">
          <CopyButton copyContent={INSTALL_COMMAND} />
        </InputGroupAddon>
      </InputGroup>
      <div className="flex items-center gap-3">
        {canRunInTerminal() ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="slides-run-install"
            onClick={() => {
              if (typeof window !== 'undefined' && isSettingsHashOpen(window.location.hash)) {
                window.history.back();
              }
              requestTerminalCommand('install-slidev');
            }}
          >
            <TerminalIcon aria-hidden className="size-3.5" />
            <Trans>Run in terminal</Trans>
          </Button>
        ) : null}
        <a
          href={SLIDEV_INSTALL_DOCS}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => dispatchExternalLinkClick(e, SLIDEV_INSTALL_DOCS)}
          onAuxClick={(e) => dispatchExternalLinkClick(e, SLIDEV_INSTALL_DOCS)}
          aria-label={t`Other ways to install Slidev`}
          className="inline-flex items-center gap-0.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          data-testid="slides-install-docs-link"
        >
          <Trans>Other ways to install</Trans>
          <ArrowUpRight aria-hidden className="size-3" />
        </a>
      </div>
    </div>
  );
}

export function SlidesPluginSection() {
  const availability = useSlidevStatus();

  return (
    <section
      aria-labelledby="settings-plugin-slides-title"
      className="space-y-4"
      data-testid="settings-plugin-slides"
    >
      <SettingsSectionHeader
        titleId="settings-plugin-slides-title"
        title="Slidev"
        scope="user"
        beta
        docUrl={SLIDEV_DOCS}
      >
        <Trans>
          Present a document as a slide deck in its own window. Add{' '}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">slides: true</code> to a
          document's frontmatter, then open it with the Slidev action. Rendering is handled by the
          Slidev CLI, which OpenKnowledge does not bundle.
        </Trans>
      </SettingsSectionHeader>
      {}
      <div aria-live="polite">
        <StatusRow availability={availability} />
      </div>
    </section>
  );
}
