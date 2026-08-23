/**
 * The one truthful row for a built-in skill offered for install, shared by
 * Settings → Skills Studio (both scopes) and the first-launch consent dialog
 * (near-duplicate markup before this). It renders what the skill is (name + its own frontmatter
 * description, replacing the hand-written subtext) and where it reaches (the
 * existing agent-icon cluster, including custom roots). Token cost is
 * deliberately NOT shown here — it belongs to the pre-install preview and the
 * skill's own Properties, not a settings row.
 *
 * Presentational only: the surface-specific control (Settings' Install/Uninstall
 * button, first launch's staged checkbox) arrives as `control`, and the body's
 * click behaviour (Settings opens the preview; first launch expands inline) as
 * `onActivate`. Reach is passed as host ids so the row mirrors
 * `AgentIconCluster`'s own contract and stays decoupled from the bridge status.
 */

import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { AgentIconCluster } from '@/components/AgentIconCluster';
import { Button } from '@/components/ui/button';

export interface SkillConsentRowProps {
  name: string;
  /** The skill's own frontmatter description. */
  description: string;
  /** Reach: static editor ids plus custom-root paths (rendered verbatim). Empty
   *  ⇒ the cluster is replaced by explanatory copy. */
  hosts: readonly string[];
  /** Preview affordance: Settings opens the preview tab, first launch expands
   *  inline. Absent ⇒ the body is static. */
  onActivate?: () => void;
  /** Disclosure state, when `onActivate` toggles an inline region (first
   *  launch). Omitted by Settings, where `onActivate` navigates to a preview
   *  tab rather than expanding anything - a static `aria-expanded` there would
   *  announce a disclosure that does not exist. */
  ariaExpanded?: boolean;
  /** Surface-specific control rendered on the right. */
  control?: ReactNode;
}

export function SkillConsentRow({
  name,
  description,
  hosts,
  onActivate,
  ariaExpanded,
  control,
}: SkillConsentRowProps) {
  const body = (
    <>
      <span className="text-sm font-medium text-foreground group-hover/button:underline">
        <code>{name}</code>
      </span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </>
  );
  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5" data-testid="skill-consent-row">
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        {onActivate ? (
          <Button
            variant="ghost"
            onClick={onActivate}
            aria-expanded={ariaExpanded}
            className="group/button h-auto w-full flex-col items-start justify-start gap-0.5 whitespace-normal p-0 text-left hover:bg-transparent"
            data-testid="skill-consent-row-preview"
          >
            {body}
          </Button>
        ) : (
          <span className="flex flex-col gap-0.5">{body}</span>
        )}
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {hosts.length > 0 ? (
            <AgentIconCluster hosts={hosts} />
          ) : (
            <span
              className="text-xs text-muted-foreground"
              data-testid="skill-consent-row-no-hosts"
            >
              <Trans>No AI tools detected. Install one to use this skill.</Trans>
            </span>
          )}
        </span>
      </span>
      {control ? <span className="shrink-0">{control}</span> : null}
    </div>
  );
}
