/**
 * The Slidev "plugin" panel — a peer of the lint plugins in the Plugins menu
 * (Settings → Plugins → Slidev), not a lint plugin: it owns no `contentRules`
 * slice and adds nothing to the Problems panel. Its enablement lives in a
 * user-scope config leaf (`slides.enabled`), the same posture as Themes.
 *
 * Beyond explaining the plugin, the panel answers the one question the rest of
 * the feature cannot: **did OpenKnowledge actually find Slidev?** Everywhere
 * else, an unresolved Slidev is silent by design — the toolbar action is simply
 * absent, which is indistinguishable from the plugin being broken. This panel
 * is the single place that state is visible, so it re-probes on mount and on
 * window focus: install Slidev in a terminal, click back into OpenKnowledge,
 * and the status flips without a restart.
 */

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
import { PluginSectionHeader } from './PluginSectionHeader';

/** The command shown, copied, AND run — read from the terminal-command registry
 *  rather than restated here. The panel displaying one command while the button
 *  runs another is the drift this single source exists to prevent, and it would
 *  be invisible until someone copied the text and got a different result. The
 *  registry is also where the "why both packages" rationale lives. */
const INSTALL_COMMAND = terminalCommandFor('install-slidev') ?? '';

const SLIDEV_INSTALL_DOCS = 'https://sli.dev/guide/install';

/** OpenKnowledge's own page for the plugin — how to enable it, the frontmatter
 *  flag, and what Slidev authoring looks like from here. Distinct from
 *  `SLIDEV_INSTALL_DOCS`, which is upstream Slidev's install matrix. */
const SLIDEV_DOCS = 'https://openknowledge.ai/docs/plugins/slidev';

type Availability =
  | { kind: 'checking' }
  | { kind: 'available'; source: 'global' | 'project-local' }
  | { kind: 'missing' }
  /** The probe itself failed — a broken bridge / rejected invoke — as opposed to
   *  a probe that succeeded and found no Slidev (`missing`). Slidev may well be
   *  present, so offering the install command would be the wrong remediation. */
  | { kind: 'check-failed' }
  /** Not the desktop app (or no bridge): the feature cannot run here at all, so
   *  "not installed" would be the wrong thing to say. */
  | { kind: 'unsupported' };

function useSlidevStatus(): Availability {
  const [availability, setAvailability] = useState<Availability>({ kind: 'checking' });

  // `probe` is defined inside the effect (not the component body) so it shares
  // the effect's `active` flag and keeps a single stable identity — the same
  // function reference registers the focus listener below and removes it on
  // cleanup, which a body-level callback (unmemoizable under the React Compiler)
  // could not guarantee.
  useEffect(() => {
    // Guards a late `status()` resolution from writing state into an unmounted
    // panel — the round-trip outlives a quick open-and-close of Settings. The
    // sibling probe in SlidesToolbarControls carries the same flag.
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
        // Trust boundary: an IPC round-trip to a separate process. A rejected
        // invoke means the probe could not run — reported as `check-failed`
        // (neutral copy), NOT `missing`: telling the user to install Slidev when
        // the bridge broke would send them after software that may be present.
        // Logged so a broken bridge stays distinguishable in diagnostics.
        .catch((err: unknown) => {
          console.warn('[slides] settings availability probe failed:', err);
          if (active) setAvailability({ kind: 'check-failed' });
        });
    };
    probe();
    // Re-probe when the user comes back to the window. The common first-run
    // path is: see "not installed" → install in a terminal → switch back. That
    // switch is the focus event, so the panel is correct by the time they look
    // at it.
    window.addEventListener('focus', probe);
    return () => {
      active = false;
      window.removeEventListener('focus', probe);
    };
  }, []);

  return availability;
}

/**
 * Whether this host can actually open a terminal tab and run something in it.
 *
 * The terminal dock is dark on Windows and Linux — node-pty ships macOS-only,
 * so `config.ptyAvailable` is false there. Without this gate, "Run in terminal"
 * would close Settings, fire the request, and produce no session at all: the
 * dock never creates a PTY, so the click reads as the app swallowing it. Same
 * rule EditorPane states for every terminal affordance — a control that cannot
 * launch must not render. The copy-command path stays on every platform.
 */
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
      {/* Amber + a dark-mode pair, matching the AI-tools rows — the settings
          panes carry status in the text colour, not in an icon. */}
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
              // Close Settings first: the dialog is hash-routed and its close is a
              // single `history.back()`, so leaving it open would put the terminal
              // behind a modal the user then has to dismiss to watch the install.
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
          // Names its destination for anyone listing links out of context, where
          // a bare "Other ways to install" says less.
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
      <PluginSectionHeader
        titleId="settings-plugin-slides-title"
        // A product name, not a translatable label — passed raw the way the
        // markdownlint panel passes its own.
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
      </PluginSectionHeader>
      {/* The status resolves asynchronously (mount probe + focus re-probe), so a
          polite live region announces the flip from "Checking" to found /
          missing / check-failed, matching the sibling settings sections. */}
      <div aria-live="polite">
        <StatusRow availability={availability} />
      </div>
    </section>
  );
}
