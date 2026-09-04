'use client';

import { ArrowDown, ChevronDown } from 'lucide-react';
import type { Ref } from 'react';
import { type DetectedOs, downloadLabelForOs } from '@/lib/download-targets';
import { cn } from '@/lib/utils';
import { SplashCliPopover } from './splash-cli-popover';

interface SplashDownloadSplitButtonProps {
  downloadUrl: string;
  platformBaseUrl: string;
  detectedOs: DetectedOs;
  githubUrl?: string;
  installCommand: string;
  cloneCommand?: string;
  downloadRef?: Ref<HTMLAnchorElement>;
  moreOptionsLabel?: string;
  variant?: 'primary' | 'secondary';
}

const VARIANT = {
  secondary: {
    rest: 'text-azure-blue',
    segment: 'border-azure-blue',
    divider: 'border-l-azure-blue/40',
    fill: cn(
      'group-hover:bg-azure-blue group-hover:text-white',
      'group-has-[[data-state=open]]:bg-azure-blue group-has-[[data-state=open]]:text-white',
    ),
  },
  primary: {
    rest: 'text-white',
    segment: 'border-azure-blue bg-azure-blue',
    divider: 'border-l-white/25',
    fill: cn(
      'group-hover:bg-blue-dark group-hover:border-blue-dark',
      'dark:group-hover:bg-primary dark:group-hover:border-primary',
      'group-has-[[data-state=open]]:bg-blue-dark group-has-[[data-state=open]]:border-blue-dark',
      'dark:group-has-[[data-state=open]]:bg-primary dark:group-has-[[data-state=open]]:border-primary',
    ),
  },
} as const;

export function SplashDownloadSplitButton({
  downloadUrl,
  platformBaseUrl,
  detectedOs,
  githubUrl,
  installCommand,
  cloneCommand,
  downloadRef,
  moreOptionsLabel = 'More ways to open this share',
  variant = 'secondary',
}: SplashDownloadSplitButtonProps) {
  const chrome = VARIANT[variant];

  return (
    // biome-ignore lint/a11y/useSemanticElements: a split button groups two controls, not form fields — role="group" is the correct ARIA pattern (fieldset is wrong here).
    <div
      role="group"
      aria-label="Download or open with other options"
      className={cn(
        'group inline-flex items-stretch font-mono text-sm font-medium uppercase leading-[115%] tracking-[-0.64px] sm:text-base',
        chrome.rest,
      )}
    >
      <a
        ref={downloadRef}
        href={downloadUrl}
        data-testid="splash-download-cta"
        className={cn(
          'inline-flex touch-manipulation items-center gap-2 rounded-l-full border border-r-0 px-5 py-[13px]',
          'transition-colors duration-200 outline-none',
          chrome.segment,
          chrome.fill,
          'focus-visible:relative focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slide-accent',
        )}
      >
        <ArrowDown aria-hidden="true" className="size-4 shrink-0" />
        {}
        {detectedOs === 'unknown' ? 'Download the app' : downloadLabelForOs(detectedOs)}
      </a>

      <SplashCliPopover
        installCommand={installCommand}
        cloneCommand={cloneCommand}
        githubUrl={githubUrl}
        platformBaseUrl={platformBaseUrl}
        detectedOs={detectedOs}
        trigger={(open) => (
          <button
            type="button"
            aria-label={moreOptionsLabel}
            data-testid="splash-more-options"
            className={cn(
              'flex touch-manipulation items-center rounded-r-full border px-3 py-[13px]',
              'transition-colors duration-200 outline-none',
              chrome.segment,
              chrome.divider,
              chrome.fill,
              'focus-visible:relative focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slide-accent',
            )}
          >
            <ChevronDown
              aria-hidden="true"
              className={cn(
                'size-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none',
                open && 'rotate-180',
              )}
            />
          </button>
        )}
      />
    </div>
  );
}
