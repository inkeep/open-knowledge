import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const okRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CORE = '@inkeep/open-knowledge-core';
const SOURCE_CONDITION = "condition '@inkeep/source'";

function trace(cwd: string, args: string[]): string {
  const run = spawnSync('pnpm', ['exec', 'tsc', '--noEmit', '--traceResolution', ...args], {
    cwd: path.join(okRoot, cwd),
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if ((run.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS') {
    throw new Error(
      `the trace from ${cwd} exceeded the 512 MiB capture buffer, so it was truncated and nothing below read a complete resolution log. Raise maxBuffer or narrow the traced project rather than reading a partial trace as a verdict.`,
    );
  }
  if (run.error) {
    throw new Error(`tsc could not be run in ${cwd}: ${run.error.message}`);
  }
  if (run.signal) {
    throw new Error(
      `tsc was killed by ${run.signal} in ${cwd} before it finished tracing, so this trace proves nothing about how ${CORE} resolved. That is a harness or budget fault, not a resolution defect.`,
    );
  }
  if (run.status !== 0) {
    const diagnostics = output.split('\n').filter((line) => /error TS\d+/.test(line));
    throw new Error(
      `tsc exited ${run.status} in ${cwd}, so this trace proves nothing about how ${CORE} resolved. ` +
        `${diagnostics.length} diagnostic(s):\n${diagnostics.join('\n')}\n` +
        `A compile that fails here is a defect in what the build config reads, most often a sibling dist that is absent or whose emitted declarations mis-classify an export. Rebuild the siblings and read the diagnostics above before touching this test.`,
    );
  }
  return output;
}

function coreResolutions(output: string): string[] {
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('======== Resolving module ')) {
      current = line.includes(`'${CORE}`) ? [line] : null;
      continue;
    }
    if (current === null) continue;
    current.push(line);
    if (line.startsWith('======== Module name ')) {
      blocks.push(current.join('\n'));
      current = null;
    }
  }
  return blocks;
}

describe('D13 resolution truth: a leaf typecheck reads source, the published build reads declarations', () => {
  it('resolves every core import in a leaf typecheck through @inkeep/source, onto core/src', () => {
    const blocks = coreResolutions(trace('packages/server', []));
    expect(blocks.length).toBeGreaterThan(0);

    for (const block of blocks) {
      expect(block).toContain(`Matched 'exports' ${SOURCE_CONDITION}`);
      expect(block).toMatch(/was successfully resolved to '[^']*\/packages\/core\/src\/[^']*\.ts'/);
    }
  }, 90_000);

  it('clears @inkeep/source for the CLI declaration build, landing on core/dist declarations', () => {
    const blocks = coreResolutions(trace('packages/cli', ['-p', 'tsconfig.build.json']));
    expect(blocks.length).toBeGreaterThan(0);

    for (const block of blocks) {
      expect(block).toContain(`Saw non-matching ${SOURCE_CONDITION}`);
      expect(block).not.toContain(`Matched 'exports' ${SOURCE_CONDITION}`);
      expect(block).toMatch(
        /was successfully resolved to '[^']*\/packages\/core\/dist\/[^']*\.d\.mts'/,
      );
    }
  }, 90_000);
});
