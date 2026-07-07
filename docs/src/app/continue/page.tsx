import { cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { SplashButtonLabel, splashPrimaryButton } from '@/app/d/[encoded]/splash-buttons';
import { SlideEyebrow, SlideHeading, SlideLead, SlidePageShell } from '@/components/slide-page';
import {
  decideContinue,
  NONCE_PARAM,
  PENDING_SHARE_COOKIE,
  PORT_PARAM,
} from '@/lib/deferred-share';
import { DOWNLOAD_ROUTE } from '@/lib/site';

export const dynamic = 'force-dynamic';

interface ContinuePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * `/continue` — redeem-or-welcome. OpenKnowledge opens this on its true first
 * launch with `port`/`nonce` for the loopback handshake. When a pairing cookie
 * is present and the params are well-formed, redirect the pending share token
 * to the desktop's localhost listener (cookie retained — `/continue/done`
 * clears it after a confirmed redemption). Otherwise this is the
 * welcome/getting-started page every first-run visitor lands on.
 *
 * A server component can read cookies and `redirect()`, but cannot delete
 * cookies — the malformed-cookie cleanup the decision allows for is deferred to
 * the harmless 7-day expiry rather than handled here.
 */
export default async function ContinuePage({ searchParams }: ContinuePageProps) {
  const params = await searchParams;
  const cookieStore = await cookies();

  const decision = decideContinue({
    cookieToken: cookieStore.get(PENDING_SHARE_COOKIE)?.value ?? null,
    port: firstParam(params[PORT_PARAM]),
    nonce: firstParam(params[NONCE_PARAM]),
  });

  if (decision.kind === 'redeem') {
    redirect(decision.location);
  }

  return (
    <SlidePageShell>
      <div className="max-w-3xl">
        <SlideEyebrow>Welcome to OpenKnowledge</SlideEyebrow>

        <SlideHeading>You&rsquo;re all set.</SlideHeading>

        <SlideLead className="mt-8">
          OpenKnowledge is a local-first, markdown-native knowledge base where you and your AI
          agents co-create. Open the app to create your first project, or connect an existing GitHub
          repository.
        </SlideLead>

        <div className="mt-10 flex flex-wrap items-center gap-4">
          <Link href="/docs" data-testid="continue-getting-started" className={splashPrimaryButton}>
            <SplashButtonLabel direction="right">Read the getting-started guide</SplashButtonLabel>
          </Link>
        </div>
      </div>

      <div
        className="mt-12 border-t border-slide-text/10 pt-8"
        data-testid="continue-share-recovery"
      >
        <div className="max-w-3xl">
          <p className="text-sm font-medium text-slide-text">Were you sent a share link?</p>
          <p className="mt-2 text-sm leading-relaxed text-slide-muted">
            Click the link again and choose{' '}
            <span className="font-medium">Open in OpenKnowledge</span> to jump straight to it.
            <br />
            Don&rsquo;t have the app yet?{' '}
            <a
              href={DOWNLOAD_ROUTE}
              className="font-medium text-slide-text underline underline-offset-4 transition-colors hover:text-primary"
            >
              Download it for macOS
            </a>
            .
          </p>
        </div>
      </div>
    </SlidePageShell>
  );
}
