import { randomUUID } from 'node:crypto';
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { isAbsolute } from 'node:path';
import type { Plugin } from 'vite';

import {
  isTestServerHost,
  TEST_SERVER_CANDIDATE_PORTS,
  TEST_SERVER_HOST_FAMILY,
  TEST_SERVER_IDENTITY_PATH,
  TEST_SERVER_STARTUP_ENV,
  type TestServerStartupReceipt,
  type TestServerStartupRequest,
} from './test-server-startup-contract';

export function parseTestServerStartupRequest(
  raw: string | undefined,
): TestServerStartupRequest | undefined {
  if (raw === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${TEST_SERVER_STARTUP_ENV} is not valid JSON`, { cause: error });
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${TEST_SERVER_STARTUP_ENV} is not a JSON object`);
  }
  const request = value as Record<string, unknown>;
  if (
    typeof request.nonce !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request.nonce)
  ) {
    throw new Error(`${TEST_SERVER_STARTUP_ENV} nonce is not a lowercase UUID`);
  }
  if (!isTestServerHost(request.host)) {
    throw new Error(
      `${TEST_SERVER_STARTUP_ENV} host is not one of ${Object.keys(TEST_SERVER_HOST_FAMILY).join(', ')}`,
    );
  }
  if (
    typeof request.candidatePort !== 'number' ||
    !Number.isInteger(request.candidatePort) ||
    request.candidatePort < TEST_SERVER_CANDIDATE_PORTS.start ||
    request.candidatePort >= TEST_SERVER_CANDIDATE_PORTS.end
  ) {
    throw new Error(
      `${TEST_SERVER_STARTUP_ENV} candidatePort is not an integer from ${TEST_SERVER_CANDIDATE_PORTS.start} to ${TEST_SERVER_CANDIDATE_PORTS.end - 1}`,
    );
  }
  if (typeof request.receiptPath !== 'string' || !isAbsolute(request.receiptPath)) {
    throw new Error(`${TEST_SERVER_STARTUP_ENV} receiptPath is not an absolute path`);
  }
  return {
    nonce: request.nonce,
    host: request.host,
    candidatePort: request.candidatePort,
    receiptPath: request.receiptPath,
  };
}

function boundReceipt(
  request: TestServerStartupRequest,
  address: string | AddressInfo | null,
): TestServerStartupReceipt {
  if (
    typeof address !== 'object' ||
    address === null ||
    address.address !== request.host ||
    address.family !== TEST_SERVER_HOST_FAMILY[request.host]
  ) {
    throw new Error('automatic Vite startup bound an unexpected address');
  }
  return {
    nonce: request.nonce,
    address: address.address,
    family: TEST_SERVER_HOST_FAMILY[request.host],
    port: address.port,
  };
}

export function testServerStartupPlugin(request: TestServerStartupRequest): Plugin {
  return {
    name: 'ok:test-server-startup',
    apply: 'serve',
    configureServer(server) {
      const httpServer = server.httpServer;
      if (httpServer === null) {
        throw new Error('automatic Vite startup needs an HTTP server');
      }
      if (server.config.server.host !== request.host) {
        throw new Error('automatic Vite startup host differs from its request');
      }
      server.middlewares.use(TEST_SERVER_IDENTITY_PATH, (_req, res) => {
        const receipt = boundReceipt(request, httpServer.address());
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(receipt));
      });
      httpServer.once('listening', () => {
        const receipt = boundReceipt(request, httpServer.address());
        if (existsSync(request.receiptPath)) {
          throw new Error('automatic Vite startup receipt already exists');
        }
        const temporaryPath = `${request.receiptPath}.${process.pid}.${randomUUID()}`;
        try {
          writeFileSync(temporaryPath, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
          renameSync(temporaryPath, request.receiptPath);
        } finally {
          rmSync(temporaryPath, { force: true });
        }
      });
    },
  };
}
