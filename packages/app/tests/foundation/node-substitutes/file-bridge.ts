import {
  type BridgeHostFacts,
  FILE_BRIDGE_ROUTE,
  type FileBridgeOperation,
} from './file-bridge-contract';

const ERRNO_PREFIX = /^(E[A-Z]+):/;

type BridgeError = Error & { code: string; path: string };

export function bridgeCall(operation: FileBridgeOperation, path = ''): string {
  const request = new XMLHttpRequest();
  request.open(
    'GET',
    `${FILE_BRIDGE_ROUTE}?op=${operation}&path=${encodeURIComponent(path)}`,
    false,
  );
  request.send();
  if (request.status === 200) return request.responseText;
  const error = new Error(request.responseText) as BridgeError;
  error.code = ERRNO_PREFIX.exec(request.responseText)?.[1] ?? 'EIO';
  error.path = path;
  throw error;
}

let facts: BridgeHostFacts | undefined;

export function hostFacts(): BridgeHostFacts {
  facts ??= JSON.parse(bridgeCall('host')) as BridgeHostFacts;
  return facts;
}

export function readOnly(operation: string): () => never {
  return () => {
    throw new Error(
      `node:fs.${operation} is not available in the browser tier: the file bridge is read-only`,
    );
  };
}
