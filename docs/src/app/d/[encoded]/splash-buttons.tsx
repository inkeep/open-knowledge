import { ArrowDown, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';

// Mirror MarketingButton's `primary` / `outline` sizing, colors, and hover/active
// states (size md) so splash CTAs match the homepage's button chrome. Typography is
// deliberately adapted to the splash page's mono/uppercase convention: both variants
// share the primary variant's text classes (font-medium uppercase tracking-[-0.64px])
// and use rounded-full for uniform pill shapes — so splashOutlineButton does NOT track
// MarketingButton's outline typography (rounded / font-normal / no uppercase). When
// syncing, sync the chrome (dimensions, colors, hover/active), not the type.
// Kept as standalone class strings rather than reusing MarketingButton because splash
// CTAs fire custom-scheme URLs and a download route handler via raw <a> (and two need
// refs for focus management) — paths MarketingButton's next/link rendering can't take.
export const splashPrimaryButton = cn(
  'inline-flex items-center gap-2 rounded-full h-12 px-[18px] py-[14px] pr-2.5',
  'bg-azure-blue text-white text-sm sm:text-base font-medium uppercase leading-[115%] tracking-[-0.64px]',
  'transition duration-200 ease-in-out outline-none cursor-pointer',
  'hover:bg-blue-dark dark:hover:bg-primary hover:shadow-lg hover:-translate-y-0.5 active:scale-[0.98] motion-reduce:transform-none motion-reduce:transition-none',
  'focus-visible:ring-2 focus-visible:ring-slide-accent focus-visible:ring-offset-2',
);

export const splashOutlineButton = cn(
  'inline-flex items-center gap-2 rounded-full font-mono border border-azure-blue px-5 py-[13px]',
  'bg-transparent text-azure-blue text-sm sm:text-base font-medium uppercase leading-[115%] tracking-[-0.64px]',
  'transition duration-200 ease-in-out outline-none cursor-pointer',
  'hover:bg-azure-blue hover:text-white',
  'focus-visible:ring-2 focus-visible:ring-slide-accent focus-visible:ring-offset-2',
);

// Filled counterpart to splashOutlineButton — same pill geometry so a solid
// primary and an outline secondary pair cleanly in one row. Distinct from
// splashPrimaryButton, whose taller h-12 + pr-2.5 chrome is tuned for the
// circle-arrow SplashButtonLabel; this one suits a plain text + chevron label.
export const splashSolidButton = cn(
  'inline-flex items-center gap-2 rounded-full font-mono border border-azure-blue px-5 py-[13px]',
  'bg-azure-blue text-white text-sm sm:text-base font-medium uppercase leading-[115%] tracking-[-0.64px]',
  'transition duration-200 ease-in-out outline-none cursor-pointer',
  'hover:bg-blue-dark hover:border-blue-dark dark:hover:bg-primary dark:hover:border-primary',
  'focus-visible:ring-2 focus-visible:ring-slide-accent focus-visible:ring-offset-2',
);

export function SplashButtonLabel({
  children,
  direction = 'right',
  iconStyle = 'circle',
}: {
  children: React.ReactNode;
  direction?: 'right' | 'down';
  iconStyle?: 'circle' | 'plain';
}) {
  const Arrow = direction === 'down' ? ArrowDown : ArrowRight;
  return (
    <>
      <span className="relative z-[1] whitespace-nowrap font-mono">{children}</span>
      {iconStyle === 'circle' ? (
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white"
        >
          <Arrow className="size-4 text-night-sky" />
        </span>
      ) : (
        <Arrow aria-hidden="true" className="size-5 shrink-0" />
      )}
    </>
  );
}
