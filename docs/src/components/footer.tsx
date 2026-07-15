import Link from 'next/link';
import { DiscordIcon } from '@/components/icons/discord';
import { GitHubIcon } from '@/components/icons/github';
import { XIcon } from '@/components/icons/x';
import { InkeepLogo } from '@/components/inkeep-logo';
import { BRAND_ROUTE } from '@/lib/brand-assets';
import { DISCORD_URL, GITHUB_URL, X_URL } from '@/lib/site';
import { DotTexture } from './dot-texture';

const socialLinks = [
  { href: GITHUB_URL, label: 'GitHub', Icon: GitHubIcon },
  { href: X_URL, label: 'X', Icon: XIcon },
  { href: DISCORD_URL, label: 'Discord', Icon: DiscordIcon },
];

const legalLinks = [
  { href: BRAND_ROUTE, label: 'Brand', external: false },
  {
    href: 'https://inkeep.com/policies/terms-of-service',
    label: 'Terms of Service',
    external: true,
  },
  { href: 'https://inkeep.com/policies/privacy', label: 'Privacy', external: true },
];

export function SiteFooter() {
  return (
    <footer className="relative space-y-16 overflow-hidden px-6 py-10">
      <DotTexture variant="left" className="bottom-0 left-0 w-32 sm:w-60 lg:w-96" />
      <div className="container relative z-10 mx-auto mt-8 grid grid-cols-1 items-center gap-6 min-[24rem]:grid-cols-[auto_auto] min-[24rem]:justify-between sm:grid-cols-3 sm:justify-normal">
        <div className="flex items-center justify-center gap-5 min-[24rem]:justify-start">
          {socialLinks.map(({ href, label, Icon }) => (
            <Link
              key={href}
              href={href}
              target="_blank"
              rel="noreferrer"
              aria-label={label}
              className="rounded-sm text-slide-muted/60 outline-none transition-colors hover:text-slide-text focus-visible:ring-2 focus-visible:ring-slide-accent focus-visible:ring-offset-2"
            >
              <Icon className="size-5" />
            </Link>
          ))}
        </div>
        <Link
          href="https://inkeep.com/"
          target="_blank"
          rel="noreferrer"
          aria-label="Made by Inkeep"
          className="order-first flex items-center gap-1.5 justify-self-center rounded-sm text-sm font-medium text-slide-muted/60 outline-none transition-colors min-[24rem]:col-span-2 sm:order-0 sm:col-span-1 hover:text-slide-text focus-visible:ring-2 focus-visible:ring-slide-accent focus-visible:ring-offset-2"
        >
          <span>Made by</span>
          <InkeepLogo className="w-20" />
        </Link>
        <div className="flex items-center justify-center gap-6 text-sm text-slide-muted min-[24rem]:justify-end">
          {legalLinks.map(({ href, label, external }) => (
            <Link
              key={href}
              href={href}
              target={external ? '_blank' : undefined}
              rel={external ? 'noreferrer' : undefined}
              className="rounded-sm outline-none transition-colors hover:text-slide-text focus-visible:ring-2 focus-visible:ring-slide-accent focus-visible:ring-offset-2"
            >
              {label}
            </Link>
          ))}
        </div>
      </div>
    </footer>
  );
}
