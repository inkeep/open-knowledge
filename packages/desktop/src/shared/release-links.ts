export const PUBLIC_RELEASES_URL = 'https://github.com/inkeep/open-knowledge/releases';

export function releasesPageUrl(_variant: { readonly name: string }): string {
  return PUBLIC_RELEASES_URL;
}

export function releaseUrlFor(version: string, releasesUrl = PUBLIC_RELEASES_URL): string {
  return `${releasesUrl}/tag/v${encodeURIComponent(version)}`;
}
