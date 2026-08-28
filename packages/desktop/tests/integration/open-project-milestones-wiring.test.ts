/**
 * Bypass-pin — `openProject`'s admission funnel must still emit a milestone
 * per branch decision and per expensive step.
 *
 * The bug class is "a long stretch of the funnel emits no diagnostic line, so
 * a hang or a silent death anywhere inside it produces a byte-identical
 * bundle." Every intermediate diagnostic in that span is a `console.warn`,
 * which the packaged main process discards, so the milestones are the only
 * record that survives to a user-attached bundle.
 *
 * Runtime coverage cannot reach this: `index.ts` is a ~9k-line module that
 * binds real Electron at module scope and runs top-level side effects, so no
 * test in the package imports it. Same posture and rationale as the
 * bypass-pins in `server-exit-wiring.test.ts` and `dock-visibility.test.ts`,
 * which guard the spawn closure in the same file.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const indexTsPath = resolve(fileURLToPath(new URL('../../src/main/index.ts', import.meta.url)));
const indexSource = readFileSync(indexTsPath, 'utf-8');

/**
 * Lines of `openProject`'s body. The function is top-level in a
 * Biome-formatted file, so the first column-0 `}` after its signature is its
 * close. A truncated slice fails the presence assertions loudly rather than
 * passing vacuously, which is what makes the anchor safe to rely on.
 */
function openProjectBody(): { lines: string[]; start: number } {
  const lines = indexSource.split('\n');
  const start = lines.findIndex((l) => l.startsWith('async function openProject('));
  if (start === -1) throw new Error('openProject not found in index.ts');
  const end = lines.findIndex((l, i) => i > start && l === '}');
  if (end === -1) throw new Error('openProject close brace not found');
  return { lines: lines.slice(start, end + 1), start };
}

/**
 * Milestones in the order the funnel reaches them. Source order is a valid
 * proxy for execution order because the branches are textually exclusive and
 * laid out in funnel order: the confirmation branch precedes the fresh-consent
 * branch, and both precede the window fork.
 *
 * Two of them hold for a different reason. `probing ancestor size` and
 * `resolving git root` are emitted from the `dirSizeProbe` and `gitTopLevel`
 * callbacks, whose DEFINITIONS sit inline in the `await discoverProject`
 * call between the two milestones that bracket it. They are invoked from
 * `folder-admission.ts` during that same await, so source order remains a
 * valid execution-order proxy -- but only while those closures stay inline.
 * Extracting either to a module-level helper is a breaking change for this
 * guard: runtime behavior would be identical, yet the message would leave
 * `openProject`'s body slice and redden both the presence check and the
 * exactly-once count below.
 */
const FUNNEL_MILESTONES = [
  'opening project',
  'resolving project admission',
  'probing ancestor size',
  'resolving git root',
  'project admission resolved',
  'project admission confirmation requested',
  'project admission confirmation answered',
  'awaiting navigator load',
  'onboarding consent requested',
  'onboarding consent answered',
  'ensuring project git',
  'ensured project git',
  'initializing project content',
  'initialized project content',
  'project artifacts written',
  'reclaiming project skills',
  'creating project window',
  'project window created',
] as const;

/**
 * Largest run of consecutive CODE lines allowed without a funnel milestone.
 *
 * A coarse smoke alarm, not the load-bearing assertion — presence, order and
 * ownership are. Line count only proxies for "unbounded work is unbracketed",
 * and a few lines of new `await` inside a run still slip under it. Comment and
 * blank lines are excluded so the margin means code, and prose churn cannot
 * redden it.
 *
 * The rule, not just the endpoints: the cap is the current worst run rounded
 * up to roughly 1.2x, so a single added block trips it. That is 62 code lines
 * today, hence 75. Re-derive it whenever the metric or the milestone set
 * changes, or the guard silently loosens while reading as if it tightened:
 * excluding comment and blank lines drops roughly 18 lines from the worst run
 * on its own, so a cap carried over unchanged widens the margin instead of
 * holding it. For scale: 283 code lines before the milestones existed, one
 * uninterrupted stretch from the entry log to the window-created log. The
 * worst run today spans the managed-open skill reclaim and the
 * `recordOnboardingFlow` call that follows it.
 */
const MAX_SILENT_RUN = 75;

