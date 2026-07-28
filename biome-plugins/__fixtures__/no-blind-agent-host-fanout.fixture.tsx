/**
 * Fixture for `no-blind-agent-host-fanout.grit`.
 *
 * Pairs 5 positive cases (the `skills` CLI npm specs OK used to shell out to,
 * plus the bare `--agent` argv token whose `'*'` value caused issue #820 —
 * plugin MUST fire) with negative cases (an unrelated `'skills'` word, a
 * similarly-spelled flag, a comment mention, a template literal, and a
 * concatenation — plugin must NOT fire). The fixture-file test asserts the
 * diagnostic count with exact equality (`toBe(5)`) so both a weakened pattern
 * (drops below 5) and a widened pattern that catches a negative (rises above 5)
 * fail the gate.
 *
 * The template-literal and concatenation negatives are the honest precision
 * boundary: GritQL matches the string-literal node, so a spec assembled at
 * runtime slips through. That is a defeatable-on-purpose escape, not an
 * accidental reintroduction — the behavioural backstop is the filesystem
 * assertion in `packages/server/src/skill-install.test.ts` ("never creates a
 * dotdir for a host that is not installed").
 *
 * Deliberately NOT linted by the main `pnpm lint` pass (biome-plugins/ is
 * outside the lint paths); only the scoped override in biome.jsonc reaches it,
 * via the fixture-file test.
 */

declare const range: string;
declare function spawn(cmd: string, args: readonly string[]): void;

function positives() {
  // P1-P4: every npm spec shape for the `skills` CLI OK used to fetch-and-exec.
  spawn('npx', ['-y', 'skills@~1.5.0', 'add', '.']);
  spawn('npx', ['-y', 'skills@^1.5.0', 'add', '.']);
  spawn('npx', ['-y', 'skills@1.5.0', 'add', '.']);
  spawn('npx', ['-y', 'skills@latest', 'add', '.']);
  // P5: the flag itself — the incident was its `'*'` value, but the flag only
  // exists to address that CLI, so the token is the reintroduction signal.
  spawn('npx', ['add', '.', '--agent', '*']);
}

function negatives() {
  // N1: the bare word, unrelated to the npm spec.
  spawn('ok', ['skills', 'list']);
  // N2-N3: similarly-spelled flags that are not the banned token.
  spawn('ok', ['--agents', 'claude']);
  spawn('ok', ['--agent-id', 'abc']);
  // N4: a comment mentioning `npx skills@~1.5.0 add --agent '*'` — GritQL
  // matches string-literal nodes, never trivia, so prose describing the old
  // invocation (as the real module's docstring does) must stay silent.
  spawn('ok', ['repair-skills']);
  // N5: interpolation — no single node holds the whole value.
  spawn('npx', [`skills@${range}`, 'add', '.']);
  // N6: concatenation — likewise.
  spawn('npx', [`skills@${''}${range}`, 'add', '.']);
}

export { positives, negatives };
