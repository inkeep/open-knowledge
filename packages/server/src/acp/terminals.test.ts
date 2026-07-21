import type { ThreadEvent } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { afterEach, describe, expect, test } from 'vitest';
import { getLogger } from '../logger.ts';
import { AcpTerminalSet } from './terminals.ts';

const log = getLogger('acp-terminals-test');

let sets: AcpTerminalSet[] = [];
function makeSet(events: ThreadEvent[]): AcpTerminalSet {
  const set = new AcpTerminalSet({
    defaultCwd: process.cwd(),
    emit: (event) => events.push(event),
    log,
  });
  sets.push(set);
  return set;
}
afterEach(async () => {
  await Promise.allSettled(sets.map((s) => s.disposeAll()));
  sets = [];
});

function node(code: string): { command: string; args: string[] } {
  return { command: process.execPath, args: ['-e', code] };
}

describe('AcpTerminalSet', () => {
  test('runs a command: output captured, exit 0, transcript events in order', async () => {
    const events: ThreadEvent[] = [];
    const set = makeSet(events);
    const { terminalId } = set.create(node("process.stdout.write('hello from terminal')"));
    const status = await set.waitForExit(terminalId);
    expect(status).toEqual({ exitCode: 0, signal: null });

    const out = set.output(terminalId);
    expect(out.output).toBe('hello from terminal');
    expect(out.truncated).toBe(false);
    expect(out.exitStatus).toEqual({ exitCode: 0, signal: null });

    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe('terminal_created');
    expect(kinds).toContain('terminal_output');
    expect(kinds[kinds.length - 1]).toBe('terminal_exit');
    const created = events[0];
    if (created.kind !== 'terminal_created') throw new Error('unreachable');
    expect(created.terminalId).toBe(terminalId);
    expect(created.command).toBe(process.execPath);
  });

  test('captures stderr interleaved and a non-zero exit code', async () => {
    const events: ThreadEvent[] = [];
    const set = makeSet(events);
    const { terminalId } = set.create(node("process.stderr.write('boom'); process.exit(3)"));
    const status = await set.waitForExit(terminalId);
    expect(status.exitCode).toBe(3);
    expect(set.output(terminalId).output).toContain('boom');
    const exit = events[events.length - 1];
    if (exit.kind !== 'terminal_exit') throw new Error('unreachable');
    expect(exit.exitCode).toBe(3);
    expect(exit.signal).toBeNull();
  });

  test('front-truncates retained output at outputByteLimit', async () => {
    const events: ThreadEvent[] = [];
    const set = makeSet(events);
    const { terminalId } = set.create({
      ...node("process.stdout.write('a'.repeat(500) + 'TAIL-MARKER')"),
      outputByteLimit: 128,
    });
    await set.waitForExit(terminalId);
    const out = set.output(terminalId);
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.output, 'utf8')).toBeLessThanOrEqual(128);
    expect(out.output.endsWith('TAIL-MARKER')).toBe(true);
  });

  test('front-truncation lands on a character boundary (multi-byte safe)', async () => {
    const events: ThreadEvent[] = [];
    const set = makeSet(events);
    // 3-byte characters against a limit that is not a multiple of 3 forces a
    // mid-character cut the trimmer must repair.
    const { terminalId } = set.create({
      ...node("process.stdout.write('\\u3042'.repeat(200))"),
      outputByteLimit: 100,
    });
    await set.waitForExit(terminalId);
    const out = set.output(terminalId);
    expect(out.truncated).toBe(true);
    expect(out.output).not.toContain('�');
    expect([...out.output].every((ch) => ch === 'あ')).toBe(true);
  });

  test('kill terminates a long-running command; output stays readable', async () => {
    const events: ThreadEvent[] = [];
    const set = makeSet(events);
    const { terminalId } = set.create(
      node("process.stdout.write('started'); setInterval(() => {}, 1000)"),
    );
    // Wait for the process to prove it is alive before killing it.
    const deadline = Date.now() + 5_000;
    while (!set.output(terminalId).output.includes('started')) {
      if (Date.now() > deadline) throw new Error('command never produced output');
      await new Promise((r) => setTimeout(r, 25));
    }
    await set.kill(terminalId);
    const status = await set.waitForExit(terminalId);
    expect(status.exitCode === null || status.exitCode !== 0).toBe(true);
    // Killed but not released: output must remain retrievable.
    expect(set.output(terminalId).output).toContain('started');
    await set.release(terminalId);
    expect(() => set.output(terminalId)).toThrow('unknown terminal');
  });

  test('waitForExit resolves for an already-exited terminal', async () => {
    const events: ThreadEvent[] = [];
    const set = makeSet(events);
    const { terminalId } = set.create(node('process.exit(0)'));
    await set.waitForExit(terminalId);
    // Second wait after exit settles immediately from the recorded status.
    const again = await set.waitForExit(terminalId);
    expect(again.exitCode).toBe(0);
  });

  test('a nonexistent command surfaces as exit 127 with the error in output', async () => {
    const events: ThreadEvent[] = [];
    const set = makeSet(events);
    const { terminalId } = set.create({ command: '/definitely/not/a/real/binary' });
    const status = await set.waitForExit(terminalId);
    expect(status.exitCode).toBe(127);
    expect(set.output(terminalId).output.length).toBeGreaterThan(0);
  });

  test('pauses transcript emission past the cap and replays the tail on exit', async () => {
    const events: ThreadEvent[] = [];
    const set = makeSet(events);
    // Spew well past the 256 KiB transcript cap, then end with a marker that
    // only the exit-time tail replay can carry into the transcript.
    const { terminalId } = set.create(
      node(
        "for (let i = 0; i < 40; i++) process.stdout.write('x'.repeat(8192)); process.stdout.write('FINAL-MARKER');",
      ),
    );
    await set.waitForExit(terminalId);
    const chunks = events.filter(
      (e): e is Extract<ThreadEvent, { kind: 'terminal_output' }> => e.kind === 'terminal_output',
    );
    const transcriptBytes = chunks.reduce((n, c) => n + Buffer.byteLength(c.chunk, 'utf8'), 0);
    // Live budget (256 KiB) + one bounded tail replay (16 KiB + marker line).
    expect(transcriptBytes).toBeLessThan(300 * 1024);
    expect(chunks[chunks.length - 1]?.chunk).toContain('FINAL-MARKER');
    expect(chunks.some((c) => c.chunk.includes('[output truncated'))).toBe(true);
  });

  test('the exit-time tail replay never repeats bytes the live stream carried', async () => {
    const events: ThreadEvent[] = [];
    const set = makeSet(events);
    // Exactly fill the 256 KiB live budget with x's, then one small unique
    // suffix that trips the pause — the replay must carry ONLY the suffix.
    const { terminalId } = set.create(
      node(
        "for (let i = 0; i < 32; i++) process.stdout.write('x'.repeat(8192)); setTimeout(() => { process.stdout.write('UNIQUE-SUFFIX'); }, 50);",
      ),
    );
    await set.waitForExit(terminalId);
    const chunks = events.filter(
      (e): e is Extract<ThreadEvent, { kind: 'terminal_output' }> => e.kind === 'terminal_output',
    );
    const joined = chunks.map((c) => c.chunk).join('');
    expect(joined.split('UNIQUE-SUFFIX')).toHaveLength(2);
    // No 16 KiB duplication block: total ≈ live budget + marker + suffix.
    expect(Buffer.byteLength(joined, 'utf8')).toBeLessThan(256 * 1024 + 200);
  });

  test('rejects terminal creation past the per-thread cap', async () => {
    const events: ThreadEvent[] = [];
    const set = makeSet(events);
    const ids: string[] = [];
    for (let i = 0; i < 64; i++) {
      ids.push(set.create(node('process.exit(0)')).terminalId);
    }
    expect(() => set.create(node('process.exit(0)'))).toThrow('terminal limit');
    // Releasing frees a slot.
    await set.waitForExit(ids[0]);
    await set.release(ids[0]);
    expect(() => set.create(node('process.exit(0)'))).not.toThrow();
  });

  test('disposeAll kills every live terminal', async () => {
    const events: ThreadEvent[] = [];
    const set = makeSet(events);
    const a = set.create(node('setInterval(() => {}, 1000)'));
    const b = set.create(node('setInterval(() => {}, 1000)'));
    expect(set.liveCount()).toBe(2);
    const exits = Promise.all([set.waitForExit(a.terminalId), set.waitForExit(b.terminalId)]);
    await set.disposeAll();
    await exits;
    expect(set.liveCount()).toBe(0);
  });
});
