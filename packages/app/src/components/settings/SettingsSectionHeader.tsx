/**
 * The one header every settings section renders: title, storage-scope badge,
 * the maturity tag, the description, and the standing docs link.
 *
 * Two levels, and they are a real hierarchy rather than a style choice. A
 * `page` header titles a whole sidebar destination; a `block` header titles one
 * stacked section inside a page that has several (project Preferences, Sync &
 * sharing). Sizes and heading ranks are set here so a page never renders at a
 * different weight than its siblings.
 */

import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { dispatchExternalLinkClick } from '@/lib/external-link';
import { cn } from '@/lib/utils';
import { PluginBetaBadge } from './PluginBetaBadge';
import { ScopeBadge, type SettingsScope } from './ScopeBadge';

export function SettingsSectionHeader({
  titleId,
  title,
  scope,
  level = 'page',
  beta,
  adornment,
  docUrl,
  children,
}: {
  titleId?: string;
  title: ReactNode;
  /**
   * Where this section's values are stored. Every section that has a single
   * answer states one. Omitted only by a grouping header whose blocks span
   * different scopes, where any one badge would be false for part of the page
   * and each block states its own instead.
   */
  scope?: SettingsScope;
  /** `page` titles a sidebar destination; `block` titles a section stacked inside one. */
  level?: 'page' | 'block';
  /** When set, renders the feature-maturity Beta tag beside the title. */
  beta?: boolean;
  /** Extra control seated between the title and the badges, such as an info tooltip. */
  adornment?: ReactNode;
  /**
   * Docs page for the section. The standing counterpart to the enable-time
   * toast: whoever lands here later still gets a route to the how-to.
   */
  docUrl?: string;
  /** The description under the title. */
  children?: ReactNode;
}) {
  const { t } = useLingui();
  const Heading = level === 'page' ? 'h3' : 'h4';
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Heading
          id={titleId}
          className={cn('font-semibold', level === 'page' ? 'text-lg' : 'text-base')}
        >
          {title}
        </Heading>
        {adornment}
        {beta ? <PluginBetaBadge /> : null}
        {scope ? <ScopeBadge scope={scope} /> : null}
      </div>
      {children ? <p className="text-sm text-muted-foreground">{children}</p> : null}
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
          aria-label={typeof title === 'string' ? t`Learn more about ${title}` : t`Learn more`}
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
