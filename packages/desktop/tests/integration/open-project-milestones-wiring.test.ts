import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const indexTsPath = resolve(fileURLToPath(new URL('../../src/main/index.ts', import.meta.url)));
const indexSource = readFileSync(indexTsPath, 'utf-8');

function openProjectBody(): { lines: string[]; start: number } {
  const lines = indexSource.split('\n');
  const start = lines.findIndex((l) => l.startsWith('async function openProject('));
  if (start === -1) throw new Error('openProject not found in index.ts');
  const end = lines.findIndex((l, i) => i > start && l === '}');
  if (end === -1) throw new Error('openProject close brace not found');
  return { lines: lines.slice(start, end + 1), start };
}

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

      const payloadLines = body
        .slice(ownerAt, at + 1)
        .filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l));
      const arms: string[][] = [[]];
      let depth = 0;
      for (const line of payloadLines) {
        if (depth === 0 && /^\s*[?:]\s/.test(line)) arms.push([]);
        arms[arms.length - 1]?.push(line);
        depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
      }
      const payloadArms = arms.length > 1 ? arms.slice(1) : arms;
      const unnamedArms = payloadArms
        .filter((arm) => !/\bprojectName\b|\b(?:resolved)?[Pp]ickedName\b/.test(arm.join('\n')))
        .map((arm) => arm.join(' ').replace(/\s+/g, ' ').trim().slice(0, 80));
      expect({ message, unnamedArms }).toEqual({ message, unnamedArms: [] });
    }
  });

  test(`no run of more than ${MAX_SILENT_RUN} code lines is free of a milestone`, () => {
    const code = body
      .map((line, bodyIndex) => ({ line, bodyIndex }))
      .filter(({ line }) => line.trim() !== '' && !/^\s*(?:\/\/|\*|\/\*)/.test(line));
    const emittingLines: number[] = [];
    code.forEach(({ line }, i) => {
      if (FUNNEL_MILESTONES.some((m) => line.includes(`'${m}'`))) emittingLines.push(i);
    });
    expect(emittingLines.length).toBe(FUNNEL_MILESTONES.length);

    const marks = [0, ...emittingLines, code.length - 1];
    const runs = marks.slice(1).map((at, i) => ({ lines: at - (marks[i] ?? 0), endsAt: at }));
    const worst = runs.reduce((a, b) => (b.lines > a.lines ? b : a));

    const startsAt = bodyStart + (code[worst.endsAt - worst.lines]?.bodyIndex ?? 0) + 1;
    expect(
      worst.lines,
      `worst milestone-free run is ${worst.lines} code lines, starting around index.ts:${startsAt}`,
    ).toBeLessThanOrEqual(MAX_SILENT_RUN);
  });
});
