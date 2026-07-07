/**
 * SubscribeCard — the combined release-notes + "Stay in the loop" card shown in
 * the sidebar footer after an app update, when the subscribe prompt is still
 * eligible (see `subscribe-card-store`). It is NOT standalone: `UpdateNotices`
 * renders it in place of the plain what's-new notice when the active notice is
 * flagged `combinedSubscribe`. When the prompt isn't eligible (subscribed /
 * dismissed / 3-version budget spent), the plain what's-new notice shows
 * instead, unchanged.
 *
 * Reuses the shared `SubscribeForm` (email capture + success view) plus a
 * "Follow us on" social row, and adds an "Updated to Version X · Release notes"
 * footer row.
 *
 * Lifecycle:
 *   - No auto-dismiss while the subscribe prompt is pending — the card stays
 *     until the user acts. (It cannot re-nag on reopen: the store recorded the
 *     version and main was told the what's-new is seen at creation time.)
 *   - Dismiss (the form's ✕) closes the whole card AND stops the prompt for good
 *     (`dismiss()`), so future updates show just the plain notice.
 *   - On a confirmed subscribe, the form shows "You're subscribed!" in place, the
 *     social row collapses to leave the release-notes row, and the card
 *     auto-dismisses after `SUCCESS_AUTO_DISMISS_MS`.
 */

import { Trans, useLingui } from '@lingui/react/macro';
import type { ComponentProps, FC } from 'react';
import { useEffect, useState } from 'react';
import { SubscribeForm } from '@/components/SubscribeForm';
import { Button } from '@/components/ui/button';
import { dispatchExternalLinkClick } from '@/lib/external-link';
import { DISCORD_INVITE_URL, GITHUB_REPO_URL, X_PROFILE_URL } from '@/lib/social-links';
import { type SubscribeCardStore, subscribeCardStore } from '@/lib/subscribe-card-store';
import { DiscordIcon } from './icons/discord';
import { GithubIcon } from './icons/github';
import { XTwitterIcon } from './icons/x-twitter';

/** How long the "You're subscribed!" + release-notes state lingers before the card auto-dismisses. */
const SUCCESS_AUTO_DISMISS_MS = 60_000;

const SocialLink: FC<{
  href: string;
  label: string;
  icon: FC<ComponentProps<'svg'>>;
}> = ({ href, label, icon: Icon }) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    onClick={(e) => dispatchExternalLinkClick(e, href)}
    onAuxClick={(e) => dispatchExternalLinkClick(e, href)}
    aria-label={label}
    className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
  >
    <Icon aria-hidden="true" className="size-3.5" />
  </a>
);

export function SubscribeCard({
  version,
  onOpenReleaseNotes,
  onClose,
  store = subscribeCardStore,
  autoDismissMs = SUCCESS_AUTO_DISMISS_MS,
}: {
  /** Update version, rendered in the "Updated to Version X" footer row. */
  version: string;
  /** Open the release notes (external). Wired to the notice's action. */
  onOpenReleaseNotes: () => void;
  /** Remove the card from the notices store. */
  onClose: () => void;
  store?: SubscribeCardStore;
  autoDismissMs?: number;
}) {
  const { t } = useLingui();
  const [succeeded, setSucceeded] = useState(false);

  // After a confirmed subscribe, keep the card up (success view + release notes)
  // for the linger, then close it. Persisting `markSubscribed` happens in the
  // success handler so a reopen can't re-show the prompt even if the linger is
  // cut short by an unmount.
  useEffect(() => {
    if (!succeeded) return;
    const timer = setTimeout(onClose, autoDismissMs);
    return () => clearTimeout(timer);
  }, [succeeded, onClose, autoDismissMs]);

  return (
    <section
      // Named region landmark — the "Stay in the loop" heading is a <p> (from
      // SubscribeForm), not an <h*>, so aria-labelledby has nothing to point at.
      aria-label={t`Stay in the loop`}
      className="mx-1 mb-1 overflow-hidden rounded-lg border bg-card text-card-foreground"
    >
      <div className="px-3 py-2.5">
        <SubscribeForm
          source="post_update_card"
          compactSubmit
          // Shorter than the form's default so the sub-heading stays on one line
          // in the narrow sidebar footer.
          description={<Trans>Product updates in your inbox.</Trans>}
          onSuccess={() => {
            store.markSubscribed();
            setSucceeded(true);
          }}
          onDismiss={() => {
            // Close everything AND stop the prompt for good.
            store.dismiss();
            onClose();
          }}
        />
        {succeeded ? null : (
          <nav
            aria-label={t`Follow us on social media`}
            className="mt-3 flex items-center gap-1.5 text-muted-foreground text-xs"
          >
            <span className="mr-0.5">
              <Trans>Follow us on</Trans>
            </span>
            <SocialLink href={X_PROFILE_URL} label={t`Follow us on X`} icon={XTwitterIcon} />
            <SocialLink href={GITHUB_REPO_URL} label={t`Star us on GitHub`} icon={GithubIcon} />
            <SocialLink
              href={DISCORD_INVITE_URL}
              label={t`Join us on Discord`}
              icon={DiscordIcon}
            />
          </nav>
        )}
      </div>
      <div className="flex items-center justify-between border-t bg-muted/30 px-3 py-2.5 space-x-2">
        <span className="text-xs text-muted-foreground">
          <Trans>Updated to Version {version}</Trans>
        </span>
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-muted-foreground text-xs hover:text-foreground"
          onClick={onOpenReleaseNotes}
        >
          <Trans>Release notes</Trans>
        </Button>
      </div>
    </section>
  );
}
