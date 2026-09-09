import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const indexTsPath = resolve(fileURLToPath(new URL('../../src/main/index.ts', import.meta.url)));
const src = readFileSync(indexTsPath, 'utf-8');

const FIX = (what: string): string =>
  `\n[terminal-consent] ${what}\n\n` +
  `isTerminalConsented is the main-process backstop for the terminal, and since PRD-8498 it is\n` +
  `read at two gates: the ok:pty:create handler, and canSpawnAt, which the manager consults\n` +
  `immediately before it posts the deferred spawn. Requiring canSpawnAt makes a DROPPED wiring a\n` +
  `compile error; this pin covers the substitution that still type-checks — a literal true, a\n` +
  `cached boolean, or a different predicate — which would silently restore shells for a user who\n` +
  `set terminal.enabled: false. See the corrigendum at specs/2026-06-17-terminal-usability/SPEC.md\n` +
  `and the ok:pty:* protocol paragraph in packages/desktop/README.md.\n`;

describe('terminal consent spawn-gate wiring (bypass-pin)', () => {
  test('canSpawnAt is isTerminalConsented over the caller-supplied root, with nothing appended', () => {
    const wiring =
      /canSpawnAt:\s*(?:isTerminalConsented\s*[,}]|\(\s*(\w+)\s*\)\s*=>\s*isTerminalConsented\(\s*\1\s*\)\s*[,}])/g;
    expect(
      (src.match(wiring) ?? []).length,
      FIX(
        'index.ts no longer wires canSpawnAt straight through to isTerminalConsented, or appended a disjunct to it.',
      ),
    ).toBe(1);
  });

  test('the ok:pty:create handler refuses on withdrawn consent before it reaches the manager', () => {
    const createGate =
      /if\s*\(\s*!isTerminalConsented\(\s*(\w+)\s*\)\s*&&\s*!\(\s*await\s+isTerminalConsentedWithGrace\(\s*\1\s*\)\s*\)\s*\)\s*\{/g;
    const gates = src.match(createGate) ?? [];
    expect(
      gates.length,
      FIX('index.ts no longer gates ok:pty:create on isTerminalConsented.'),
    ).toBe(1);

    const gateAt = src.indexOf(gates[0] ?? '\u0000');
    const refusalAt = src.indexOf("return { ok: false, reason: 'not-consented' };", gateAt);
    const createAt = src.indexOf('terminalManager.create(', gateAt);
    expect(
      refusalAt,
      FIX('the consent gate no longer refuses with reason not-consented.'),
    ).toBeGreaterThan(-1);
    expect(
      createAt,
      FIX('the consent gate is no longer followed by terminalManager.create.'),
    ).toBeGreaterThan(-1);
    expect(
      refusalAt,
      FIX('the consent refusal no longer precedes terminalManager.create.'),
    ).toBeLessThan(createAt);
  });
});
