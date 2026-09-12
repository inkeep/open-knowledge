import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Button } from '@/components/ui/button';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

const userPatch = vi.fn((_patch: unknown) => ({ ok: true as const }));
const projectLocalPatch = vi.fn((_patch: unknown) => ({ ok: true as const }));
const toastError = vi.fn((_message: string, _options?: { description?: string }) => {});
const toastInfo = vi.fn((_message: string, _options?: { id?: string }) => {});
let userSynced = false;
let projectLocalSynced = false;
let onTogglePinFromTree:
  | ((scope: 'global' | 'project', name: string, pinned: boolean) => void)
  | null = null;
let merged: {
  appearance?: { sidebar?: { pinnedGlobalSkills?: string[]; pinnedProjectSkills?: string[] } };
} | null = null;

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

vi.doMock('@/hooks/use-skills', () => ({
  useSkills: () => ({ status: 'ready', data: [] }),
}));

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    openTarget: () => {},
    activeDocName: null,
    activeTarget: null,
    openTabs: [],
    activateTab: () => {},
  }),
}));

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    merged,
    userBinding: { patch: userPatch },
    userSynced,
    projectLocalBinding: { patch: projectLocalPatch },
    projectLocalSynced,
  }),
}));

vi.doMock('sonner', () => ({
  toast: { error: toastError, info: toastInfo },
}));

vi.doMock('@/components/skill-actions', () => ({
  useSkillActions: () => ({}),
}));

vi.doMock('@/hooks/use-create-blank-skill', () => ({
  useCreateBlankSkill: () => ({ createBlank: () => {}, creating: false }),
}));

vi.doMock('@/hooks/use-open-skill', () => ({ useOpenSkill: () => () => {} }));
vi.doMock('@/hooks/use-open-skill-for-edit', () => ({
  useOpenSkillForEdit: () => () => Promise.resolve({ ok: true }),
}));
vi.doMock('@/lib/skill-scope', () => ({
  SKILL_SCOPE_ORDER: ['global', 'project'],
  skillDir: () => '',
  skillNameSetsByScope: () => ({ global: new Set(), project: new Set() }),
  useSkillScopeDescriptions: () => ({ global: 'Global', project: 'Project' }),
  useSkillScopeLabels: () => ({ global: 'Global', project: 'Project' }),
}));
vi.doMock('@/lib/skills-tree-paths', () => ({
  buildSkillsTreePaths: () => ({
    paths: [],
    expanded: [],
    activePath: undefined,
    skillByPrefix: new Map(),
    detectedByPrefix: new Map(),
    groupByPrefix: new Map(),
    pinnedPrefixes: new Set(),
  }),
  detectedId: () => '',
  isSkillDocActive: () => false,
}));

vi.doMock('@/lib/skills-api', () => ({
  fetchSkillPreview: () => Promise.resolve({ ok: true, files: [] }),
  listDetectedSkills: () => Promise.resolve({ ok: true, skills: [] }),
}));

vi.doMock('@/components/SkillsTree', () => ({
  SkillsTree: (props: {
    pinningReadyByScope: Record<'global' | 'project', boolean>;
    onTogglePin: (scope: 'global' | 'project', name: string, pinned: boolean) => void;
  }) => {
    onTogglePinFromTree = props.onTogglePin;
    return (
      <>
        <Button
          data-testid="pin-global"
          disabled={!props.pinningReadyByScope.global}
          onClick={() => props.onTogglePin('global', 'alpha', true)}
        >
          Pin global
        </Button>
        <Button
          data-testid="pin-project"
          disabled={!props.pinningReadyByScope.project}
          onClick={() => props.onTogglePin('project', 'beta', true)}
        >
          Pin project
        </Button>
      </>
    );
  },
}));

const { SkillsSidebarSection } = await import('./SkillsSidebarSection');
const { emitSkillScopeMoved } = await import('@/lib/documents-events');

