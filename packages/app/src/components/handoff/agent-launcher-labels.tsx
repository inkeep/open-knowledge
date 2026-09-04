import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

export function DesktopAppName({ displayName }: { displayName: string }): ReactNode {
  return <Trans>{displayName} Desktop</Trans>;
}

export function OpenDesktopAppLabel({ displayName }: { displayName: string }): ReactNode {
  return <Trans>Open {displayName} Desktop</Trans>;
}

export function AskAgentNameLabel({ agentName }: { agentName: string }): ReactNode {
  return <Trans>Ask {agentName}</Trans>;
}
