/**
 * Registered-agent brand icon shared by every ACP surface. First-party agents
 * use the app's local brand treatment; every other registry/custom agent keeps
 * its manifest SVG with a neutral-glyph fallback on load failure.
 *
 * The registry's manifest SVGs are monochrome `currentColor` marks by contract
 * — the registry's own CI rejects an icon carrying any hardcoded color. Loaded
 * through `<img src>` an SVG is an isolated document, so `currentColor`
 * resolves against that document's initial `color: black`: every mark paints
 * black and all but disappears on a dark background. `dark:invert` lifts those
 * black marks to white, which is what the contract asks for on a dark theme.
 *
 * Inverting is the crude form of the fix; painting the SVG as an alpha mask
 * over `bg-current` would give the glyph the row's own text color and track
 * muted/hover states too. That needs same-origin bytes — the registry CDN
 * serves these icons with no `Access-Control-Allow-Origin`, and a mask image
 * load is CORS-checked where an `<img>` load is not — so it would have to wait
 * on the server proxying or inlining the icon (as `link-preview` already does
 * for favicons).
 */

import { Bot } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { ClaudeIcon } from '@/components/icons/claude';
import { CodexBrandIcon } from '@/components/icons/codex';
import { CursorIcon } from '@/components/icons/cursor';
import { cn } from '@/lib/utils';

export function RegisteredAgentIcon({
  agentId,
  iconUrl,
  className,
}: {
  agentId: string;
  iconUrl?: string;
  className?: string;
}): ReactNode {
  const [failed, setFailed] = useState(false);
  const brandClassName = cn('shrink-0', className);
  if (agentId === 'claude-acp') {
    return (
      <ClaudeIcon
        className={cn(
          'text-[#D97757] [--ok-brand-color:#D97757] [&_*]:![color:var(--ok-brand-color)]',
          brandClassName,
        )}
        aria-hidden="true"
      />
    );
  }
  if (agentId === 'codex-acp') {
    return <CodexBrandIcon className={brandClassName} aria-hidden="true" />;
  }
  if (agentId === 'cursor') {
    return (
      <CursorIcon
        className={cn(
          'text-[#1B1912] [--ok-brand-color:#1B1912] [&_*]:![color:var(--ok-brand-color)] dark:text-white dark:[--ok-brand-color:#FFFFFF]',
          brandClassName,
        )}
        aria-hidden="true"
      />
    );
  }
  if (iconUrl === undefined || failed) {
    return <Bot className={cn('shrink-0 text-muted-foreground', className)} aria-hidden="true" />;
  }
  return (
    <img
      src={iconUrl}
      alt=""
      aria-hidden="true"
      className={cn('shrink-0 rounded dark:invert', className)}
      onError={() => setFailed(true)}
    />
  );
}
