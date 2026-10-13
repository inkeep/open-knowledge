import type { ServerResponse } from 'node:http';
import { TEST_LOOP_CORE_MARKER, TEST_LOOP_SERVER_MARKER } from '@inkeep/open-knowledge-server';
import type { Connect, Plugin } from 'vite';
import { TEST_LOOP_MARKERS_PATH } from './test-loop-marker-contract';

function serveLoopMarkers(
  request: Connect.IncomingMessage,
  response: ServerResponse,
  next: Connect.NextFunction,
): void {
  if (request.method !== 'GET' || request.url !== TEST_LOOP_MARKERS_PATH) {
    next();
    return;
  }
  response.statusCode = 200;
  response.setHeader('content-type', 'application/json');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify({ server: TEST_LOOP_SERVER_MARKER, core: TEST_LOOP_CORE_MARKER }));
}

export function testLoopMarkerPlugin(): Plugin {
  return {
    name: 'ok-test-loop-markers',
    configureServer(server) {
      server.middlewares.use(serveLoopMarkers);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serveLoopMarkers);
    },
  };
}
