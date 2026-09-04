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
  render(<Harness />);
  await act(async () => {
    await createBlank('project');
  });
  expect(opened).toEqual([['project', 'new-skill']]);
});

test('the scope being created for is the scope that gets listed', async () => {
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
  saveResult = { ok: false, error: 'disk full' };
  render(<Harness />);

  await act(async () => {
    await createBlank('project');
  });

  expect(opened).toEqual([]);
  expect(toastError).toHaveBeenCalled();
});
