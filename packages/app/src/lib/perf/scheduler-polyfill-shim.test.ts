// Verifies the GoogleChromeLabs `scheduler-polyfill` IIFE installs
// `globalThis.scheduler.yield()` after side-effect import. Bun's runtime has
// no native `scheduler` (mirrors Safari/older-Firefox), so importing the shim
// runs the full polyfill install branch.
//
// We do NOT retest the polyfill's internal scheduling semantics here — that's
// the polyfill's own contract. We verify our wiring: after `import
// './scheduler-polyfill-shim'`, the consumer (mount-promise.ts at the
// construction-mount yield-point) sees a callable `scheduler.yield()`.

import { describe, expect, test } from 'bun:test';
import './scheduler-polyfill-shim';

describe('scheduler-polyfill-shim install side-effect', () => {
  test('scheduler is defined after shim import', () => {
    expect(typeof scheduler).toBe('object');
    expect(scheduler).not.toBeNull();
  });

  test('scheduler.yield is a function', () => {
    expect(typeof scheduler.yield).toBe('function');
  });

  test('scheduler.postTask is a function', () => {
    expect(typeof scheduler.postTask).toBe('function');
  });

  test('TaskController is a constructor', () => {
    expect(typeof TaskController).toBe('function');
    const controller = new TaskController();
    expect(controller.signal).toBeDefined();
    expect(typeof controller.abort).toBe('function');
  });

  test('scheduler.yield() returns a Promise', () => {
    const result = scheduler.yield();
    expect(result).toBeInstanceOf(Promise);
  });

  test('scheduler.yield() resolves under the test runner event loop', async () => {
    await scheduler.yield();
  });
});
