import { DotIcon, GitBranchIcon } from 'lucide-react';
import Link from 'next/link';
import { DotTexture } from '@/components/dot-texture';
import { SiteFooter } from '@/components/footer';
import { GitHubIcon } from '@/components/icons/github';
import { OkWordmark } from '@/components/ok-wordmark';
import { buildCloneCommand, SPLASH_INSTALL_COMMAND, type SplashView } from '@/lib/share-splash';
import { DOWNLOAD_ROUTE } from '@/lib/site';
import { SplashButtonLabel, splashPrimaryButton } from './splash-buttons';
import { SplashCliButton } from './splash-cli-button';
import { SplashCtaPanel } from './splash-cta-panel';

/** The decoded, well-formed share view (blob → doc, tree → folder). */
type OkSplashView = Extract<SplashView, { kind: 'ok' }>;

/**
 * The "ok" share splash: headline + repo/branch context + the OS-aware CTA
 * panel, in the shared page shell (chrome + footer).
 */
export function SplashShareView({ encoded, view }: { encoded: string; view: OkSplashView }) {
  return (
    <main className="relative flex min-h-screen flex-col overflow-hidden bg-slide-bg font-[family-name:var(--font-dm-sans)]">
      <SplashChrome />

      <section className="relative z-20 flex-1 px-6 pt-16 pb-16 md:pt-24 md:pb-20">
        <div className="container mx-auto">
          <p className="mb-6 font-mono text-base font-medium uppercase tracking-wide text-primary">
            {view.target === 'folder' ? 'Shared folder' : 'Shared'}
          </p>

          <h1
            className="text-3xl font-light tracking-tight text-slide-text sm:text-4xl lg:text-[3.25rem] lg:leading-[1.1]"
            data-testid="splash-filename"
          >
            <a
              href={view.githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="relative inline-block break-words rounded-sm outline-none transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-slide-accent"
            >
              {view.filename}
              <svg
                className="absolute -bottom-2 left-0 h-3 w-full"
                viewBox="0 0 286 14"
                fill="none"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <path
                  d="M3 11C45 3.5 91.5 1.5 143 5.5C194.5 9.5 241 7 283 3"
                  stroke="var(--slide-accent)"
                  strokeWidth="4"
                  strokeLinecap="round"
                />
              </svg>
            </a>
          </h1>
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 mt-8">
            <a
              href={view.githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex w-fit items-center gap-1.5 text-lg leading-relaxed text-slide-muted underline decoration-slide-muted/30 underline-offset-4 outline-none transition-colors hover:text-slide-text hover:decoration-slide-text/50 focus-visible:rounded focus-visible:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slide-accent"
              data-testid="splash-repo-path"
            >
              <GitHubIcon className="size-4" aria-hidden="true" />
              {view.repoPath}
            </a>

            {view.isDefaultBranch ? null : (
              <p
                className="inline-flex items-center gap-1.5 text-slide-muted"
                data-testid="splash-branch-indicator"
              >
                <DotIcon aria-hidden="true" className="hidden sm:block" />
                <GitBranchIcon className="size-4" aria-hidden="true" />
                <span className="font-medium">{view.branch}</span>
              </p>
            )}
          </div>
          <SplashCtaPanel
            downloadUrl={`/d/${encoded}/download`}
            customSchemeUrl={view.customSchemeUrl}
            githubUrl={view.githubUrl}
            installCommand={SPLASH_INSTALL_COMMAND}
            cloneCommand={buildCloneCommand({
              owner: view.owner,
              repo: view.repo,
              branch: view.branch,
            })}
          />
        </div>
      </section>

      <div className="relative z-10">
        <SiteFooter />
      </div>
    </main>
  );
}

// Shared page chrome: the dot-pattern background pair + the home-linking
// wordmark header. Both SplashShareView and SplashFallback render this once so
// the texture sizing/opacity lives in a single place.
function SplashChrome() {
  return (
    <>
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
    </>
  );
}

/** Rendered for the `invalid` and `unsupported-version` decode outcomes. */
export function SplashFallback({ heading }: { heading: string }) {
  return (
    <main className="relative flex min-h-screen flex-col overflow-hidden bg-slide-bg font-[family-name:var(--font-dm-sans)]">
      <SplashChrome />

      <section className="relative z-20 flex-1 px-6 pt-16 pb-16 md:pt-24 md:pb-20">
        <div className="container mx-auto">
          <h1 className="text-3xl font-light tracking-tight text-slide-text sm:text-4xl">
            {heading}
          </h1>

          <div className="mt-10 flex flex-wrap items-center gap-4">
            <a href={DOWNLOAD_ROUTE} className={splashPrimaryButton}>
              <SplashButtonLabel direction="down">DOWNLOAD FOR MAC</SplashButtonLabel>
            </a>
            <SplashCliButton installCommand={SPLASH_INSTALL_COMMAND} />
          </div>
        </div>
      </section>

      <div className="relative z-10">
        <SiteFooter />
      </div>
    </main>
  );
}
