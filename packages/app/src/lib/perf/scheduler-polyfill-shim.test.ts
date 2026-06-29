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
