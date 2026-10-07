import type { OkAboutInfo } from '@inkeep/open-knowledge-core/desktop-bridge';
import { releasesPageUrl, releaseUrlFor } from '../shared/release-links.ts';

export function buildAboutInfo({
  version,
  variant,
  updateChecksAvailable,
}: {
  version: string;
  variant: { readonly name: string; readonly productName: string };
  updateChecksAvailable: boolean;
}): OkAboutInfo {
  const releasesUrl = releasesPageUrl(variant);
  return {
    productName: variant.productName,
    version,
    releasesUrl,
    releaseNotesUrl: releaseUrlFor(version, releasesUrl),
    updateChecks: updateChecksAvailable ? 'available' : 'unavailable',
  };
}
