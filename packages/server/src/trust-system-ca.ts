import tls from 'node:tls';
import { getLogger } from './logger.ts';

let applied = false;

export function trustSystemCertificates(): void {
  if (applied) return;
  const api = tls as unknown as {
    getCACertificates?: (type?: 'default' | 'system' | 'bundled' | 'extra') => string[];
    setDefaultCACertificates?: (certs: readonly string[]) => void;
  };
  if (
    typeof api.getCACertificates !== 'function' ||
    typeof api.setDefaultCACertificates !== 'function'
  ) {
    applied = true;
    return;
  }
  try {
    api.setDefaultCACertificates([
      ...api.getCACertificates('default'),
      ...api.getCACertificates('system'),
    ]);
    applied = true;
  } catch (err) {
    getLogger('trust-system-ca').warn(
      { err },
      'system CA setup failed; falling back to the bundled CA set',
    );
  }
}

export function _resetTrustSystemCertificatesForTest(): void {
  applied = false;
}
