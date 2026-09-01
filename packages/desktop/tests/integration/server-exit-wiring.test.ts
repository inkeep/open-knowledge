import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const indexTsPath = resolve(fileURLToPath(new URL('../../src/main/index.ts', import.meta.url)));
const src = readFileSync(indexTsPath, 'utf-8');

const FIX = (what: string): string =>
  `\n[server-exit] ${what}\n\n` +
  `The packaged build spawns the project server with plain child_process.spawn, which no other\n` +
  `mechanism observes: app.on('child-process-gone') guards on details.type === 'Utility' (structurally\n` +
  `unreachable for an ordinary OS process) and the utilityProcess exit handler that records the death in\n` +
  `dev never runs. Without this wiring every packaged bug report is missing last-server-exit.json — the\n` +
  `one file that answers "did the server crash, or was it shut down on purpose". The full rationale is\n` +
  `in the header of packages/desktop/src/main/server-exit-observer.ts.\n`;

describe('packaged detached-server exit wiring (bypass-pin)', () => {
  test('index.ts registers the exit observer on the spawned child, exactly once', () => {
    const calls = src.match(/attachServerExitObserver\s*\(\s*childRef\b/g) ?? [];
    expect(
      calls.length,
      FIX(
        `index.ts has ${calls.length} \`attachServerExitObserver(childRef, …)\` call(s); expected exactly 1.`,
      ),
    ).toBe(1);
  });

  test('the observer records through the shared recorder singleton', () => {
    const wiring =
      /attachServerExitObserver\s*\([\s\S]{0,600}?getServerExitRecorder\(\)\.recordExit/;
    expect(
      src,
      FIX('the exit observer no longer records through getServerExitRecorder().'),
    ).toMatch(wiring);
  });

  test('the observer logs on the server-exit subsystem', () => {
    const wiring = /attachServerExitObserver\s*\([\s\S]{0,600}?getLogger\(['"]server-exit['"]\)/;
    expect(src, FIX("the exit observer's logger is no longer getLogger('server-exit').")).toMatch(
      wiring,
    );
  });

  test('the listener is still registered before unref()', () => {
    const attachAt = src.indexOf('attachServerExitObserver(childRef');
    const unrefAt = src.indexOf('childRef.unref()');
    expect(unrefAt, FIX('childRef.unref() call not found.')).toBeGreaterThan(-1);
    expect(attachAt, FIX('the exit observer is registered after unref().')).toBeLessThan(unrefAt);
  });
});
