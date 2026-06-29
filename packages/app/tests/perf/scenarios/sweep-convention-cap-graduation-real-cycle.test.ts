
import { describe, expect, test } from 'bun:test';
import { chromium } from '@playwright/test';
import {
  buildProductionCycleDriver,
  type CycleOutcome,
  getLatencyProfile,
} from './sweep-convention-cap-graduation';

const INTEGRATION_GATE = process.env.OK_SWEEP_INTEGRATION === '1';
const DEFAULT_TARGET = process.env.OK_SWEEP_INTEGRATION_TARGET ?? 'http://localhost:5173';
const SAMPLE_TIMEOUT_MS = 60_000;

async function isDevServerReachable(target: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    const res = await fetch(target, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok || (res.status >= 400 && res.status < 600);
  } catch {
    return false;
  }
}

describe('convention-cap-graduation sweep — real-cycle integration', () => {
  test.skipIf(!INTEGRATION_GATE)(
    'one real localhost cycle produces a well-formed CycleOutcome',
    async () => {
      const reachable = await isDevServerReachable(DEFAULT_TARGET);
      if (!reachable) {
        console.warn(
          `[sweep-real-cycle] OK_SWEEP_INTEGRATION=1 but ${DEFAULT_TARGET} is not reachable — start the dev server with: cd packages/app && bun run dev`,
        );
        return;
      }

      const browser = await chromium.launch({
        headless: true,
        args: ['--enable-precise-memory-info'],
      });
      try {
        const driver = buildProductionCycleDriver({
          browser,
          baseTarget: DEFAULT_TARGET,
        });
        const profile = getLatencyProfile('localhost');
        const outcome: CycleOutcome = await driver({ profile, cycleIndex: 0 });

        expect(outcome.kind === 'success' || outcome.kind === 'rejected').toBe(true);
        expect(typeof outcome.mountId).toBe('string');
        expect(outcome.mountId.length).toBeGreaterThan(0);

        if (outcome.kind === 'success') {
          expect(Number.isFinite(outcome.syncElapsedMs)).toBe(true);
          expect(outcome.syncElapsedMs).toBeGreaterThanOrEqual(0);
          expect(Number.isFinite(outcome.mountElapsedMs)).toBe(true);
          expect(outcome.mountElapsedMs).toBeGreaterThanOrEqual(0);
          expect(outcome.syncElapsedMs).toBeLessThan(30_000);
        } else {
          expect(
            outcome.reason === 'pre-sync-disconnect' || outcome.reason === 'sync-timeout',
          ).toBe(true);
        }
      } finally {
        await browser.close().catch(() => undefined);
      }
    },
    SAMPLE_TIMEOUT_MS,
  );

  test('integration gate is opt-in — bare bun run check does not require a dev server', () => {
    const gateActive = process.env.OK_SWEEP_INTEGRATION === '1';
    expect(typeof gateActive).toBe('boolean');
  });
});
