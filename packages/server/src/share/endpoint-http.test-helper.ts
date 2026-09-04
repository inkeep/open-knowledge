import { createServer, type Server } from 'node:http';

export interface EndpointRig {
  port: number;
  cleanup: () => Promise<void>;
}

export async function bootEndpointServer(opts: {
  projectDir: string;
  contentDir?: string;
}): Promise<EndpointRig> {
  const { projectDir } = opts;
  const contentDir = opts.contentDir ?? projectDir;

  const { Hocuspocus } = await import('@hocuspocus/server');
  const { AgentSessionManager } = await import('../agent-sessions.ts');
  const { createApiExtension } = await import('../api-extension.test-helper.ts');

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
