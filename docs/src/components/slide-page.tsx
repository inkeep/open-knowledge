import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';
import { DotTexture } from '@/components/dot-texture';
import { SiteFooter } from '@/components/footer';
import { OkWordmark } from '@/components/ok-wordmark';
import { cn } from '@/lib/utils';

/**
 * The shared "slide" page shell — the cream/dark branded chrome used by the
 * first-run continue flow (`/continue`): dot-texture background pair, a
 * home-linking wordmark header, a centered content column, and the site footer.
 * Mirrors the structure the `/d/[encoded]` share splash renders inline; the
 * splash can be migrated onto this shell so the chrome lives in one place.
 */
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
            {/* Link already names the control; hide the wordmark's own label to
                avoid a doubled "OpenKnowledge" announcement. */}
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

/** The slide eyebrow: a small mono, uppercase label above the headline. */
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

/** The slide headline — the large, light-weight page title. */
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

/** The slide lead paragraph — muted supporting copy beneath the headline. */
export function SlideLead({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-lg leading-relaxed text-slide-muted', className)} {...props} />;
}
