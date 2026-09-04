import { ArrowDown, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export const splashPrimaryButton = cn(
  'inline-flex items-center gap-2 rounded-full h-12 px-[18px] py-[14px] pr-2.5',
  'bg-azure-blue text-white text-sm sm:text-base font-medium uppercase leading-[115%] tracking-[-0.64px]',
  'transition duration-200 ease-in-out outline-none cursor-pointer',
  'hover:bg-blue-dark dark:hover:bg-primary hover:shadow-lg hover:-translate-y-0.5 active:scale-[0.98] motion-reduce:transform-none motion-reduce:transition-none',
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
