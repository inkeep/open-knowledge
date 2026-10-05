export const TEST_SERVER_STARTUP_ENV = 'OK_TEST_VITE_START_REQUEST';
export const TEST_SERVER_IDENTITY_PATH = '/__ok-test-server-identity';
export const TEST_SERVER_CANDIDATE_PORTS = { start: 49152, end: 57344 } as const;
export const TEST_SERVER_HOST_FAMILY = {
  '127.0.0.1': 'IPv4',
  '::1': 'IPv6',
} as const satisfies Record<string, 'IPv4' | 'IPv6'>;

type TestServerHost = keyof typeof TEST_SERVER_HOST_FAMILY;

export function isTestServerHost(value: unknown): value is TestServerHost {
  return typeof value === 'string' && Object.hasOwn(TEST_SERVER_HOST_FAMILY, value);
}

export interface TestServerStartupRequest {
  nonce: string;
  host: TestServerHost;
  candidatePort: number;
  receiptPath: string;
}

export interface TestServerStartupReceipt {
  nonce: string;
  address: string;
  family: (typeof TEST_SERVER_HOST_FAMILY)[TestServerHost];
  port: number;
}
