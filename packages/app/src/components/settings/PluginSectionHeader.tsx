/**
 * Shared header for a per-plugin settings panel — title, the maturity and scope
 * badges, the description, and the standing docs link.
 *
 * Lives outside `LintingSection` because not every plugin is a lint plugin:
 * Slidev owns no `contentRules` slice, and importing this from the lint module
 * would pull the whole rule-catalog graph into a panel that has no use for it.
 */

import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { dispatchExternalLinkClick } from '@/lib/external-link';
import { PluginBetaBadge } from './PluginBetaBadge';
import { ScopeBadge } from './ScopeBadge';

export function PluginSectionHeader({
  titleId,
  title,
  scope,
  beta,
  docUrl,
  children,
}: {
  titleId: string;
  title: string;
  /** When set, renders a User/Project scope badge beside the title. */
  scope?: 'user' | 'project';
  /** When set, renders the feature-maturity Beta tag beside the title. */
  beta?: boolean;
  /**
   * Docs page for the plugin. The standing counterpart to the enable-time
   * toast: whoever lands here later still gets a route to the how-to.
   */
  docUrl?: string;
  children: ReactNode;
}) {
  const { t } = useLingui();
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <h3 id={titleId} className="text-base font-semibold">
          {title}
        </h3>
        {beta ? <PluginBetaBadge /> : null}
        {scope ? <ScopeBadge scope={scope} /> : null}
      </div>
      <p className="text-sm text-muted-foreground">{children}</p>
      {docUrl !== undefined ? (
        <a
          href={docUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => dispatchExternalLinkClick(e, docUrl)}
          onAuxClick={(e) => dispatchExternalLinkClick(e, docUrl)}
          // Names its destination for anyone listing links out of context, where
          // a bare "Learn more" says nothing. Keeps the visible text as a prefix
          // so voice control still activates it by what's on screen.
          aria-label={t`Learn more about ${title}`}
          className="inline-flex items-center gap-0.5 text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          data-testid={`${titleId}-docs-link`}
        >
          <Trans>Learn more</Trans>
          <ArrowUpRight aria-hidden className="size-3" />
        </a>
      ) : null}
    </div>
  );
}
