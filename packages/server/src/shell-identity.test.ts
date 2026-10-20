import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import sirv from 'sirv';
import { expect, test, vi } from 'vitest';
import { createShellHeaderSetter } from './http/shell-csp.ts';
import { closeTestHttpServer } from './http-server.test-helper.ts';

test.for([false, true])(
  'selects the served HTML policy with inode collision=%s',
  async (collision, { onTestFinished, signal }) => {
    const scratch = resolve(import.meta.dirname, '../tmp');
    fs.mkdirSync(scratch, { recursive: true });
    const root = fs.mkdtempSync(join(scratch, 'shell-identity-'));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    const first = join(root, 'index.html');
    const second = join(root, 'other.html');
    const script = 'window.first = 1;';
    const html = `<script>${script}</script>`;
    fs.writeFileSync(first, html);
    fs.writeFileSync(second, '<script>window.other = 2;</script>');
    const stamp = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(first, stamp, stamp);
    fs.utimesSync(second, stamp, stamp);
    const original = fs.statSync;
    const statOverride = vi.spyOn(fs, 'statSync');
    onTestFinished(() => {
      statOverride.mockRestore();
      syncBuiltinESMExports();
    });
    const observed = new Set<string>();
    statOverride.mockImplementation((...args: Parameters<typeof fs.statSync>) => {
      const result = original(...args);
      const path = String(args[0]);
      if (result !== undefined && (path === first || path === second)) {
        observed.add(path);
        const exact = collision
          ? path === first
            ? 9851624185071827n
            : 9851624185071829n
          : path === first
            ? 11n
            : 13n;
        const numeric = collision ? 9851624185071828 : path === first ? 11 : 13;
        Object.defineProperty(result, 'ino', {
          value: typeof result.ino === 'bigint' ? exact : numeric,
        });
      }
      return result;
    });
    syncBuiltinESMExports();
    const serve = sirv(root, {
      dev: true,
      single: true,
      setHeaders: createShellHeaderSetter(root),
    });
    const server = createServer((req, res) => serve(req, res));
    let pending: Promise<void> | undefined;
    onTestFinished(async () => {
      try {
        await closeTestHttpServer(server);
      } finally {
        await Promise.allSettled([pending]);
      }
    });
    pending = (async () => {
      const listening = once(server, 'listening', { signal });
      server.listen({ port: 0, host: '127.0.0.1' });
      await listening;
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('No HTTP address');
      for (const pathname of ['/', '/nested/fallback']) {
        const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, { signal });
        expect(await response.text()).toBe(html);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(html)));
        expect(response.headers.get('last-modified')).toBe(stamp.toUTCString());
        expect(observed).toEqual(new Set([first, second]));
        expect(response.headers.get('content-security-policy')).toContain(
          `'sha256-${createHash('sha256').update(script).digest('base64')}'`,
        );
      }
    })();
    await pending;
  },
);
