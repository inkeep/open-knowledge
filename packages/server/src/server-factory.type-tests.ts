import type { ServerInstance } from './server-factory.ts';

declare const server: ServerInstance;

// @ts-expect-error — readonly array: push is not allowed
server.degraded.push('test');

// @ts-expect-error — readonly field: reassignment is not allowed
server.degraded = [];
