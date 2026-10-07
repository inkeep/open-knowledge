import {
  type BrokenLinkSuppression,
  isReservedLogDoc,
  type LinkCheckDeferredWarning,
  type LinksValidationSetting,
} from '@inkeep/open-knowledge-core';
import { createReservedLogBrokenLinkSuppression } from './broken-link-suppression.ts';
import type { WriteAdvisoryLink } from './write-advisory-links.ts';

export interface LinkAdvisoryPolicy {
  links: LinksValidationSetting;
  suppressLogLinkAdvisories: boolean;
}

export function shouldSuppressLogLinkAdvisories(
  sourceDocName: string,
  suppressLogLinkAdvisories: boolean,
): boolean {
  return suppressLogLinkAdvisories && isReservedLogDoc(sourceDocName);
}

const LINK_CHECK_DEFERRED_WARNING: LinkCheckDeferredWarning = {
  kind: 'link-check-deferred',
  message:
    'Link checks were skipped because the link index is still building after server start, so an empty `brokenLinks` does not mean every link resolves. Links in this document are checked again only when it is written or edited after startup finishes, or by an `audit`, which waits for startup and can time out until then.',
};

const LINK_CHECK_BUSY_WARNING: LinkCheckDeferredWarning = {
  kind: 'link-check-deferred',
  message:
    'Link checks were skipped because the link index did not answer, usually because it is busy with other writes, so an empty `brokenLinks` does not mean every link resolves. The write landed. Check this document later with `audit`, or read `brokenLinks` on your next write or edit of it.',
};

export interface WriteLinkAdvisoryProjection {
  brokenLinks: WriteAdvisoryLink[];
  brokenLinkSuppression?: BrokenLinkSuppression;
}

export interface WriteLinkAdvisory {
  links: WriteLinkAdvisoryProjection;
  warnings: LinkCheckDeferredWarning[];
}

type WriteLinkAdvisor = (
  source: string,
  docName: string,
  suppressLogLinkAdvisories: boolean,
) => WriteLinkAdvisory;

export type PrepareWriteLinkAdvisory = (
  writtenDocNames: Iterable<string>,
) => Promise<WriteLinkAdvisor>;

export function deferredWriteLinkAdvisory(): WriteLinkAdvisory {
  return { links: { brokenLinks: [] }, warnings: [LINK_CHECK_DEFERRED_WARNING] };
}

export function busyWriteLinkAdvisory(): WriteLinkAdvisory {
  return { links: { brokenLinks: [] }, warnings: [LINK_CHECK_BUSY_WARNING] };
}

export function projectWriteAdvisoryLinks(
  detected: WriteAdvisoryLink[],
  sourceDocName: string,
  suppressLogLinkAdvisories: boolean,
): WriteLinkAdvisoryProjection {
  if (
    detected.length === 0 ||
    !shouldSuppressLogLinkAdvisories(sourceDocName, suppressLogLinkAdvisories)
  ) {
    return { brokenLinks: detected };
  }
  return {
    brokenLinks: [],
    brokenLinkSuppression: createReservedLogBrokenLinkSuppression(detected.length),
  };
}
