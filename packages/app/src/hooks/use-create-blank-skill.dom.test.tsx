/**
 * A blank create must never name itself against a list it does not have.
 *
 * `PUT /api/skill` is an upsert — verified against a live server, a second PUT
 * for an existing name returns `created: false` and replaces that skill's body
 * and description with whatever was sent. So the auto-name loop deciding
 * `new-skill` is free is not a cosmetic guess: paired with the upsert it
 * destroys a real skill's contents, under a toast that says "created".
 *
 * The loop used to read the hook's skills list and treat "not ready yet" as
 * "nothing is taken", which is exactly the state right after the app opens —
 * the moment someone clicks New skill.
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

let skillsState: { status: string; data?: unknown[] } = { status: 'ready', data: [] };
vi.mock('@/hooks/use-skills', () => ({ useSkills: () => skillsState }));

const opened: Array<[string, string]> = [];
vi.mock('@/hooks/use-open-skill', () => ({
  useOpenSkill: () => (scope: string, name: string) => {
    opened.push([scope, name]);
  },
}));

const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn() },
}));

const saved: Array<{ name: string }> = [];
let saveResult: { ok: boolean; error?: string } | null = null;
let listResult: { ok: boolean; skills?: unknown[]; error?: string } = { ok: true, skills: [] };
const listCalls: unknown[] = [];
vi.mock('@/lib/skills-api', () => ({
  saveSkill: async (input: { name: string }) => {
    saved.push(input);
    return (
      saveResult ?? {
        ok: true as const,
        created: true,
        warnings: [],
        path: `.ok/skills/${input.name}`,
      }
    );
  },
  listSkills: async (scope: string) => {
    listCalls.push(scope);
    return listResult;
  },
}));

const { useCreateBlankSkill } = await import('./use-create-blank-skill');

/** Minimal entry shape — only `scope`/`name` feed `skillNameSetsByScope`. */
const entry = (name: string, scope = 'project') => ({
  name,
  scope,
  path: `${name}/SKILL.md`,
  installed: false,
  hosts: [],
});

let createBlank: (scope?: 'project' | 'global') => Promise<void>;
function Harness() {
  const hook = useCreateBlankSkill();
  createBlank = hook.createBlank as typeof createBlank;
  return null;
}

beforeEach(() => {
  saved.length = 0;
  opened.length = 0;
  listCalls.length = 0;
  toastError.mockClear();
  skillsState = { status: 'ready', data: [] };
  saveResult = null;
  listResult = { ok: true, skills: [] };
});

afterEach(cleanup);

test('an unresolved list is resolved before naming, not assumed empty', async () => {
  // The regression: `new-skill` and `new-skill-2` exist, but the hook's list has
  // not landed. Guessing here overwrites `new-skill`.
  skillsState = { status: 'loading' };
  listResult = { ok: true, skills: [entry('new-skill'), entry('new-skill-2')] };
  render(<Harness />);

  await act(async () => {
    await createBlank('project');
  });

  expect(listCalls).toEqual(['project']);
  expect(saved.map((s) => s.name)).toEqual(['new-skill-3']);
});

test('a ready list is trusted without a second round trip', async () => {
  skillsState = { status: 'ready', data: [entry('new-skill')] };
  render(<Harness />);

  await act(async () => {
    await createBlank('project');
  });

  expect(listCalls).toEqual([]);
  expect(saved.map((s) => s.name)).toEqual(['new-skill-2']);
});

test('a list that cannot be read refuses to create rather than guessing a name', async () => {
  // There is no name we can prove is free, and the write would be destructive —
  // so not creating is the only safe direction.
  skillsState = { status: 'loading' };
  listResult = { ok: false, error: 'offline' };
  render(<Harness />);

  await act(async () => {
    await createBlank('project');
  });

  expect(saved).toEqual([]);
  expect(opened).toEqual([]);
  expect(toastError).toHaveBeenCalled();
});

test('the created skill is opened', async () => {
  // Reported twice at the bug bash ("it should auto open the skill file").
  render(<Harness />);
  await act(async () => {
    await createBlank('project');
  });
  expect(opened).toEqual([['project', 'new-skill']]);
});

test('the scope being created for is the scope that gets listed', async () => {
  // A global create naming itself against the project's taken set would collide
  // on the other side.
  skillsState = { status: 'loading' };
  listResult = { ok: true, skills: [entry('new-skill', 'global')] };
  render(<Harness />);

  await act(async () => {
    await createBlank('global');
  });

  expect(listCalls).toEqual(['global']);
  expect(saved.map((s) => s.name)).toEqual(['new-skill-2']);
});

test('a failed save never opens a tab for the skill that was not created', async () => {
  // The early return after toast.error is what keeps a failed write from firing
  // the success path — remove it and the user sees "created" in green, then an
  // empty tab for a file that does not exist.
  saveResult = { ok: false, error: 'disk full' };
  render(<Harness />);

  await act(async () => {
    await createBlank('project');
  });

  expect(opened).toEqual([]);
  expect(toastError).toHaveBeenCalled();
});
