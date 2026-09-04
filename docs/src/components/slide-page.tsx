import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';
import { DotTexture } from '@/components/dot-texture';
import { SiteFooter } from '@/components/footer';
import { OkWordmark } from '@/components/ok-wordmark';
import { cn } from '@/lib/utils';

export function SlidePageShell({ children }: { children: ReactNode }) {
  return (
    <main className="relative flex min-h-screen flex-col overflow-hidden bg-slide-bg font-[family-name:var(--font-dm-sans)]">
      <DotTexture
        variant="right"
        priority
        className="top-0 right-0 w-60 dark:opacity-30 sm:w-[680px]"
      />
      <DotTexture
        variant="left"
        className="bottom-0 left-0 w-40 dark:opacity-30 sm:w-72 lg:w-[515px]"
      />
      <header className="relative z-10 px-6">
        <div className="container mx-auto flex pt-8 md:pt-10">
          <Link href="/" aria-label="OpenKnowledge home" className="inline-flex items-center">
            {}
            <OkWordmark aria-hidden="true" className="h-8 w-auto text-slide-text" />
          </Link>
        </div>
      </header>

      <section className="relative z-20 flex-1 px-6 pt-16 pb-16 md:pt-24 md:pb-20">
        <div className="container mx-auto">{children}</div>
      </section>

      <div className="relative z-10">
        <SiteFooter />
      </div>
    </main>
  );
}

export function SlideEyebrow({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      className={cn(
        'mb-6 font-mono text-base font-medium uppercase tracking-wide text-primary',
        className,
      )}
      {...props}
    />
  );
}

export function SlideHeading({ className, ...props }: ComponentProps<'h1'>) {
  return (
    <h1
      className={cn(
        'text-balance text-3xl font-light tracking-tight text-slide-text sm:text-4xl lg:text-[3.25rem] lg:leading-[1.1]',
        className,
      )}
      {...props}
    />
  );
}

export function SlideLead({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-lg leading-relaxed text-slide-muted', className)} {...props} />;
}
