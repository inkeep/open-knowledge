import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { SkillCostTiers, SkillsListEntry } from '@inkeep/open-knowledge-core';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import * as linguiShim from '../../tests/lingui-macro-shim';

vi.doMock('@lingui/react/macro', () => linguiShim);

type SkillsState = { status: 'idle' } | { status: 'ready'; data: readonly SkillsListEntry[] };
let skillsState: SkillsState = { status: 'idle' };
vi.doMock('@/hooks/use-skills', () => ({ useSkills: () => skillsState }));

function readyEntry(size?: SkillCostTiers): SkillsState {
  const entry = {
    scope: 'project',
    name: 'foo',
    path: '.claude/skills/foo/SKILL.md',
    installed: true,
    hosts: ['claude'],
    ...(size ? { size } : {}),
  } as unknown as SkillsListEntry;
  return { status: 'ready', data: [entry] };
}

const { SkillProperties } = await import('./SkillProperties');
const { PropertyProvider } = await import('./PropertyContext');

beforeEach(() => {
  skillsState = { status: 'idle' };
});

function renderPanel(ui: Parameters<typeof render>[0]) {
  return render(<PropertyProvider>{ui}</PropertyProvider>);
}

function makeProvider(source: string): { provider: HocuspocusProvider; ytext: Y.Text } {
  const document = new Y.Doc();
  const ytext = document.getText('source');
  ytext.insert(0, source);
  const provider = {
    document,
    configuration: { name: '__skill__/project/foo' },
    on: () => {},
    off: () => {},
  } as unknown as HocuspocusProvider;
  return { provider, ytext };
}

const SOURCE = '---\nname: foo\ndescription: initial desc\n---\n\n# Body\n';

describe('SkillProperties (CRDT)', () => {
  test('renders the reused document property panel with the doc frontmatter', () => {
    const { provider } = makeProvider(SOURCE);
    renderPanel(
      <SkillProperties provider={provider} scope="project" name="foo" onRename={() => {}} />,
    );
    expect(screen.getByTestId('property-panel')).toBeTruthy();
    expect(screen.getByDisplayValue('initial desc')).toBeTruthy();
  });

  test('committing a changed name fires onRename (a git-mv rename), not a patch', () => {
    const { provider, ytext } = makeProvider(SOURCE);
    const onRename = vi.fn((_next: string) => {});
    renderPanel(
      <SkillProperties provider={provider} scope="project" name="foo" onRename={onRename} />,
    );
    const nameInput = screen.getByTestId('skill-name-input');
    fireEvent.change(nameInput, { target: { value: 'bar' } });
    fireEvent.blur(nameInput);
    expect(onRename).toHaveBeenCalledWith('bar');
    expect(ytext.toString()).toContain('name: foo');
  });

  test('an unchanged name does not fire onRename', () => {
    const { provider } = makeProvider(SOURCE);
    const onRename = vi.fn((_next: string) => {});
    renderPanel(
      <SkillProperties provider={provider} scope="project" name="foo" onRename={onRename} />,
    );
    const nameInput = screen.getByTestId('skill-name-input');
    fireEvent.blur(nameInput);
    expect(onRename).not.toHaveBeenCalled();
  });

  test('renders the name identity field inside the Properties panel', () => {
    const { provider } = makeProvider(SOURCE);
    renderPanel(
      <SkillProperties provider={provider} scope="project" name="foo" onRename={() => {}} />,
    );
    const panel = screen.getByTestId('property-panel');
    expect(panel.contains(screen.getByTestId('skill-name-input'))).toBe(true);
  });
});

describe('SkillProperties tokens row', () => {
  test('shows the three tiers from the list entry, bare and ~-prefixed', () => {
    skillsState = readyEntry({ alwaysOn: 40, onTrigger: 3218, onDemand: 916 });
    const { provider } = makeProvider(SOURCE);
    renderPanel(
      <SkillProperties provider={provider} scope="project" name="foo" onRename={() => {}} />,
    );
    const row = screen.getByTestId('skill-cost-value');
    const text = row.textContent ?? '';
    expect(text).toContain('40');
    expect(text).toContain('3.2k');
    expect(text).toContain('916');
    expect(text).toContain('description');
    expect(text).toContain('SKILL.md');
    expect(text).toContain('other');
    expect(text).toContain('total');
    expect(text).toContain('4.2k');
    expect(screen.queryAllByRole('img')).toHaveLength(0);
  });

  test('hides the row when the entry carries no size (older server)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    skillsState = readyEntry(undefined);
    const { provider } = makeProvider(SOURCE);
    renderPanel(
      <SkillProperties provider={provider} scope="project" name="foo" onRename={() => {}} />,
    );
    expect(screen.queryByTestId('skill-cost-value')).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  test('marks tiers over their published budget and leaves on-demand bare', () => {
    skillsState = readyEntry({ alwaysOn: 250, onTrigger: 6000, onDemand: 40000 });
    const { provider } = makeProvider(SOURCE);
    renderPanel(
      <SkillProperties provider={provider} scope="project" name="foo" onRename={() => {}} />,
    );
    const marks = screen.getAllByRole('img');
    expect(marks).toHaveLength(2);
    for (const mark of marks) {
      expect(mark.getAttribute('aria-label')).toMatch(/over the .* token budget/);
    }
    expect(screen.getByTestId('skill-cost-value').textContent).toContain('40k');
  });
});
