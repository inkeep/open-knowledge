
import { Trans } from '@lingui/react/macro';
import { Settings } from 'lucide-react';
import { type FC, useEffect, useRef } from 'react';
import { SettingsDialogBodyLazy } from '@/components/settings/SettingsDialogBodyLazy';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SETTINGS_OPEN_HASH } from '@/lib/use-settings-route';

const PREFETCH_INTENT_DELAY_MS = 50;

export const SettingsButton: FC = () => {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const schedulePreload = () => {
    if (timerRef.current !== null) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      SettingsDialogBodyLazy.preload();
    }, PREFETCH_INTENT_DELAY_MS);
  };

  const cancelPreload = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    },
    [],
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 hover:bg-accent text-muted-foreground"
          data-testid="header-settings-button"
          onMouseEnter={schedulePreload}
          onMouseLeave={cancelPreload}
          onFocus={schedulePreload}
          onBlur={cancelPreload}
          onClick={() => {
            cancelPreload();
            if (window.location.hash !== SETTINGS_OPEN_HASH) {
              window.location.hash = SETTINGS_OPEN_HASH;
            }
          }}
        >
          <Settings className="size-4" />
          <span className="sr-only">
            <Trans>Settings</Trans>
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <Trans>Settings</Trans>
      </TooltipContent>
    </Tooltip>
  );
};
