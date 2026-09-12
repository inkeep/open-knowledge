import {
  type BrokenLinkSuppression,
  isReservedLogDoc,
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

export interface WriteLinkAdvisoryProjection {
  brokenLinks: WriteAdvisoryLink[];
  brokenLinkSuppression?: BrokenLinkSuppression;
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