describe('SkillsSidebarSection config readiness', () => {
  beforeEach(() => {
    userSynced = false;
    projectLocalSynced = false;
    onTogglePinFromTree = null;
    merged = null;
    userPatch.mockClear();
    projectLocalPatch.mockClear();
    toastError.mockClear();
    toastInfo.mockClear();
  });

  afterEach(() => cleanup());

  test('pin actions become ready independently for their named scope', () => {
    const rendered = render(<SkillsSidebarSection dockExpanded />);

    const globalPending = screen.getByTestId('pin-global') as HTMLButtonElement;
    const projectPending = screen.getByTestId('pin-project') as HTMLButtonElement;
    expect(globalPending.disabled).toBe(true);
    expect(projectPending.disabled).toBe(true);
    fireEvent.click(globalPending);
    fireEvent.click(projectPending);
    onTogglePinFromTree?.('global', 'alpha', true);
    onTogglePinFromTree?.('project', 'beta', true);
    expect(userPatch).not.toHaveBeenCalled();
    expect(projectLocalPatch).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith('Settings are still loading. Try again in a moment.', {
      id: 'pin-not-ready-global',
    });
    expect(toastInfo).toHaveBeenCalledWith('Settings are still loading. Try again in a moment.', {
      id: 'pin-not-ready-project',
    });

    userSynced = true;
    rendered.rerender(<SkillsSidebarSection dockExpanded />);

    fireEvent.click(screen.getByTestId('pin-global'));
    fireEvent.click(screen.getByTestId('pin-project'));
    expect(userPatch).toHaveBeenCalledWith({
      appearance: { sidebar: { pinnedGlobalSkills: ['alpha'] } },
    });
    expect(projectLocalPatch).not.toHaveBeenCalled();

    projectLocalSynced = true;
    rendered.rerender(<SkillsSidebarSection dockExpanded />);
    fireEvent.click(screen.getByTestId('pin-project'));
    expect(projectLocalPatch).toHaveBeenCalledWith({
      appearance: { sidebar: { pinnedProjectSkills: ['beta'] } },
    });
  });

  test.each([
    {
      pendingScope: 'destination',
      name: 'alpha',
      fromScope: 'global' as const,
      toScope: 'project' as const,
      mergedConfig: { appearance: { sidebar: { pinnedGlobalSkills: ['alpha'] } } },
      globalReady: true,
      projectReady: false,
    },
    {
      pendingScope: 'source',
      name: 'beta',
      fromScope: 'project' as const,
      toScope: 'global' as const,
      mergedConfig: { appearance: { sidebar: { pinnedProjectSkills: ['beta'] } } },
      globalReady: true,
      projectReady: false,
    },
  ])(
    'a scope-moved pin refuses the event without writes when its $pendingScope scope is pending',
    ({ name, fromScope, toScope, mergedConfig, globalReady, projectReady }) => {
      merged = mergedConfig;
      userSynced = globalReady;
      projectLocalSynced = projectReady;
      render(<SkillsSidebarSection dockExpanded />);

      emitSkillScopeMoved({ name, fromScope, toScope });

      expect(userPatch).not.toHaveBeenCalled();
      expect(projectLocalPatch).not.toHaveBeenCalled();
      expect(toastInfo).toHaveBeenCalledWith(
        `${name} moved, but its pin did not. Pin it again after settings finish loading.`,
      );
    },
  );

  test('a scope-moved pin updates both documents when both scopes are ready', () => {
    merged = { appearance: { sidebar: { pinnedGlobalSkills: ['alpha'] } } };
    userSynced = true;
    projectLocalSynced = true;
    render(<SkillsSidebarSection dockExpanded />);

    emitSkillScopeMoved({ name: 'alpha', fromScope: 'global', toScope: 'project' });

    expect(userPatch).toHaveBeenCalledWith({
      appearance: { sidebar: { pinnedGlobalSkills: [] } },
    });
    expect(projectLocalPatch).toHaveBeenCalledWith({
      appearance: { sidebar: { pinnedProjectSkills: ['alpha'] } },
    });
  });
});
