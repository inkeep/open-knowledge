/**
 * Per-row component inside the Open-in-Agent dropdown.
 *
 * Three visual shapes per row:
 *   1. Enabled — icon + display name; click invokes the supplied `onSelect`.
 *      Radix DropdownMenuItem closes the menu automatically on selection.
 *   2. Disabled pre-probe (install state is `null`) — plain `DropdownMenuItem`
 *      with `disabled`, inline hint "Detecting…" on the right (defensive).
 *   3. Disabled post-probe (not installed) — rendered as a `DropdownMenuSub`
 *      whose trigger looks like the enabled row plus a right-aligned status
 *      hint; the submenu contains an "Install <displayName> →" affordance.
 *
 * Why a submenu (not a hover tooltip with buttons): a tooltip hosting
 * interactive content violates the WAI-ARIA tooltip pattern (tooltips are
 * hints; they auto-dismiss, are screen-reader-announced as descriptions, and
 * must not hold focusable widgets). Radix `DropdownMenuItem` with `disabled`
 * also removes the row from roving focus — keyboard users never see the
 * tooltip in the first place. Routing the affordance through a nested
 * `DropdownMenuSub` makes it a proper keyboard-reachable menu item and fixes
 * both failure modes at once.
 *
 * Per-row classification is split into the pure helper `computeRowState`
 * (unchanged signature; consumers across sibling surfaces still rely on it)
 * so unit tests cover the logic without rendering.
 */

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

/**
 * Vendor icon per target. Claude Cowork and Claude share `ClaudeIcon`
 * since both dispatch to Claude Desktop. `TARGET_ICON_KEY` is an exhaustive
 * `Record<TargetData['id'], string>`, so adding a target forces a KEY there —
 * but the `if`-chain below has no exhaustiveness assertion, so a new target with
 * a key and no branch still falls through to `null`. That is precisely the
 * `lm-studio` shape this comment used to claim was impossible.
 *
 * The nearest guard is the skill-host icon-coverage test, but it is narrower
 * than this chain. It iterates `SkillUserTargetEditorSchema.options`, which
 * excludes `openclaw` and `hermes` — so those TWO branches can each be deleted
 * with the suite green. (`claude-cowork` is also never reached, since
 * `targetIconIdForHost` maps to `claude-code`, but it shares an `if` with
 * `claude-code`, so deleting it goes red anyway.) Adding a target here without a
 * mark is caught only when that target is also a user-global skill host.
 *
 * Deliberately NOT a neutral-glyph fallback: skill hosts are a WIDER vocabulary
 * than handoff targets and reach these marks through `AgentBrandIcon`, so a
 * runtime fallback here would silently absorb a missing skill-host mark — the
 * exact `lm-studio` failure this comment used to describe — and would make the
 * icon-coverage test unable to fail. `Sparkles` is also already reserved as the
 * `.agents` hub's own mark.
 *
 * DropdownMenuItem + DropdownMenuSubTrigger both auto-size `<svg>` children
 * to `size-4`, so the icon doesn't need an explicit size prop.
 *
 * Brand colors come from the shared `AGENT_ICON_COLORS` palette; dark-mode
 * overrides (e.g. Cursor's near-black logo lifts to white) match the
 * timeline + presence-bar treatment.
 */
