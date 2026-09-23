import { DESKTOP_PRODUCTS, type DesktopProductName } from '@inkeep/open-knowledge-core';

const DESKTOP_VARIANT_NAMES = ['stable', 'beta'] as const satisfies readonly DesktopProductName[];

export type DesktopVariantName = (typeof DESKTOP_VARIANT_NAMES)[number];

interface DesktopVariantIdentity {
  readonly name: DesktopVariantName;
  readonly appId: string;
  readonly productName: string;
  readonly artifactName: string;
  readonly packageName: string;
  readonly protocolScheme: string;
  readonly updateChannel: 'latest' | 'beta';
  readonly instanceLabel: string | null;
  readonly iconPath: string;
  readonly linuxExecutableName: string;
  readonly linuxPackageNames: {
    readonly deb: string;
    readonly rpm: string;
  };
  readonly cliCommandNames: readonly [string, string];
  readonly cliHomeSegment: string | null;
}

export const DESKTOP_VARIANTS = {
  stable: {
    name: 'stable',
    appId: DESKTOP_PRODUCTS.stable.appId,
    productName: DESKTOP_PRODUCTS.stable.productName,
    artifactName: 'OpenKnowledge',
    packageName: DESKTOP_PRODUCTS.stable.packageName,
    protocolScheme: 'openknowledge',
    updateChannel: 'latest',
    instanceLabel: null,
    iconPath: 'build/icon.png',
    linuxExecutableName: DESKTOP_PRODUCTS.stable.linuxExecutableName,
    linuxPackageNames: DESKTOP_PRODUCTS.stable.linuxPackageNames,
    cliCommandNames: ['ok', 'open-knowledge'],
    cliHomeSegment: null,
  },
  beta: {
    name: 'beta',
    appId: DESKTOP_PRODUCTS.beta.appId,
    productName: DESKTOP_PRODUCTS.beta.productName,
    artifactName: 'OpenKnowledge-Beta',
    packageName: DESKTOP_PRODUCTS.beta.packageName,
    protocolScheme: 'openknowledge-beta',
    updateChannel: 'beta',
    instanceLabel: 'Beta',
    iconPath: 'build/icon-beta.png',
    linuxExecutableName: DESKTOP_PRODUCTS.beta.linuxExecutableName,
    linuxPackageNames: DESKTOP_PRODUCTS.beta.linuxPackageNames,
    cliCommandNames: ['ok-beta', 'open-knowledge-beta'],
    cliHomeSegment: 'beta',
  },
} as const satisfies Record<DesktopVariantName, DesktopVariantIdentity>;

export function parseDesktopVariantName(raw: string | undefined): DesktopVariantName {
  const normalized = raw?.trim().toLowerCase() || 'stable';
  if ((DESKTOP_VARIANT_NAMES as readonly string[]).includes(normalized)) {
    return normalized as DesktopVariantName;
  }
  throw new Error(
    `Unsupported OK_DESKTOP_VARIANT=${JSON.stringify(raw)}. Expected stable or beta.`,
  );
}

declare const __OK_DESKTOP_VARIANT__: string | undefined;

export const DESKTOP_VARIANT =
  DESKTOP_VARIANTS[
    parseDesktopVariantName(
      typeof __OK_DESKTOP_VARIANT__ === 'string' ? __OK_DESKTOP_VARIANT__ : undefined,
    )
  ];
