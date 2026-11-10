import { basename } from 'node:path';
import {
  currentDesktopProduct,
  DESKTOP_PRODUCTS,
  type DesktopProduct,
  resolveDesktopProductName,
} from '@inkeep/open-knowledge-core/constants/product';

export const PACKAGED_APP_ENV = 'OK_DESKTOP_PACKAGED_APP';

export function smokeDesktopProduct(): DesktopProduct {
  const appPath = process.env[PACKAGED_APP_ENV];
  return appPath
    ? DESKTOP_PRODUCTS[resolveDesktopProductName({}, basename(appPath, '.app'))]
    : currentDesktopProduct();
}
