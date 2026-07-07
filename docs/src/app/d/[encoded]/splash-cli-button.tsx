'use client';

import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { splashOutlineButton, splashSolidButton } from './splash-buttons';
import { SplashCliPopover } from './splash-cli-popover';

/**
 * "Open with CLI" button that opens the shared CLI popover. Used by the Linux
 * layout as the `primary` action (CLI is the receive path — install + clone)
 * and the invalid-share fallback as the `outline` secondary (install-only, no
 * repo to clone). Client component so the server fallback can render it with
 * plain string props.
 */
export function SplashCliButton({
  installCommand,
  cloneCommand,
  variant = 'outline',
}: {
  installCommand: string;
  cloneCommand?: string;
  variant?: 'primary' | 'outline';
}) {
  return (
    <SplashCliPopover
      installCommand={installCommand}
      cloneCommand={cloneCommand}
      align="start"
      trigger={(open) => (
        <button
          type="button"
          data-testid="splash-cli-trigger"
          className={variant === 'primary' ? splashSolidButton : splashOutlineButton}
        >
          <span className="relative z-[1] whitespace-nowrap font-mono">Open with CLI</span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'size-5 shrink-0 transition-transform duration-200 motion-reduce:transition-none',
              open && 'rotate-180',
            )}
          />
        </button>
      )}
    />
  );
}
