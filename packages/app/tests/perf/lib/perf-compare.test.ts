/**
 * Unit tests for the perf-compare.sh diff tool.
 *
 * Strategy: write two synthetic baseline JSONs to a tmpdir, invoke the
 * shell script via Bun's spawn, and assert the markdown table emitted on
 * stdout matches expectations.
 *
 * What we pin:
 *   - Direction tagging: latency-down → IMPROVED, latency-up → REGRESSED.
 *   - Variance threshold: changes within ±N% emit UNCHANGED.
 *   - Per-row missing-side handling: rows present in only one baseline are
 *     emitted with `(missing from)` or `(missing to)` notes (not crashes).
 *   - Help text via --help exits 64.
 *   - Malformed JSON exits 1; missing file exits 2.
 *   - Filters: --scenario / --doc narrow the table to matching rows.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dir, '..', '..', '..', 'scripts', 'perf-compare.sh');

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(resolve(tmpdir(), 'perf-compare-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface BaselineDoc {
  [metric: string]: { p50: number; p95?: number; runs?: number[] };
}
interface BaselineScenario {
  docs: Record<string, BaselineDoc>;
}
interface Baseline {
  label?: string;
  capturedAt?: string;
  commitSha?: string;
  runCount?: number;
  scenarios: Record<string, BaselineScenario>;
  notes?: string[];
}

function writeBaseline(filename: string, body: Baseline): string {
  const path = resolve(tmp, filename);
  writeFileSync(path, JSON.stringify(body, null, 2));
  return path;
}

async function runScript(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bash', SCRIPT, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

describe('perf-compare.sh — argument validation', () => {
  test('--help prints usage and exits 64', async () => {
    const { exitCode, stdout } = await runScript(['--help']);
    expect(exitCode).toBe(64);
    expect(stdout).toContain('Usage: perf-compare.sh');
  });

  test('missing --from exits 2', async () => {
    const { exitCode, stderr } = await runScript(['--to', 'whatever.json']);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('--from and --to are required');
  });

  test('non-existent --from file exits 2', async () => {
    const to = writeBaseline('to.json', { scenarios: {} });
    const { exitCode, stderr } = await runScript([
      '--from',
      resolve(tmp, 'does-not-exist.json'),
      '--to',
      to,
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('not found');
  });

  test('malformed --from JSON exits 1', async () => {
    const bad = resolve(tmp, 'bad.json');
    writeFileSync(bad, 'not valid json {{{');
    const to = writeBaseline('to.json', { scenarios: {} });
    const { exitCode, stderr } = await runScript(['--from', bad, '--to', to]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('malformed JSON');
  });
});

describe('perf-compare.sh — direction tagging', () => {
  test('latency-down emits IMPROVED', async () => {
    const from = writeBaseline('from.json', {
      scenarios: {
        'cold-pool-warm': {
          docs: {
            PROJECT: { coldPoolWarmMs: { p50: 9400 } },
          },
        },
      },
    });
    const to = writeBaseline('to.json', {
      scenarios: {
        'cold-pool-warm': {
          docs: {
            PROJECT: { coldPoolWarmMs: { p50: 1100 } },
          },
        },
      },
    });
    const { exitCode, stdout } = await runScript(['--from', from, '--to', to]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('IMPROVED');
    expect(stdout).toContain('cold-pool-warm');
    expect(stdout).toContain('PROJECT');
    expect(stdout).toContain('coldPoolWarmMs');
  });

  test('latency-up emits REGRESSED', async () => {
    const from = writeBaseline('from.json', {
      scenarios: {
        'cold-pool-warm': { docs: { PROJECT: { coldPoolWarmMs: { p50: 1000 } } } },
      },
    });
    const to = writeBaseline('to.json', {
      scenarios: {
        'cold-pool-warm': { docs: { PROJECT: { coldPoolWarmMs: { p50: 2000 } } } },
      },
    });
    const { exitCode, stdout } = await runScript(['--from', from, '--to', to]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('REGRESSED');
  });

  test('within ±5% threshold emits UNCHANGED', async () => {
    const from = writeBaseline('from.json', {
      scenarios: { s: { docs: { D: { latencyMs: { p50: 1000 } } } } },
    });
    const to = writeBaseline('to.json', {
      scenarios: { s: { docs: { D: { latencyMs: { p50: 1020 } } } } }, // +2%
    });
    const { exitCode, stdout } = await runScript(['--from', from, '--to', to]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('UNCHANGED');
    expect(stdout).not.toContain('REGRESSED');
  });

  test('non-Ms metric: higher is better → up emits IMPROVED', async () => {
    // e.g. throughput counter: higher = improvement.
    const from = writeBaseline('from.json', {
      scenarios: { s: { docs: { D: { fireCount: { p50: 100 } } } } },
    });
    const to = writeBaseline('to.json', {
      scenarios: { s: { docs: { D: { fireCount: { p50: 200 } } } } },
    });
    const { exitCode, stdout } = await runScript(['--from', from, '--to', to]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('IMPROVED');
  });
});

describe('perf-compare.sh — missing rows', () => {
  test('row in from but not to → emits `(missing to)` note', async () => {
    const from = writeBaseline('from.json', {
      scenarios: { s: { docs: { D: { onlyFromMs: { p50: 100 } } } } },
    });
    const to = writeBaseline('to.json', { scenarios: { s: { docs: {} } } });
    const { exitCode, stdout } = await runScript(['--from', from, '--to', to]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('missing to');
    expect(stdout).toContain('onlyFromMs');
  });

  test('row in to but not from → emits `(missing from)` note', async () => {
    const from = writeBaseline('from.json', { scenarios: { s: { docs: {} } } });
    const to = writeBaseline('to.json', {
      scenarios: { s: { docs: { D: { onlyToMs: { p50: 200 } } } } },
    });
    const { exitCode, stdout } = await runScript(['--from', from, '--to', to]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('missing from');
  });
});

describe('perf-compare.sh — filters', () => {
  test('--scenario narrows to one scenario', async () => {
    const from = writeBaseline('from.json', {
      scenarios: {
        'cold-pool-warm': { docs: { PROJECT: { coldMs: { p50: 1000 } } } },
        'mode-toggle': { docs: { PROJECT: { toggleMs: { p50: 100 } } } },
      },
    });
    const to = writeBaseline('to.json', {
      scenarios: {
        'cold-pool-warm': { docs: { PROJECT: { coldMs: { p50: 500 } } } },
        'mode-toggle': { docs: { PROJECT: { toggleMs: { p50: 50 } } } },
      },
    });
    const { exitCode, stdout } = await runScript([
      '--from',
      from,
      '--to',
      to,
      '--scenario',
      'cold-pool-warm',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('cold-pool-warm');
    expect(stdout).not.toContain('mode-toggle');
  });

  test('--doc narrows to one doc', async () => {
    const from = writeBaseline('from.json', {
      scenarios: {
        s: { docs: { PROJECT: { mMs: { p50: 1 } }, AGENTS: { mMs: { p50: 1 } } } },
      },
    });
    const to = writeBaseline('to.json', {
      scenarios: {
        s: { docs: { PROJECT: { mMs: { p50: 2 } }, AGENTS: { mMs: { p50: 2 } } } },
      },
    });
    const { exitCode, stdout } = await runScript(['--from', from, '--to', to, '--doc', 'PROJECT']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('PROJECT');
    expect(stdout).not.toContain('AGENTS');
  });
});

describe('perf-compare.sh — output table shape', () => {
  test('emits markdown header row', async () => {
    const from = writeBaseline('from.json', {
      scenarios: { s: { docs: { D: { latencyMs: { p50: 100 } } } } },
    });
    const to = writeBaseline('to.json', {
      scenarios: { s: { docs: { D: { latencyMs: { p50: 110 } } } } },
    });
    const { stdout } = await runScript(['--from', from, '--to', to]);
    expect(stdout).toContain('| Scenario | Doc | Metric |');
    expect(stdout).toContain('|---|');
  });
});
