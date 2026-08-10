import { useLingui } from '@lingui/react/macro';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatShortcut, formatShortcutLabel } from '@/lib/keyboard-shortcuts';
import { emitLocalMenuAction } from '@/lib/local-menu-action-bus';

interface NavigationHistoryApi extends EventTarget {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

const CAN_GO_BACK = 1;
const CAN_GO_FORWARD = 2;
const UNKNOWN_NAVIGATION_AVAILABILITY = CAN_GO_BACK | CAN_GO_FORWARD;

function getNavigationHistoryApi(): NavigationHistoryApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { navigation?: NavigationHistoryApi }).navigation;
}

function getNavigationAvailability(): number {
  const navigation = getNavigationHistoryApi();
  if (!navigation) return UNKNOWN_NAVIGATION_AVAILABILITY;
  return (navigation.canGoBack ? CAN_GO_BACK : 0) | (navigation.canGoForward ? CAN_GO_FORWARD : 0);
}

function subscribeNavigationAvailability(onChange: () => void): () => void {
  const navigation = getNavigationHistoryApi();
  if (!navigation) return () => {};
  navigation.addEventListener('currententrychange', onChange);
  return () => navigation.removeEventListener('currententrychange', onChange);
}

export function NavigationHistoryControls() {
  const { t } = useLingui();
  const navigationAvailability = useSyncExternalStore(
    subscribeNavigationAvailability,
    getNavigationAvailability,
    () => UNKNOWN_NAVIGATION_AVAILABILITY,
  );
  const canGoBack = (navigationAvailability & CAN_GO_BACK) !== 0;
  const canGoForward = (navigationAvailability & CAN_GO_FORWARD) !== 0;
  const backShortcut = formatShortcut('navigate-back');
  const backShortcutLabel = formatShortcutLabel('navigate-back');
  const forwardShortcut = formatShortcut('navigate-forward');
  const forwardShortcutLabel = formatShortcutLabel('navigate-forward');

  return (
    <ButtonGroup
      aria-label={t`Navigation history`}
      className="shrink-0"
      data-testid="navigation-history-controls"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={t`Back`}
            className="[-webkit-app-region:no-drag]"
            disabled={!canGoBack}
            onClick={() => emitLocalMenuAction('navigate-back')}
            size="icon-sm"
            variant="ghost"
          >
            <ArrowLeft aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <span>{t`Back`}</span> <Kbd aria-label={backShortcutLabel}>{backShortcut}</Kbd>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={t`Forward`}
            className="[-webkit-app-region:no-drag]"
            disabled={!canGoForward}
            onClick={() => emitLocalMenuAction('navigate-forward')}
            size="icon-sm"
            variant="ghost"
          >
            <ArrowRight aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <span>{t`Forward`}</span> <Kbd aria-label={forwardShortcutLabel}>{forwardShortcut}</Kbd>
        </TooltipContent>
      </Tooltip>
    </ButtonGroup>
  );
}
