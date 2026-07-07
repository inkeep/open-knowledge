/**
 * Boot the real HTTP API extension (the Hocuspocus `onRequest` pipeline) rooted
 * at a caller-provided `projectDir`, on a loopback-bound ephemeral port.
 *
 * This is the reusable half of construct-url.test.ts's `bootRig`. The difference
 * that matters: `bootRig` manufactures a synthetic `projectDir` and seeds a fake
 * `.git` (enough for the branch-level URL gates, which never touch a real
 * remote). The share-receive endpoints — target-status and branch-info — run an
 * actual credentialed `git fetch` and remote-tracking-ref probes, so they need a
 * REAL git working tree. Callers pass one (a `createGitTriangle` receiver clone
 * or sender) and drive the endpoints over HTTP against it.
 */
import { createServer, type Server } from 'node:http';

export interface EndpointRig {
  port: number;
  cleanup: () => Promise<void>;
}

/**
 * Boot the API extension against `projectDir`. `contentDir` defaults to
 * `projectDir` (the dominant `content.dir === '.'` layout, which is what the
 * git-triangle fixtures produce). Binds 127.0.0.1 explicitly so the OS picks a
 * port free on the family the client uses — a bare `listen(0)` binds dual-stack
 * `::` and can collide with a foreign v4 listener under parallel load (the same
 * reasoning `bootRig` documents).
 */
export async function bootEndpointServer(opts: {
  projectDir: string;
  contentDir?: string;
}): Promise<EndpointRig> {
  const { projectDir } = opts;
  const contentDir = opts.contentDir ?? projectDir;

  const { Hocuspocus } = await import('@hocuspocus/server');
  const { AgentSessionManager } = await import('../agent-sessions.ts');
  const { createApiExtension } = await import('../api-extension.ts');

  const hocuspocus = new Hocuspocus({ quiet: true });
  const sessionManager = new AgentSessionManager(hocuspocus);
  const ext = createApiExtension({
    hocuspocus,
    sessionManager,
    contentDir,
    projectDir,
    getFileIndex: () => new Map(),
    serverInstanceId: 'test-instance',
  });
  hocuspocus.configuration.extensions.push(ext);

  const server: Server = createServer((req, res) => {
    // biome-ignore lint/suspicious/noExplicitAny: test harness
    hocuspocus.hooks('onRequest', { request: req, response: res } as any).catch(() => {
      if (!res.writableEnded) {
        res.writeHead(500);
        res.end('Error');
      }
    });
  });

  const port = await new Promise<number>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolveListen(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });

  return {
    port,
    cleanup: async () => {
      await new Promise<void>((res) => server.close(() => res()));
    },
  };
}
