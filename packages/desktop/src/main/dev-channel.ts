import {
  DESKTOP_PRODUCTS,
  defaultToDevChannel,
  resolveDesktopProductName,
} from '@inkeep/open-knowledge-core/constants/product';

export function applyUnpackagedDevChannel(
  env: Record<string, string | undefined>,
  isPackaged: boolean,
): void {
  if (isPackaged || env.OK_DESKTOP_E2E_SMOKE === '1') return;
  defaultToDevChannel(env);
}

export function desktopProtocolScheme(
  isPackaged: boolean,
  variantScheme: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return isPackaged
    ? variantScheme
    : DESKTOP_PRODUCTS[resolveDesktopProductName(env)].protocolScheme;
}
