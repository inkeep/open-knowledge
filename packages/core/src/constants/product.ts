export const DESKTOP_PRODUCTS = {
  stable: {
    appId: 'com.inkeep.open-knowledge',
    productName: 'OpenKnowledge',
    packageName: '@inkeep/open-knowledge-desktop',
    linuxExecutableName: 'openknowledge',
    linuxPackageNames: {
      deb: 'openknowledge',
      rpm: 'OpenKnowledge',
    },
  },
  beta: {
    appId: 'com.inkeep.open-knowledge.beta',
    productName: 'OpenKnowledge Beta',
    packageName: 'openknowledge-beta-desktop',
    linuxExecutableName: 'openknowledge-beta',
    linuxPackageNames: {
      deb: 'openknowledge-beta-desktop',
      rpm: 'openknowledge-beta-desktop',
    },
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
