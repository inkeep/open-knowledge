import { posix as pathPosix } from 'node:path';
import { PRODUCT_NAME } from './constants/product.ts';

function helperBundleName(productName: string): string {
  return `${productName} Server.app`;
}

function helperExecutableName(productName: string): string {
  return `${productName} Helper`;
}

export const HELPER_BUNDLE_NAME = helperBundleName(PRODUCT_NAME);
export const HELPER_EXECUTABLE_NAME = helperExecutableName(PRODUCT_NAME);

export function resolveHelperBundleBinary(parentExecPath: string): string {
  const productName = pathPosix.basename(parentExecPath);
  return pathPosix.join(
    pathPosix.dirname(parentExecPath),
    '..',
    'Frameworks',
    helperBundleName(productName),
    'Contents',
    'MacOS',
    helperExecutableName(productName),
  );
}
