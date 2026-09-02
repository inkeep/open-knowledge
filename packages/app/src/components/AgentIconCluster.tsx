// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { EDITOR_LABELS } from '@inkeep/open-knowledge-core';
import { Folder, Sparkles } from 'lucide-react';
import type { SVGProps } from 'react';
import { TargetIcon } from '@/components/handoff/OpenInAgentMenuItem';
import { LmStudioIcon } from '@/components/icons/lmstudio';
import { OkBlob } from '@/components/OkBlob';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type TargetIconId = Parameters<typeof TargetIcon>[0]['id'];

export function hostLabel(host: string): string {
  if (host === 'agents' || host === '.agents' || host.startsWith('.agents/')) return '.agents';
  if (host.includes('/')) return host;
  return (EDITOR_LABELS as Record<string, string>)[host] ?? host;
}

export const AGENT_CLUSTER_MAX = 2;

function targetIconIdForHost(host: string): TargetIconId {
  return (host === 'claude' ? 'claude-code' : host) as TargetIconId;
}

export function AgentBrandIcon({
  host,
  ...props
}: { host: string } & Omit<SVGProps<SVGSVGElement>, 'id'>) {
  if (host === 'agents') return <Sparkles {...props} />;
  if (host === 'lm-studio') return <LmStudioIcon {...props} />;
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
