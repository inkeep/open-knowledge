// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import {
  AGENT_ICON_COLORS,
  AGENT_ICON_COLORS_DARK,
  type InstallState,
  type TargetData,
} from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { useTheme } from 'next-themes';
import type { CSSProperties, ReactNode, SVGProps } from 'react';
import { AntigravityIcon } from '@/components/icons/antigravity';
import { ClaudeIcon } from '@/components/icons/claude';
import { CodexBrandIcon } from '@/components/icons/codex';
import { CopilotIcon } from '@/components/icons/copilot';
import { CursorIcon } from '@/components/icons/cursor';
import { HermesIcon } from '@/components/icons/hermes';
import { OpenClawIcon } from '@/components/icons/openclaw';
import { OpenCodeIcon } from '@/components/icons/opencode';
import { PiIcon } from '@/components/icons/pi';
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { openExternal as defaultOpenExternal } from '@/lib/handoff/open-external';
import { cn } from '@/lib/utils';

const TARGET_ICON_KEY: Record<TargetData['id'], string> = {
  'claude-cowork': 'claude',
  'claude-code': 'claude',
  codex: 'openai',
  cursor: 'cursor',
  copilot: 'github',
  opencode: 'opencode',
  pi: 'pi',
  antigravity: 'antigravity',
  openclaw: 'openclaw',
  hermes: 'hermes',
};

export function TargetIcon({
  id,
  style,
  className,
  ...props
}: { id: TargetData['id'] } & SVGProps<SVGSVGElement>): ReactNode {
  const { resolvedTheme } = useTheme();
  const iconKey = TARGET_ICON_KEY[id];
  const isDark = resolvedTheme === 'dark';
  const brandColor = iconKey
    ? ((isDark ? AGENT_ICON_COLORS_DARK[iconKey] : undefined) ?? AGENT_ICON_COLORS[iconKey])
    : undefined;
  const mergedStyle = brandColor
    ? ({ ...style, '--ok-brand-color': brandColor } as CSSProperties)
    : style;
  const mergedClass = cn(brandColor && '[&_*]:![color:var(--ok-brand-color)]', className);
  if (id === 'claude-cowork' || id === 'claude-code')
    return <ClaudeIcon style={mergedStyle} className={mergedClass} {...props} />;
  if (id === 'codex')
    return <CodexBrandIcon style={mergedStyle} className={mergedClass} {...props} />;
  if (id === 'cursor') return <CursorIcon style={mergedStyle} className={mergedClass} {...props} />;
  if (id === 'copilot')
    return <CopilotIcon style={mergedStyle} className={mergedClass} {...props} />;
  if (id === 'opencode')
    return <OpenCodeIcon style={mergedStyle} className={mergedClass} {...props} />;
  if (id === 'pi') return <PiIcon style={mergedStyle} className={mergedClass} {...props} />;
  if (id === 'antigravity')
    return <AntigravityIcon style={mergedStyle} className={mergedClass} {...props} />;
  if (id === 'openclaw')
    return <OpenClawIcon style={mergedStyle} className={mergedClass} {...props} />;
  if (id === 'hermes') return <HermesIcon style={mergedStyle} className={mergedClass} {...props} />;
  return null;
}

interface RowAffordance {
  readonly label: string;
  readonly url: string;
}

interface DisabledTooltip {
  readonly message: string;
  readonly installAction: RowAffordance;
}

interface RowState {
  readonly enabled: boolean;
  readonly tooltip: DisabledTooltip | null;
}

export function computeRowHint(args: {
  target: TargetData;
  installState: InstallState;
  isElectronHost: boolean;
}): string | null {
  const { installState } = args;
  if (installState.installed === null) return t`Detecting`;
  if (installState.installed === false) return t`Not installed`;
  return null;
}

export function computeRowState(args: {
  target: TargetData;
  installState: InstallState;
  isElectronHost: boolean;
}): RowState {
  const { target, installState } = args;

  if (installState.installed === null) {
    return { enabled: false, tooltip: null };
  }

  if (installState.installed === false) {
    const brand = target.appBrandName ?? target.displayName;
    const tooltip: DisabledTooltip = {
      message: t`Requires ${brand}.`,
      installAction: {
        label: t`Install ${brand} →`,
        url: target.installUrl,
      },
    };
    return { enabled: false, tooltip };
  }

  return { enabled: true, tooltip: null };
}

interface OpenInAgentMenuItemProps {
  readonly target: TargetData;
  readonly installState: InstallState;
  readonly isElectronHost: boolean;
  readonly onSelect: () => void;
  readonly openExternal?: typeof defaultOpenExternal;
}

export function OpenInAgentMenuItem(props: OpenInAgentMenuItemProps): ReactNode {
  const { t } = useLingui();
  const { target, installState, isElectronHost, onSelect } = props;
  const openExternal = props.openExternal ?? defaultOpenExternal;

  const { displayName: targetDisplayName } = target;
  const rowState = computeRowState({ target, installState, isElectronHost });
  const hint = computeRowHint({ target, installState, isElectronHost });

  const handleInstallClick = () => {
    if (!rowState.tooltip) return;
    void openExternal(rowState.tooltip.installAction.url);
  };

  if (rowState.enabled) {
    return (
      <DropdownMenuItem
        onSelect={onSelect}
        data-testid={`open-in-agent-item-${target.id}`}
        aria-label={t`Open with AI ${targetDisplayName}`}
      >
        <TargetIcon id={target.id} aria-hidden="true" />
        <span>{target.displayName}</span>
      </DropdownMenuItem>
    );
  }

  if (!rowState.tooltip) {
    const preProbeLabel = hint
      ? t`Open with AI ${targetDisplayName}, ${hint}`
      : t`Open with AI ${targetDisplayName}`;
    return (
      <DropdownMenuItem
        disabled
        data-testid={`open-in-agent-item-${target.id}`}
        aria-label={preProbeLabel}
      >
        <TargetIcon id={target.id} aria-hidden="true" />
        <span className="flex-1">{target.displayName}</span>
        {hint ? (
          <span aria-hidden="true" className="ml-2 text-muted-foreground text-xs">
            {hint}
          </span>
        ) : null}
      </DropdownMenuItem>
    );
  }

  const accessibleLabel = hint
    ? t`Open with AI ${targetDisplayName}, ${hint}`
    : t`Open with AI ${targetDisplayName}`;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        data-testid={`open-in-agent-item-${target.id}`}
        data-row-disabled=""
        aria-label={accessibleLabel}
      >
        <TargetIcon id={target.id} aria-hidden="true" className="mr-2" />
        <span className="flex-1">{target.displayName}</span>
        {hint ? (
          <span aria-hidden="true" className="ml-2 text-muted-foreground text-xs">
            {hint}
          </span>
        ) : null}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        className="min-w-[260px]"
        data-testid={`open-in-agent-submenu-${target.id}`}
      >
        <DropdownMenuLabel
          className="font-normal text-muted-foreground text-xs"
          data-testid={`open-in-agent-message-${target.id}`}
        >
          {rowState.tooltip.message}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={handleInstallClick}
          data-testid={`open-in-agent-install-${target.id}`}
        >
          <span>{rowState.tooltip.installAction.label}</span>
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
