import { Hocuspocus } from '@hocuspocus/server';
import { defineConfig, type Plugin } from 'vite';
import { WebSocketServer } from 'ws';
import {
  TEST_SERVER_IDENTITY_PATH,
  TEST_SERVER_STARTUP_ENV,
} from '../../../src/build/test-server-startup-contract';
import {
  parseTestServerStartupRequest,
  testServerStartupPlugin,
} from '../../../src/build/test-server-startup-plugin';
import {
  CONTRACT_SERVER_EXCLUSIVE_RESOURCE_ENV,
  CONTRACT_SERVER_EXIT_PATH,
  CONTRACT_SERVER_FAIL_READINESS_PATH,
  CONTRACT_SERVER_FORGE_PATH,
  CONTRACT_SERVER_GENERATION_PATH,
  CONTRACT_SERVER_RESTART_PATH,
  type ContractServerReadinessCheck,
  isContractServerReadinessCheck,
} from './contract-dev-server-routes';

const request = parseTestServerStartupRequest(process.env[TEST_SERVER_STARTUP_ENV]);
if (request === undefined) {
  throw new Error(`the contract dev server needs ${TEST_SERVER_STARTUP_ENV}`);
}

const RESTART_PORT = Symbol.for('ok:contract-server:restart-port');
const GENERATION = Symbol.for('ok:contract-server:generation');
const EXCLUSIVE_RESOURCE_HELD = Symbol.for('ok:contract-server:exclusive-resource-held');
const contractProcess = globalThis as {
  [RESTART_PORT]?: number;
  [GENERATION]?: number;
  [EXCLUSIVE_RESOURCE_HELD]?: boolean;
};

const EMPTY_SERVER_RESET_RESIDUE = {
  loadedDocuments: [],
  clientConnections: 0,
  agentSessions: 0,
  agentPresence: [],
  staleExternalWrites: [],
  removedDocuments: [],
};

function contractControl(): Plugin {
  let forged = false;
  return {
    name: 'ok:contract-server-control',
    apply: 'serve',
    configureServer(server) {
      const generation = (contractProcess[GENERATION] ?? 0) + 1;
      contractProcess[GENERATION] = generation;
      server.middlewares.use(CONTRACT_SERVER_GENERATION_PATH, (_req, res) => {
        res.end(String(generation));
      });
      server.middlewares.use(CONTRACT_SERVER_RESTART_PATH, (req, res) => {
        const port = new URL(req.url ?? '/', 'http://contract').searchParams.get('port');
        if (port !== null) contractProcess[RESTART_PORT] = Number(port);
        res.end('restarting');
        res.once('finish', () => {
          server.restart().catch((error: unknown) => {
            process.stderr.write(`contract dev server restart failed: ${String(error)}\n`);
          });
        });
      });
      server.middlewares.use(CONTRACT_SERVER_EXIT_PATH, (_req, res) => {
        res.end('exiting');
        res.once('finish', () => process.exit(0));
      });
      server.middlewares.use(CONTRACT_SERVER_FORGE_PATH, (_req, res) => {
        forged = true;
        res.end('forged');
      });
      server.middlewares.use(TEST_SERVER_IDENTITY_PATH, (_req, res, next) => {
        if (!forged) {
          next();
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ nonce: 'forged-identity' }));
      });
    },
  };
}

function contractReadiness(): Plugin {
  const failing = new Set<ContractServerReadinessCheck>();
  const hocuspocus = new Hocuspocus({ quiet: true });
  const sockets = new WebSocketServer({ noServer: true });
  return {
    name: 'ok:contract-server-readiness',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(CONTRACT_SERVER_FAIL_READINESS_PATH, (req, res) => {
        const check = (req.url ?? '').slice(1);
        if (!isContractServerReadinessCheck(check)) {
          res.statusCode = 404;
          res.end(`no readiness check ${check}`);
          return;
        }
        failing.add(check);
        res.end(`failing ${check}`);
      });
      server.middlewares.use('/api/config', (_req, res) => {
        const address = server.httpServer?.address();
        if (failing.has('api-config') || typeof address !== 'object' || address === null) {
          res.statusCode = 503;
          res.end();
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ port: address.port, collabUrl: null }));
      });
      server.middlewares.use('/api/test-reset', (req, res) => {
        const scope = new URL(req.url ?? '/', 'http://contract').searchParams.get('scope');
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify(
            scope === 'server'
              ? { scope: 'server', residue: EMPTY_SERVER_RESET_RESIDUE }
              : { scope: 'document' },
          ),
        );
      });
      server.httpServer?.on('upgrade', (req, socket, head) => {
        if (!req.url?.startsWith('/collab')) return;
        if (failing.has('collab')) {
          socket.destroy();
          return;
        }
        sockets.handleUpgrade(req, socket, head, (ws) => {
          const connection = hocuspocus.handleConnection(ws, req as unknown as Request);
          ws.on('message', (data: Buffer) => connection.handleMessage(new Uint8Array(data)));
          ws.on('close', (code: number, reason: Buffer) =>
            connection.handleClose({ code, reason: reason.toString() }),
          );
        });
      });
    },
  };
}

function contractExclusiveResource(): Plugin {
  return {
    name: 'ok:contract-server-exclusive-resource',
    apply: 'serve',
    configureServer(server) {
      if (contractProcess[EXCLUSIVE_RESOURCE_HELD] === true) {
        throw new Error('the contract exclusive resource is held by a running server');
      }
      contractProcess[EXCLUSIVE_RESOURCE_HELD] = true;
      server.httpServer?.once('close', () => {
        contractProcess[EXCLUSIVE_RESOURCE_HELD] = false;
      });
    },
  };
}

export default defineConfig({
  root: process.cwd(),
  appType: 'custom',
  clearScreen: false,
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [
    contractControl(),
    contractReadiness(),
    ...(process.env[CONTRACT_SERVER_EXCLUSIVE_RESOURCE_ENV] === '1'
      ? [contractExclusiveResource()]
      : []),
    testServerStartupPlugin(request),
  ],
  server: {
    port: contractProcess[RESTART_PORT] ?? request.candidatePort,
    strictPort: false,
    watch: null,
  },
});
