import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { DiscordIcon } from '@/components/icons/discord';
import { GitHubIcon } from '@/components/icons/github';
import { XIcon } from '@/components/icons/x';
import { OkWordmark } from '@/components/ok-wordmark';
import { DISCORD_URL, GITHUB_URL, X_URL } from '@/lib/site';

export function baseOptions({
  wordmarkClassName = 'h-8 w-auto text-(--slide-text)',
}: {
  wordmarkClassName?: string;
} = {}): BaseLayoutProps {
  return {
    nav: {
      title: <OkWordmark aria-label="OpenKnowledge" className={wordmarkClassName} />,
    },
    links: [
      {
        type: 'icon',
        url: GITHUB_URL,
        label: 'GitHub',
        text: 'GitHub',
        icon: <GitHubIcon className="size-full" />,
        external: true,
      },
      {
        type: 'icon',
        url: DISCORD_URL,
        label: 'Discord',
        text: 'Discord',
        icon: <DiscordIcon className="size-full" />,
        external: true,
      },
      {
        type: 'icon',
        url: X_URL,
        label: 'X (Twitter)',
        text: 'X',
        icon: <XIcon className="size-full" />,
        external: true,
      },
    ],
  };
}
