const SHARE_URL_VERSION_V1 = 0x01;

export interface DecodedShare {
  version: number;
  sharedUrl: string;
}

export class UnsupportedShareVersionError extends Error {
  readonly version: number;
  constructor(version: number) {
    super(`Unsupported share URL version: 0x${version.toString(16).padStart(2, '0')}`);
    this.name = 'UnsupportedShareVersionError';
    this.version = version;
  }
}

export class InvalidShareUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidShareUrlError';
  }
}

export function encodeShareUrl(sharedUrl: string): string {
  const blobBytes = new TextEncoder().encode(sharedUrl);
  const bytes = new Uint8Array(1 + blobBytes.length);
  bytes[0] = SHARE_URL_VERSION_V1;
  bytes.set(blobBytes, 1);
  return uint8ArrayToBase64Url(bytes);
}

export function decodeShareUrl(encoded: string): DecodedShare {
  const cleaned = encoded.split(/[?#]/)[0];
  if (cleaned.length === 0) {
    throw new InvalidShareUrlError('Share payload is empty');
  }

  let bytes: Uint8Array;
  try {
    bytes = base64UrlToUint8Array(cleaned);
  } catch {
    throw new InvalidShareUrlError('Share payload is not valid base64url');
  }

  if (bytes.length === 0) {
    throw new InvalidShareUrlError('Share payload is empty');
  }

  const version = bytes[0];
  if (version !== SHARE_URL_VERSION_V1) {
    throw new UnsupportedShareVersionError(version);
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  let sharedUrl: string;
  try {
    sharedUrl = decoder.decode(bytes.subarray(1));
  } catch {
    throw new InvalidShareUrlError('Share payload body is not valid UTF-8');
  }

  return { version, sharedUrl };
}

function uint8ArrayToBase64Url(bytes: Uint8Array): string {
  let binaryString = '';
  for (let i = 0; i < bytes.length; i++) {
    binaryString += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binaryString);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToUint8Array(input: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) {
    throw new Error('Input contains non-base64url characters');
  }
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binaryString = atob(padded);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
