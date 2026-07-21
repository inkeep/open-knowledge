import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const rendererHtml = readFileSync(join(import.meta.dir, '../../src/renderer/index.html'), 'utf8');

describe('renderer content security policy', () => {
  test('allows agent icons from the ACP registry CDN', () => {
    const csp = rendererHtml.match(/Content-Security-Policy" content="([^"]+)"/)?.[1];

    expect(csp).toBeDefined();
    expect(csp).toContain("img-src 'self' https://cdn.agentclientprotocol.com");
  });
});
