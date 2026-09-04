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
  scope?: SettingsScope;
  level?: 'page' | 'block';
  beta?: boolean;
  adornment?: ReactNode;
  docUrl?: string;
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