const TARGET_ICON_KEY: Record<TargetData['id'], string> = {
  'claude-cowork': 'claude',
  'claude-code': 'claude',
  codex: 'openai',
  cursor: 'cursor',
  copilot: 'github',
  // No `AGENT_ICON_COLORS` entry → renders monochrome (inherits the row's text
  // color), which suits OpenCode's, Pi's, Antigravity's, OpenClaw's, and Hermes'
  // monochrome brand marks.
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
  // The dropdown item's `focus:**:text-accent-foreground` cascades `color`
  // to every descendant — including the inner `<path>`, whose
  // `fill|stroke="currentColor"` then resolves to accent-foreground (black
  // in light mode). Inline `style.color` on the `<svg>` doesn't reach the
  // path. Override `color` directly on descendants with `!important` via
  // the `--ok-brand-color` custom property so the brand color survives
  // hover/focus.
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

/** A clickable affordance shown inside the disabled-row submenu. */
interface RowAffordance {
  readonly label: string;
  readonly url: string;
}

/** Submenu payload for a disabled row. `null` while install state is `null`
 *  (initial probe in flight) — disabled-but-no-submenu. */
interface DisabledTooltip {
  /** Main message — describes why the row is disabled (used for the short
   *  hint text rendered inline on the trigger row). */
  readonly message: string;
  /** Primary install affordance — always present when a submenu is shown. */
  readonly installAction: RowAffordance;
}

interface RowState {
  readonly enabled: boolean;
  /** When non-null, render a submenu with the install affordance instead of a
   *  plain disabled item. The `message` field doubles as the short
   *  right-aligned status hint for the trigger row. */
  readonly tooltip: DisabledTooltip | null;
}

/**
 * Short inline hint rendered on a disabled row's trigger. Parallels the
 * sibling surfaces (`OpenInAgentContextSubmenu.contextRowHint`,
 * `CommandPalette`'s inline hint). Centralized so all three surfaces agree
 * on the pre-probe / not-installed / desktop-only copy.
 */
export function computeRowHint(args: {
  target: TargetData;
  installState: InstallState;
  isElectronHost: boolean;
}): string | null {
  const { installState } = args;
  // Web-host Cursor is no longer treated specially — `cursor-two-step.ts`
  // gained a fetch fallback to `POST /api/spawn-cursor`, so web hosts have
  // feature parity with Electron when the loopback OK server is reachable.
  // The `isElectronHost` arg is kept in the signature for API stability;
  // future targets that need host-aware hints (e.g. CLI-only tools) can
  // branch on it without churning every call site.
  if (installState.installed === null) return t`Detecting`;
  if (installState.installed === false) return t`Not installed`;
  return null;
}

/**
 * Pure derivation of per-row visual state.
 *
 * Branches:
 *   1. Pre-probe (`installed === null`) → disabled, no submenu (the
 *      surface renders a plain `DropdownMenuItem` with a "Detecting…" hint).
 *   2. Not installed (`installed === false`) → disabled, install affordance
 *      surfaces as a submenu item.
 *   3. Installed → enabled, no submenu.
 *
 * Web-host Cursor used to short-circuit to a "Desktop only" disabled state
 * here. That branch was removed when `cursor-two-step.ts` gained a fetch
 * fallback (`POST /api/spawn-cursor`) so web hosts now have a real Cursor
 * transport. When the loopback server isn't reachable (cloud-hosted OK,
 * older server, missing `cursor` CLI), the spawn returns `not-installed`
 * and the not-installed branch surfaces the standard install affordance.
 */
export function computeRowState(args: {
  target: TargetData;
  installState: InstallState;
  isElectronHost: boolean;
}): RowState {
  const { target, installState } = args;

  // Branch 1: pre-probe — defensive disabled, no submenu.
  if (installState.installed === null) {
    return { enabled: false, tooltip: null };
  }

  // Branch 2: not installed — install affordance in a submenu.
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

  // Branch 3: installed — enabled, no submenu.
  return { enabled: true, tooltip: null };
}

interface OpenInAgentMenuItemProps {
  readonly target: TargetData;
  readonly installState: InstallState;
  readonly isElectronHost: boolean;
  /** Fired only when the row is enabled and the user selects it. The hook
   *  layer (`useHandoffDispatch`) handles toast + telemetry. */
  readonly onSelect: () => void;
  /** Test seam — wraps the openExternal primitive used by the install affordance. */
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

  // Enabled row — direct DropdownMenuItem, click dispatches.
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

  // Pre-probe — plain disabled row with "Detecting…" hint. `aria-label`
  // composes the hint into the accessible name so AT users hear "Open with AI
  // Codex, Detecting…" rather than an identical-sounding bare row.
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

  // Disabled post-probe — submenu with the install affordance. Using
  // DropdownMenuSub instead of a Tooltip-with-buttons keeps the affordance
  // keyboard-accessible and ARIA-correct. The SubContent opens with a
  // DropdownMenuLabel carrying the descriptive "Requires <brand>." message so
  // the user keeps the "why is this disabled" context.
  //
  // `aria-label` on the SubTrigger composes the hint into the accessible name
  // so screen readers hear "Open with AI Claude, Not installed" rather than
  // the bare "Open with AI Claude" that would otherwise be indistinguishable
  // from an enabled row. The `aria-hidden` hint span stays visually present
  // but is not re-read as part of the computed name.
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
