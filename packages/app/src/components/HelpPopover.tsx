import { getGitHubStars } from '@inkeep/open-knowledge-core';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { BookOpen, CircleDot, CircleHelp, Globe, Mail, Megaphone, Star } from 'lucide-react';
import type { ComponentProps, FC, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { SubscribeForm } from '@/components/SubscribeForm';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { dispatchExternalLinkClick } from '@/lib/external-link';
import { DISCORD_INVITE_URL, GITHUB_REPO_URL, X_PROFILE_URL } from '@/lib/social-links';
import { subscribeCardStore } from '@/lib/subscribe-card-store';
import { cn } from '@/lib/utils';
import { DiscordIcon } from './icons/discord';
import { GithubIcon } from './icons/github';
import { XTwitterIcon } from './icons/x-twitter';

// Proper-noun labels (Discord, X, GitHub) stay plain strings — not translated;
// the common-noun labels are lazy MessageDescriptors resolved per-render via
// useLingui()'s t.
interface ResourceLink {
  label: string | MessageDescriptor;
  href: string;
  icon: FC<ComponentProps<'svg'>>;
}

interface ResourceSection {
  key: string;
  heading: MessageDescriptor;
  links: ResourceLink[];
}

const sections: ResourceSection[] = [
  {
    key: 'resources',
    heading: msg`Resources`,
    links: [
      { label: msg`Docs`, href: 'https://openknowledge.ai/docs', icon: BookOpen },
      { label: msg`File an issue`, href: `${GITHUB_REPO_URL}/issues/new`, icon: CircleDot },
      { label: msg`Website`, href: 'https://openknowledge.ai/', icon: Globe },
    ],
  },
  {
    key: 'community',
    heading: msg`Community`,
    links: [
      { label: 'Discord', href: DISCORD_INVITE_URL, icon: DiscordIcon },
      { label: 'X (Twitter)', href: X_PROFILE_URL, icon: XTwitterIcon },
      { label: 'GitHub', href: GITHUB_REPO_URL, icon: GithubIcon },
    ],
  },
];

// "What's new" lives in the Product-updates section next to the Subscribe
// action, so it's rendered out of the `sections` loop below.
const WHATS_NEW_HREF = `${GITHUB_REPO_URL}/releases`;

const rowClassName =
  'group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-azure-900/5 dark:hover:bg-white/20 hover:text-primary';

function formatStarCount(count: number): string {
  if (count < 1000) return String(count);
  const thousands = count / 1000;
  return `${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1)}k`;
}

const StarCount: FC<{ count: number }> = ({ count }) => {
  const { t } = useLingui();
  const formatted = formatStarCount(count);
  return (
    <span
      role="img"
      className="ml-auto flex items-center gap-1 text-xs tabular-nums text-muted-foreground"
      aria-label={t`${formatted} GitHub stars`}
    >
      <Star className="size-3 fill-current" aria-hidden="true" />
      {formatted}
    </span>
  );
};

const ResourceLinkRow: FC<{ link: ResourceLink; trailing?: ReactNode }> = ({ link, trailing }) => {
  const { t } = useLingui();
  const { label, href, icon: Icon } = link;
  return (
    <li>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => dispatchExternalLinkClick(e, href)}
        onAuxClick={(e) => dispatchExternalLinkClick(e, href)}
        className={rowClassName}
      >
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        {typeof label === 'string' ? label : t(label)}
        {trailing}
      </a>
    </li>
  );
};

const SectionHeading: FC<{ children: ReactNode }> = ({ children }) => (
  <p className="font-mono tracking-wide uppercase text-muted-foreground text-xs mb-1">{children}</p>
);

export const HelpPopover: FC = () => {
  const { t } = useLingui();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [subscribeOpen, setSubscribeOpen] = useState(false);
  const [starCount, setStarCount] = useState<number | null>(null);

  // Fetch the repo's star count the first time the menu opens (GitHub's public
  // API sends `Access-Control-Allow-Origin: *`, so the cross-origin GET works
  // from the renderer). Best-effort: getGitHubStars collapses every failure to
  // null, so a hidden count is the only failure surface.
  useEffect(() => {
    if (!popoverOpen || starCount !== null) return;
    const controller = new AbortController();
    getGitHubStars({ signal: controller.signal }).then((count) => {
      if (count !== null) setStarCount(count);
    });
    return () => controller.abort();
  }, [popoverOpen, starCount]);

  return (
    <Popover
      open={popoverOpen}
      onOpenChange={(open) => {
        setPopoverOpen(open);
        // Reset the nested Subscribe popover when the menu closes, so it
        // doesn't re-appear already-open on the next menu open.
        if (!open) setSubscribeOpen(false);
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 hover:bg-accent text-muted-foreground"
            >
              <CircleHelp className="size-4" />
              <span className="sr-only">
                <Trans>Resources</Trans>
              </span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <Trans>Resources</Trans>
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-56 p-3">
        {sections.map((section, index) => (
          <div key={section.key} className={cn(index > 0 && 'mt-3')}>
            <SectionHeading>{t(section.heading)}</SectionHeading>
            <nav aria-label={t(section.heading)}>
              <ul className="space-y-0.5">
                {section.links.map((link) => (
                  <ResourceLinkRow
                    key={link.href}
                    link={link}
                    trailing={
                      link.href === GITHUB_REPO_URL && starCount !== null ? (
                        <StarCount count={starCount} />
                      ) : undefined
                    }
                  />
                ))}
              </ul>
            </nav>
          </div>
        ))}

        <div className="mt-3">
          <SectionHeading>
            <Trans>Product updates</Trans>
          </SectionHeading>
          <nav aria-label={t`Product updates`}>
            <ul className="space-y-0.5">
              <ResourceLinkRow
                link={{ label: msg`What's new`, href: WHATS_NEW_HREF, icon: Megaphone }}
              />
              <li>
                <Popover open={subscribeOpen} onOpenChange={setSubscribeOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      className={cn(rowClassName, 'h-auto w-full justify-start font-normal')}
                    >
                      <Mail aria-hidden="true" className="size-4 shrink-0" />
                      <Trans>Subscribe</Trans>
                    </Button>
                  </PopoverTrigger>
                  {/* Open to the left of the whole dropdown: the row is inset
                      by the dropdown's p-3, so sideOffset clears that padding
                      plus a gap rather than overlapping the menu. */}
                  <PopoverContent side="left" align="center" sideOffset={20} className="w-80">
                    <SubscribeForm
                      source="resources_menu"
                      autoFocus
                      onDismiss={() => setSubscribeOpen(false)}
                      // Subscribing here also satisfies the returning-user
                      // subscribe card's suppression flag — one subscribe, from
                      // any surface, stops the nudge.
                      onSuccess={() => subscribeCardStore.markSubscribed()}
                    />
                  </PopoverContent>
                </Popover>
              </li>
            </ul>
          </nav>
        </div>
      </PopoverContent>
    </Popover>
  );
};
