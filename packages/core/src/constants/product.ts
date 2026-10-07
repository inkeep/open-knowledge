export const DESKTOP_PRODUCTS = {
  stable: {
    appId: 'com.inkeep.open-knowledge',
    productName: 'OpenKnowledge',
    packageName: '@inkeep/open-knowledge-desktop',
    linuxExecutableName: 'openknowledge',
    protocolScheme: 'openknowledge',
    linuxPackageNames: {
      deb: 'openknowledge',
      rpm: 'OpenKnowledge',
    },
    cliCommandNames: ['ok', 'open-knowledge'],
    mcpServerName: 'open-knowledge',
    mcpChainTag: '',
    npmDistTag: 'latest',
    userHomeDirName: '.ok',
    keyringService: 'open-knowledge',
  },
  beta: {
    appId: 'com.inkeep.open-knowledge.beta',
    productName: 'OpenKnowledge Beta',
    packageName: 'openknowledge-beta-desktop',
    linuxExecutableName: 'openknowledge-beta',
    protocolScheme: 'openknowledge-beta',
    linuxPackageNames: {
      deb: 'openknowledge-beta-desktop',
      rpm: 'openknowledge-beta-desktop',
    },
    cliCommandNames: ['ok-beta', 'open-knowledge-beta'],
    mcpServerName: 'open-knowledge-beta',
    mcpChainTag: '-beta',
    npmDistTag: 'beta',
    userHomeDirName: '.ok-beta',
    keyringService: 'open-knowledge-beta',
  },
} as const;

export type DesktopProductName = keyof typeof DESKTOP_PRODUCTS;
export type DesktopProduct = (typeof DESKTOP_PRODUCTS)[DesktopProductName];

export function desktopWindowsExecutableName(product: DesktopProduct): string {
  return `${product.productName}.exe`;
}

export function desktopWindowsInstallDirNames(product: DesktopProduct): readonly string[] {
  return [product.packageName.replaceAll('/', ''), product.productName];
}

export const PRODUCT_NAME = DESKTOP_PRODUCTS.stable.productName;

export const OK_CHANNEL_ENV = 'OK_CHANNEL';

function isDesktopProductName(value: string): value is DesktopProductName {
  return Object.hasOwn(DESKTOP_PRODUCTS, value);
}

export function desktopChannelLabel(channel: string): string {
  if (channel === 'stable') return `${PRODUCT_NAME} (Stable)`;
  return isDesktopProductName(channel)
    ? DESKTOP_PRODUCTS[channel].productName
    : `${PRODUCT_NAME} (${channel})`;
}

function executableBaseName(execPath: string): string {
  return (execPath.split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '');
}

export function resolveDesktopProductName(
  env: Record<string, string | undefined> = globalThis.process?.env ?? {},
  execPath: string = globalThis.process?.execPath ?? '',
): DesktopProductName {
  const override = env[OK_CHANNEL_ENV]?.trim().toLowerCase();
  if (override) {
    if (isDesktopProductName(override)) return override;
    throw new Error(
      `Unsupported ${OK_CHANNEL_ENV}=${JSON.stringify(override)}. Expected ${Object.keys(DESKTOP_PRODUCTS).join(' or ')}.`,
    );
  }
  const exe = executableBaseName(execPath);
  for (const name of Object.keys(DESKTOP_PRODUCTS) as DesktopProductName[]) {
    if (name === 'stable') continue;
    const product = DESKTOP_PRODUCTS[name];
    if (
      exe === product.linuxExecutableName ||
      exe === product.productName ||
      exe.startsWith(`${product.productName} `)
    ) {
      return name;
    }
  }
  return 'stable';
}

export function currentDesktopProduct(): DesktopProduct {
  return DESKTOP_PRODUCTS[resolveDesktopProductName()];
}

export function currentMcpServerName(): DesktopProduct['mcpServerName'] {
  return currentDesktopProduct().mcpServerName;
}
