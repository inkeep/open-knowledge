import { useLingui } from '@lingui/react/macro';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { PANE_ICON, PANE_LABEL } from '@/components/pane-icons';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTerminalConsentState } from '@/hooks/use-terminal-enabled';
import {
  formatShortcut,
  formatShortcutLabel,
  type KeyboardShortcutId,
} from '@/lib/keyboard-shortcuts';
import { type PaneId, paneVisibilityStore } from '@/lib/pane-visibility-store';
import { cn } from '@/lib/utils';

type HeaderPaneButtonState = {
  readonly pane: PaneId;
  readonly pressed: boolean;
};

const PANE_ORDER = ['editor', 'agents', 'terminal'] as const satisfies readonly PaneId[];

type _PaneOrderDrift = Exclude<PaneId, (typeof PANE_ORDER)[number]>;
const _paneOrderDriftGuard: [_PaneOrderDrift] extends [never]
  ? true
  : ['PANE_ORDER is missing a PaneId', _PaneOrderDrift] = true;
void _paneOrderDriftGuard;

const PANE_SHORTCUT = {
  editor: null,
  agents: 'toggle-agent-panel',
  terminal: 'toggle-terminal-panel',
} as const satisfies Record<PaneId, KeyboardShortcutId | null>;

const HIGH_CONTRAST_OUTLINE_CLASSES =
  'outline-current -outline-offset-2 forced-colors:outline-solid forced-colors:outline-2 contrast-more:outline-solid contrast-more:outline-2';

const PRESSED_CLASSES = cn(
  'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary',
  HIGH_CONTRAST_OUTLINE_CLASSES,
);

const SWITCHER_TRACK_CLASSES = '-m-0.5 rounded-[10px] bg-foreground/5 p-0.5';

const SWITCHER_SHOWN_CLASSES = cn(
  'bg-background text-foreground shadow-sm hover:bg-background hover:text-foreground dark:bg-foreground/15',
  HIGH_CONTRAST_OUTLINE_CLASSES,
);

function useTerminalTurnedOff(): boolean {
  const { enabled, synced } = useTerminalConsentState();
  const [offWhenLastSynced, setOffWhenLastSynced] = useState(false);
  useEffect(() => {
    if (synced) setOffWhenLastSynced(enabled === false);
  }, [enabled, synced]);
  return synced ? enabled === false : offWhenLastSynced;
}

function useHeaderPaneButtonStates(): readonly HeaderPaneButtonState[] {
  const snapshot = useSyncExternalStore(
    paneVisibilityStore.subscribe,
    paneVisibilityStore.getSnapshot,
    paneVisibilityStore.getSnapshot,
  );
  const terminalTurnedOff = useTerminalTurnedOff();
  return PANE_ORDER.flatMap((pane) => {
    const visibility = snapshot[pane];
    if (visibility === null) return [];
    if (pane === 'terminal' && terminalTurnedOff) return [];
    return [{ pane, pressed: visibility.onScreen }];
  });
}

export function useHeaderPaneButtonSet(): readonly PaneId[] {
  return useHeaderPaneButtonStates().map(({ pane }) => pane);
}

function useOnePaneAtATime(): boolean {
  return useSyncExternalStore(
    paneVisibilityStore.subscribe,
    paneVisibilityStore.isExclusive,
    paneVisibilityStore.isExclusive,
  );
}

function pressedLook(pressed: boolean, switcher: boolean): string | false {
  if (switcher) return pressed && SWITCHER_SHOWN_CLASSES;
  return pressed && PRESSED_CLASSES;
}

function HeaderPaneButton({
  pane,
  pressed,
  switcher,
}: HeaderPaneButtonState & { readonly switcher: boolean }) {
  const { t } = useLingui();
  const name = t(PANE_LABEL[pane]);
  const Icon = PANE_ICON[pane];
  const shortcutId = PANE_SHORTCUT[pane];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={name}
          aria-pressed={pressed}
          data-testid={`header-pane-button-${pane}`}
          data-header-pane-button={pane}
          onClick={(event) => {
            const button = event.currentTarget;
            if (pressed && paneVisibilityStore.isExclusive()) return;
            paneVisibilityStore.request(pane, !pressed, 'user');
            if (pressed) queueMicrotask(() => button.focus());
          }}
          className={cn('text-muted-foreground', pressedLook(pressed, switcher))}
        >
          <Icon aria-hidden="true" className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <span>{name}</span>
        {shortcutId === null ? null : (
          <>
            {' '}
            <Kbd aria-label={formatShortcutLabel(shortcutId)}>{formatShortcut(shortcutId)}</Kbd>
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

export function HeaderPaneButtons() {
  const { t } = useLingui();
  const buttons = useHeaderPaneButtonStates();
  const switcher = useOnePaneAtATime();
  if (buttons.length === 0) return null;

  return (
    <div className="flex shrink-0 items-center gap-1" data-testid="header-pane-buttons">
      <Separator
        orientation="vertical"
        data-testid="header-pane-divider"
        className="mx-1 h-4 data-vertical:self-center forced-colors:border-l"
      />
      {/* biome-ignore lint/a11y/useSemanticElements: a cluster of pane toggles is not a form-control set; <fieldset> would impose form chrome, and ButtonGroup squares the pressed tint. */}
      <div
        role="group"
        aria-label={t`Panels`}
        data-pane-switcher={switcher ? '' : undefined}
        className={cn('flex items-center gap-0.5', switcher && SWITCHER_TRACK_CLASSES)}
      >
        {buttons.map(({ pane, pressed }) => (
          <HeaderPaneButton key={pane} pane={pane} pressed={pressed} switcher={switcher} />
        ))}
      </div>
    </div>
  );
}
