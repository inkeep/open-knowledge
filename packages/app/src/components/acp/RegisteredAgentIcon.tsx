/**
 * Registered-agent brand icon shared by every ACP surface. First-party agents
 * use the app's local brand treatment; every other registry/custom agent keeps
 * its manifest SVG with a neutral-glyph fallback on load failure.
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
      className={cn('shrink-0 rounded', className)}
      onError={() => setFailed(true)}
    />
  );
}
