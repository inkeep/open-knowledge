import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { APP_PACKAGE_ROOT } from '../seed-key.ts';
import { REUSE_SOCKET_ENV } from './lease-protocol.ts';
import { launchOwnedDevServer } from './owned-dev-server.ts';
import { WorkerServerSupervisor } from './server-supervisor.ts';
import { connectLeaseClient, serveSupervisor } from './supervisor-socket.ts';

const OK_ROOT = realpathSync(join(APP_PACKAGE_ROOT, '..', '..'));
const SUPERVISOR_CALL_MS = 60_000;
const IDENTITY_TIMEOUT_MS = 5_000;

export const DEFAULT_SUPERVISOR_SOCKET = join(
  tmpdir(),
  `ok-e2e-reuse-${createHash('sha256').update(OK_ROOT).digest('hex').slice(0, 12)}`,
  'supervisor.sock',
);

const USAGE = `usage: node tests/stress/_helpers/reuse/reuse-supervisor.ts <serve|status|shutdown> [--socket <path>] [--until-stdin-closes]

serve     owns one dev server per Playwright worker slot and leases it to successive runs
          that set ${REUSE_SOCKET_ENV} to its socket; runs until shutdown, SIGINT/SIGTERM or,
          with --until-stdin-closes, until its owner closes its stdin; exits 0 once it has
          released every owned server, or 1 when a release failed, naming each on stderr
status    prints the slots, their servers and current holders
shutdown  asks the serving supervisor to release every owned server and stop; exits 0 once
          the supervisor accepts the request, before any release runs, so whether the
          releases succeeded is the serving supervisor's own exit status

The default socket is ${DEFAULT_SUPERVISOR_SOCKET}`;

async function main(argv: readonly string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { socket: { type: 'string' }, 'until-stdin-closes': { type: 'boolean' } },
  });
  const socketPath = values.socket ?? DEFAULT_SUPERVISOR_SOCKET;
  switch (positionals[0]) {
    case 'serve': {
      const supervisor = new WorkerServerSupervisor({
        okRoot: OK_ROOT,
        launch: launchOwnedDevServer,
        identityTimeoutMs: IDENTITY_TIMEOUT_MS,
      });
      const endpoint = await serveSupervisor(supervisor, socketPath);
      process.once('SIGINT', () => void endpoint.close());
      process.once('SIGTERM', () => void endpoint.close());
      if (values['until-stdin-closes'] === true) {
        process.stdin.once('end', () => void endpoint.close());
        process.stdin.resume();
      }
      process.stdout.write(`${REUSE_SOCKET_ENV}=${socketPath}\n`);
      const closed = await endpoint.closed;
      process.stdin.destroy();
      return closed.released ? 0 : 1;
    }
    case 'status': {
      const client = await connectLeaseClient(socketPath, IDENTITY_TIMEOUT_MS);
      try {
        process.stdout.write(
          `${JSON.stringify(await client.status(SUPERVISOR_CALL_MS), null, 2)}\n`,
        );
      } finally {
        client.close();
      }
      return 0;
    }
    case 'shutdown': {
      const client = await connectLeaseClient(socketPath, IDENTITY_TIMEOUT_MS);
      try {
        await client.shutdown(SUPERVISOR_CALL_MS);
      } finally {
        client.close();
      }
      return 0;
    }
    default:
      process.stderr.write(`${USAGE}\n`);
      return 2;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
