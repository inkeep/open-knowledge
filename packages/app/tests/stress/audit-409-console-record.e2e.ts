import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
// STOP: import test/expect from '@playwright/test', not the _helpers barrel, whose extended test resolves baseURL from the worker-scoped workerServer fixture and boots a Vite + Hocuspocus stack this probe never uses.
import { expect, test } from '@playwright/test';
import {
  AUDIT_CONSOLE_RECORD_CASES,
  chromiumResourceFailureRecord,
  type LogEntry,
} from './_helpers';

const PROBE_PAGE = '<!doctype html><html><body><div id="probe">probe</div></body></html>';
const CONSOLE_RECORD_TIMEOUT_MS = 5_000;
const WORK_OUTSIDE_POLLS_BUDGET_MS = 30_000;
const TEST_TIMEOUT_MS =
  AUDIT_CONSOLE_RECORD_CASES.length * CONSOLE_RECORD_TIMEOUT_MS + WORK_OUTSIDE_POLLS_BUDGET_MS;

const describeServerError = (error: Error): string => error.stack ?? String(error);

test('real Chromium emits the console records the shared fixtures describe', async ({
  browser,
}) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const byPath = new Map(AUDIT_CONSOLE_RECORD_CASES.map((entry) => [entry.path, entry]));
  const server = createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PROBE_PAGE);
      return;
    }
    const hit = byPath.get(req.url ?? '');
    if (hit) {
      res.writeHead(hit.status);
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('missing');
  });

  let serverError: Error | undefined;
  server.on('error', (error) => {
    serverError = error;
    process.stderr.write(`probe-server-error: ${describeServerError(error)}\n`);
  });
  await new Promise<void>((resolve, reject) => {
    const onBindError = (error: Error) => reject(error);
    server.once('error', onBindError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onBindError);
      resolve();
    });
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const captured: LogEntry[] = [];
  try {
    const page = await browser.newPage();
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const location = msg.location();
      captured.push({
        type: 'error',
        text: msg.text(),
        url: location.url,
        line: location.lineNumber,
      });
    });

    try {
      await page.goto(`${origin}/`);

      for (const entry of AUDIT_CONSOLE_RECORD_CASES) {
        expect(serverError, 'the probe server must not have emitted an error').toBeUndefined();
        const priorRecords = captured.length;
        const served = await page.evaluate(async (path) => (await fetch(path)).status, entry.path);
        expect(served, `${entry.label} must be served as ${entry.status}`).toBe(entry.status);
        await expect
          .poll(
            () =>
              captured
                .slice(priorRecords)
                .some((record) => record.url === `${origin}${entry.path}`),
            {
              message: `${entry.label} must produce a console record`,
              timeout: CONSOLE_RECORD_TIMEOUT_MS,
            },
          )
          .toBe(true);
      }

      const apiRecords = captured.filter((record) => record.url?.startsWith(`${origin}/api/`));
      const expected = AUDIT_CONSOLE_RECORD_CASES.map((entry) =>
        chromiumResourceFailureRecord(origin, entry),
      );
      expect(
        apiRecords,
        'real Chromium must emit exactly the records the shared fixtures describe',
      ).toEqual(expected);
    } finally {
      await page.close();
    }
  } finally {
    if (serverError !== undefined) {
      test.info().annotations.push({
        type: 'probe-server-error',
        description: describeServerError(serverError),
      });
    }
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }

  expect(serverError, 'the probe server must not have emitted an error').toBeUndefined();
});
