/**
 * Shared agent brand-icon primitives for skill install/detect surfaces. One place
 * owns (a) the host-id → `TargetIcon`-id mapping, (b) the "+N" overflow cap, and
 * (c) the React cluster component, so every surface that shows "which agents" —
 * the editor toolbar badge, the sidebar's hidden icon pool, the sidebar injector —
 * draws the marks identically instead of re-deriving them.
 */

import { EDITOR_LABELS } from '@inkeep/open-knowledge-core';
import { Folder, Sparkles } from 'lucide-react';
import type { SVGProps } from 'react';
import { TargetIcon } from '@/components/handoff/OpenInAgentMenuItem';
import { OkBlob } from '@/components/OkBlob';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type TargetIconId = Parameters<typeof TargetIcon>[0]['id'];

/**
 * Human-readable label for an install-host id, so the cluster's icons and its
 * "+N" overflow can name themselves in a tooltip (the brand marks are
 * unidentifiable at rest — nobody could tell the `.agents` mark from a plugin).
 * Editor ids map to their display name; the vendor-neutral hub reads `.agents`;
 * custom-root hosts ARE paths and show verbatim.
 */
function hostLabel(host: string): string {
  if (host === 'agents' || host === '.agents' || host.startsWith('.agents/')) return '.agents';
  if (host.includes('/')) return host;
  return (EDITOR_LABELS as Record<string, string>)[host] ?? host;
}

/** Max brand icons shown before the rest collapse into a "+N" overflow. Shared by
 *  the React cluster AND the sidebar's imperative shadow-DOM cluster so both
 *  surfaces overflow at the same count. */
export const AGENT_CLUSTER_MAX = 2;

/**
 * Map a skill install-host / detected-harness id to its `TargetIcon` id. The only
 * divergence is `claude` → `claude-code` (the install-verb id vs. the handoff
 * target id); every other id (`cursor`, `codex`, `copilot`, `opencode`, `pi`)
 * passes straight through. Unknown ids pass through too and `TargetIcon` renders
 * nothing for them (graceful no-op).
 */
function targetIconIdForHost(host: string): TargetIconId {
  return (host === 'claude' ? 'claude-code' : host) as TargetIconId;
}

/** A single agent brand mark in real brand color — thin wrapper over `TargetIcon`
 *  with the host-id mapping applied. Reused by the sidebar's clone pool. `id` is
 *  derived from `host`, so the spread comes first and the mapped id wins. */
export function AgentBrandIcon({
  host,
  ...props
}: { host: string } & Omit<SVGProps<SVGSVGElement>, 'id'>) {
  // The vendor-neutral `.agents/skills` hub is a first-class skill host with no
  // brand — a neutral mark, not an invisible one (dropping it made a hub-hosted
  // skill read as belonging to whichever editor copy happened to exist).
  if (host === 'agents') return <Sparkles {...props} />;
  // Custom-root host ids ARE paths (they contain '/'): the `.ok` home renders
  // the OK blob, any other custom root the neutral folder — matching the
  // install menu's row icons so the pill cluster can carry every location.
  if (host.includes('/')) {
    if (host === '.agents' || host.startsWith('.agents/')) return <Sparkles {...props} />;
    if (host === '.ok' || host.startsWith('.ok/')) {
      const { className: _className, ...rest } = props;
      return <OkBlob size={14} {...(rest as Record<string, unknown>)} />;
    }
    return <Folder {...props} />;
  }
  return <TargetIcon {...props} id={targetIconIdForHost(host)} />;
}

/**
 * A horizontal cluster of agent brand icons (real brand colors via `TargetIcon`),
 * capped at {@link AGENT_CLUSTER_MAX} with a "+N" overflow. Reused wherever a
 * skill's install/detect targets render in a React tree (the editor toolbar badge
 * today).
 *
 * The sidebar rows can't render this component — they live in Pierre's
 * style-isolated shadow root — but they share the same mapping + cap via the
 * exports above (see `skill-install-cluster.ts`).
 */
export function AgentIconCluster({
  hosts,
  className,
  iconClassName,
}: {
  hosts: readonly string[];
  className?: string;
  iconClassName?: string;
}) {
  const shown = hosts.slice(0, AGENT_CLUSTER_MAX);
  const overflowHosts = hosts.slice(AGENT_CLUSTER_MAX);
  return (
    <span className={cn('flex items-center gap-1', className)}>
      {shown.map((host) => (
        // Radix Tooltip (not native `title`) so the mark names itself even when
        // the window isn't focused, which native tooltips fail to do.
        <Tooltip key={host}>
          <TooltipTrigger asChild>
            <span className="flex shrink-0 items-center">
              <AgentBrandIcon
                host={host}
                className={cn('size-3.5 shrink-0', iconClassName)}
                aria-label={hostLabel(host)}
              />
            </span>
          </TooltipTrigger>
          <TooltipContent>{hostLabel(host)}</TooltipContent>
        </Tooltip>
      ))}
      {overflowHosts.length > 0 ? (
        // The "+N" now lists the extra install locations instead of being an
        // opaque count.
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="ml-0.5 cursor-default">+{overflowHosts.length}</span>
          </TooltipTrigger>
          <TooltipContent>{overflowHosts.map(hostLabel).join(', ')}</TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  );
}
