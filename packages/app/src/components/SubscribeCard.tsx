// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { Trans, useLingui } from '@lingui/react/macro';
import type { ComponentProps, FC } from 'react';
import { useEffect, useState } from 'react';
import { SubscribeForm } from '@/components/SubscribeForm';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import { dispatchExternalLinkClick } from '@/lib/external-link';
import { DISCORD_INVITE_URL, GITHUB_REPO_URL, X_PROFILE_URL } from '@/lib/social-links';
import { type SubscribeCardStore, subscribeCardStore } from '@/lib/subscribe-card-store';
import { DiscordIcon } from './icons/discord';
import { GithubIcon } from './icons/github';
import { XTwitterIcon } from './icons/x-twitter';

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
  version: string;
  onOpenReleaseNotes: () => void;
  onClose: () => void;
  store?: SubscribeCardStore;
  autoDismissMs?: number;
}) {
  const { t } = useLingui();
  const [succeeded, setSucceeded] = useState(false);

  useEffect(() => {
    if (!succeeded) return;
    const timer = setTimeout(onClose, autoDismissMs);
    return () => clearTimeout(timer);
  }, [succeeded, onClose, autoDismissMs]);

  return (
    <Card asChild size="sm" className="mx-1 mb-1">
      <section aria-label={t`Stay in the loop`}>
        <CardContent>
          <SubscribeForm
            source="post_update_card"
            compactSubmit
            description={<Trans>Product updates in your inbox.</Trans>}
            onSuccess={() => {
              store.markSubscribed();
              setSucceeded(true);
            }}
            onDismiss={() => {
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
        </CardContent>
        <CardFooter className="justify-between gap-2">
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
        </CardFooter>
      </section>
    </Card>
  );
}
