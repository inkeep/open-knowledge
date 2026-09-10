import {
  BROKEN_LINK_SUPPRESSION_REASONS,
  type BrokenLinkSuppression,
  type BrokenLinkSuppressionReason,
} from '@inkeep/open-knowledge-core';

type AuditSuppressionAudience = 'agent' | 'human';
export type AuditSuppressionTarget = { surface: 'cli'; serverBaseUrl: string } | { surface: 'mcp' };
type AuditSuppressionSurface = AuditSuppressionTarget['surface'];

const SUPPRESSION_EXPLANATIONS = {
  agent: {
    'reserved-log-policy':
      'a reserved `log.md` records history whose links are expected not to resolve. Nothing here is yours to repair — repairing them rewrites the history the log exists to keep, and turning the project setting off yourself is not a workaround. If the user asks to see these findings, point them at Settings ▸ This project ▸ Preferences ▸ Content rules.',
  },
  human: {
    'reserved-log-policy':
      'a reserved `log.md` records history whose links are expected not to resolve. These findings stay out of the repair queue to protect that history. Set `validation.suppressLogLinkAdvisories: false` in `.ok/config.yml` to bring them back, or turn off "Ignore broken links in log.md" under Settings ▸ This project ▸ Preferences ▸ Content rules.',
  },
} as const satisfies Record<AuditSuppressionAudience, Record<BrokenLinkSuppressionReason, string>>;

const UNKNOWN_SUPPRESSION_EXPLANATIONS = {
  agent: (reason: string) =>
    `this build does not recognize the project policy "${reason}", so it cannot say why. Treat the withheld findings as not yours to repair and ask the user if they need to see them.`,
  human: (reason: string) =>
    `this build does not recognize the project policy "${reason}", so it cannot explain why these findings were withheld.`,
} as const satisfies Record<AuditSuppressionAudience, (reason: string) => string>;

const RAW_STATE_GUIDANCE = {
  agent: 'inspect it only when the user asks, not as a repair queue.',
  human: 'inspect it when you need the unfiltered view, not as a repair queue.',
} as const satisfies Record<AuditSuppressionAudience, string>;

const AUDIT_SUPPRESSION_SURFACES = {
  cli: {
    audience: 'human',
  },
  mcp: {
    audience: 'agent',
  },
} as const satisfies Record<
  AuditSuppressionSurface,
  {
    audience: AuditSuppressionAudience;
  }
>;

function isKnownSuppressionReason(reason: string): reason is BrokenLinkSuppressionReason {
  return (BROKEN_LINK_SUPPRESSION_REASONS as readonly string[]).includes(reason);
}

function suppressionExplanation(reason: string, audience: AuditSuppressionAudience): string {
  if (isKnownSuppressionReason(reason)) {
    return SUPPRESSION_EXPLANATIONS[audience][reason];
  }
  return UNKNOWN_SUPPRESSION_EXPLANATIONS[audience](reason);
}

function assertNeverAuditSuppressionTarget(target: never): never {
  throw new Error(`Unhandled AuditSuppressionTarget: ${JSON.stringify(target as unknown)}`);
}

function rawStateRoute(target: AuditSuppressionTarget): string {
  switch (target.surface) {
    case 'cli':
      return `${target.serverBaseUrl}/api/dead-links`;
    case 'mcp':
      return 'links({ kind: "dead" })';
    default:
      return assertNeverAuditSuppressionTarget(target);
  }
}

function suppressionCountPhrase(suppression: BrokenLinkSuppression): string {
  return `${suppression.count} broken-link finding${suppression.count === 1 ? '' : 's'}`;
}

export function createReservedLogBrokenLinkSuppression(
  count: number,
): BrokenLinkSuppression | undefined {
  return count > 0 ? { reason: 'reserved-log-policy', count } : undefined;
}

export function formatBrokenLinkSuppressionLine(suppression: BrokenLinkSuppression): string {
  return `ℹ ${suppressionCountPhrase(suppression)} withheld by project policy, so \`brokenLinks: []\` above does NOT mean every link resolves — ${suppressionExplanation(suppression.reason, 'agent')}`;
}

export function formatBrokenLinkSuppressionBrief(suppression: BrokenLinkSuppression): string {
  return `ℹ ${suppressionCountPhrase(suppression)} withheld by project policy (see brokenLinkSuppression); this filtered result does NOT mean every link resolves, and there is nothing to repair.`;
}

export function formatAuditBrokenLinkSuppressionLine(
  suppression: BrokenLinkSuppression,
  target: AuditSuppressionTarget,
): string {
  const { audience } = AUDIT_SUPPRESSION_SURFACES[target.surface];
  return `ℹ ${suppressionCountPhrase(suppression)} withheld by project policy. This audit result is filtered, so it does NOT prove every link resolves — ${suppressionExplanation(suppression.reason, audience)} Raw state remains available through ${rawStateRoute(target)} — ${RAW_STATE_GUIDANCE[audience]}`;
}

export function formatUnreadableAuditSuppressionWarning(target: AuditSuppressionTarget): string {
  const { audience } = AUDIT_SUPPRESSION_SURFACES[target.surface];
  return `Broken-link findings were withheld by project policy in a form this build cannot read. This audit result is filtered, so it does NOT prove every link resolves. Raw state remains available through ${rawStateRoute(target)} — ${RAW_STATE_GUIDANCE[audience]}`;
}
