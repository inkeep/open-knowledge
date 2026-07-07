/**
 * Unit tests for the perf-scenario CLI driver — focused on the launch-mode
 * defaults that drive multi-cell sweeps.
 *
 * Why these tests exist: a multi-minute headed sweep that loses foreground
 * focus mid-run hits Chromium's setTimeout/rAF throttle (>1 s per tick),
 * which stretches effect-driven editor mounts past the scenario timeout and
 * shows up as "cold-load failed" on cells that render in well under 2 s
 * when run headless. The default landing on headless eliminates that
 * failure mode for sweeps; explicit `--headed` (or `OK_PERF_HEADED=1`)
 * opts back in for paint/GPU diagnosis on a single-scenario run.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { parseArgs } from './profile';

describe('parseArgs — launch-mode defaults', () => {
  // process.env mutations leak across tests within a file unless reset.
  let originalHeaded: string | undefined;
  beforeEach(() => {
    originalHeaded = process.env.OK_PERF_HEADED;
    delete process.env.OK_PERF_HEADED;
  });
  afterEach(() => {
    if (originalHeaded === undefined) delete process.env.OK_PERF_HEADED;
    else process.env.OK_PERF_HEADED = originalHeaded;
  });

  test('default: headed=false (sweeps run headless to dodge focus-loss throttling)', () => {
    const args = parseArgs(['--scenario=foo']);
    expect(args.headed).toBe(false);
  });

  test('explicit --headed overrides the default', () => {
    const args = parseArgs(['--scenario=foo', '--headed']);
    expect(args.headed).toBe(true);
  });

  test('explicit --headless still works (idempotent with default)', () => {
    const args = parseArgs(['--scenario=foo', '--headless']);
    expect(args.headed).toBe(false);
  });

  test('OK_PERF_HEADED=1 env var enables headed mode', () => {
    process.env.OK_PERF_HEADED = '1';
    const args = parseArgs(['--scenario=foo']);
    expect(args.headed).toBe(true);
  });

  test('OK_PERF_HEADED with non-"1" value does NOT enable headed', () => {
    // Conservative env-var contract: only the literal "1" enables headed.
    // Empty string, "true", "yes", and "0" all stay headless to avoid
    // false-positive activation from typos.
    process.env.OK_PERF_HEADED = 'true';
    expect(parseArgs(['--scenario=foo']).headed).toBe(false);
    process.env.OK_PERF_HEADED = '0';
    expect(parseArgs(['--scenario=foo']).headed).toBe(false);
    process.env.OK_PERF_HEADED = '';
    expect(parseArgs(['--scenario=foo']).headed).toBe(false);
  });

  test('explicit --headless overrides OK_PERF_HEADED=1', () => {
    // Precedence: explicit flag > env var. Lets a developer who set the
    // env in their shell still force a headless run for one scenario
    // without unsetting the env.
    process.env.OK_PERF_HEADED = '1';
    const args = parseArgs(['--scenario=foo', '--headless']);
    expect(args.headed).toBe(false);
  });

  test('explicit --headed with OK_PERF_HEADED unset still works', () => {
    const args = parseArgs(['--scenario=foo', '--headed']);
    expect(args.headed).toBe(true);
  });
});