describe('openProject admission funnel milestones (bypass-pin)', () => {
  const { lines: body, start: bodyStart } = openProjectBody();

  test.each(FUNNEL_MILESTONES)('emits the %s milestone', (message) => {
    expect(body.join('\n')).toContain(`'${message}'`);
  });

  test('milestones appear in funnel order', () => {
    const text = body.join('\n');
    const positions = FUNNEL_MILESTONES.map((m) => text.indexOf(`'${m}'`));
    const outOfOrder = FUNNEL_MILESTONES.filter((_m, i) => {
      const previous = positions[i - 1];
      const current = positions[i];
      return i > 0 && previous !== undefined && current !== undefined && current < previous;
    });
    expect(outOfOrder).toEqual([]);
  });

  test('every milestone is emitted by the project pino logger, not a console sink', () => {
    for (const message of FUNNEL_MILESTONES) {
      const at = body.findIndex((l) => l.includes(`'${message}'`));
      expect({ message, present: at !== -1 }).toEqual({ message, present: true });

      // Walk back to the call this message is an argument of, capturing the
      // METHOD as well as the subsystem. Two downgrades read as instrumented
      // here while emitting nothing in the build the bundles come from, and
      // both must redden: moving a milestone to console.warn (the packaged
      // main process discards that sink) and dropping it below the logger's
      // default level, since resolveLogLevel returns 'info' outside tests.
      let owner: string | null = null;
      let ownerAt = at;
      for (let i = at; i >= 0 && i > at - 40; i--) {
        const line = body[i] ?? '';
        const call = line.match(/getLogger\('([^']+)'\)\.(\w+)\(/);
        if (call) {
          owner = `${call[1]}.${call[2]}`;
          ownerAt = i;
          break;
        }
        if (/\bconsole\.(warn|log|error)\(/.test(line)) {
          owner = 'console';
          ownerAt = i;
          break;
        }
      }
      expect({ message, owner }).toEqual({ message, owner: 'project.info' });

      // Every milestone must carry a correlating name. `openProject` has no
      // single-flight guard, so two interleaved opens (a rapid Recents
      // double-click, a deep link racing boot restore) otherwise produce lines
      // attributable to neither. Nothing else here reads the payload, so a
      // milestone simplified to a bare message would pass every other check.
      // Code lines only: a comment inside the call that happens to name a key
      // would otherwise satisfy this while the real payload carried nothing.
      const payloadLines = body
        .slice(ownerAt, at + 1)
        .filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l));
      // A ternary payload is TWO payloads, and testing them joined lets one
      // arm's identifier vouch for the other: that is how the `rejected` arm
      // of `project admission resolved` carried no name at all while this
      // check stayed green. Split only at brace depth 0, which is what
      // separates the payload-selecting ternary from the spread ternaries
      // inside a payload, whose arms are legitimately nameless.
      const arms: string[][] = [[]];
      let depth = 0;
      for (const line of payloadLines) {
        if (depth === 0 && /^\s*[?:]\s/.test(line)) arms.push([]);
        arms[arms.length - 1]?.push(line);
        depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
      }
      // Split happened => arms[0] is the call head and the condition, not a payload.
      const payloadArms = arms.length > 1 ? arms.slice(1) : arms;
      // The concept, not three literal spellings: a milestone correlates if it
      // names the resolved project or either form of the pick.
      const unnamedArms = payloadArms
        .filter((arm) => !/\bprojectName\b|\b(?:resolved)?[Pp]ickedName\b/.test(arm.join('\n')))
        // The arm's own text, not a count: a bare `1` says the funnel regressed
        // without saying which payload, which is the same misdirection the
        // silent-run message below exists to avoid. Bounded because a long
        // payload would bury the message it is attached to; the leading keys
        // are what identify the arm, and they survive the cut.
        .map((arm) => arm.join(' ').replace(/\s+/g, ' ').trim().slice(0, 80));
      expect({ message, unnamedArms }).toEqual({ message, unnamedArms: [] });
    }
  });

  test(`no run of more than ${MAX_SILENT_RUN} code lines is free of a milestone`, () => {
    // Code lines only: a milestone-free stretch of comment prose is not the
    // regression this guards, and counting it makes doc edits fail the gate.
    // The body index rides along, because every index below is into the
    // FILTERED array and the failure message has to name a line a maintainer
    // can actually open.
    const code = body
      .map((line, bodyIndex) => ({ line, bodyIndex }))
      .filter(({ line }) => line.trim() !== '' && !/^\s*(?:\/\/|\*|\/\*)/.test(line));
    const emittingLines: number[] = [];
    code.forEach(({ line }, i) => {
      if (FUNNEL_MILESTONES.some((m) => line.includes(`'${m}'`))) emittingLines.push(i);
    });
    // Each milestone must occur exactly once, or the run maths below is
    // measuring something other than the funnel (a duplicate, or a milestone
    // whose emitting call site is gone).
    expect(emittingLines.length).toBe(FUNNEL_MILESTONES.length);

    // Boundaries count: entry-to-first and last-to-close are silent runs too.
    const marks = [0, ...emittingLines, code.length - 1];
    const runs = marks.slice(1).map((at, i) => ({ lines: at - (marks[i] ?? 0), endsAt: at }));
    const worst = runs.reduce((a, b) => (b.lines > a.lines ? b : a));

    // The message argument reports the offending stretch on failure — a bare
    // numeric diff would say the funnel regressed without saying where.
    // Reported as an index.ts line, not a body offset: the whole point is to
    // spare a maintainer the hunt inside a 9k-line file.
    const startsAt = bodyStart + (code[worst.endsAt - worst.lines]?.bodyIndex ?? 0) + 1;
    expect(
      worst.lines,
      `worst milestone-free run is ${worst.lines} code lines, starting around index.ts:${startsAt}`,
    ).toBeLessThanOrEqual(MAX_SILENT_RUN);
  });
});
