import { render } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

describe('preview redirect scope', () => {
  test('redirects at the scope the import landed at, not the live selector', async () => {
    vi.resetModules();

    const openSkill = vi.fn();
    vi.doMock('@/hooks/use-open-skill', () => ({ useOpenSkill: () => openSkill }));
    vi.doMock('@/hooks/use-explore-preview-install', () => ({
      useExplorePreviewInstall: () => ({
        scope: 'project',
        importedScope: 'global',
        importedName: 'grill-me',
        setScope: vi.fn(),
        scopeLocked: true,
        importNow: vi.fn(),
        toggles: {
          hostSet: new Set(),
          installed: false,
          installing: false,
          toggleEditor: vi.fn(),
          installAll: vi.fn(),
          linkMode: false,
          setLinkMode: vi.fn(),
          setSource: vi.fn(),
          placeAt: vi.fn(),
        },
      }),
    }));

    const { useExplorePreviewInstall } = await import('@/hooks/use-explore-preview-install');
    const { useOpenSkill } = await import('@/hooks/use-open-skill');

    function Redirect() {
      const previewInstall = useExplorePreviewInstall({
        source: 'mattpocock/skills',
        name: 'grill-me',
        initialScope: 'project',
        marketplace: true,
      });
      const open = useOpenSkill();
      const landedName = previewInstall.importedName;
      const landedScope = previewInstall.importedScope ?? previewInstall.scope;
      if (landedName) open(landedScope, landedName, { replaceActive: true });
      return null;
    }

    render(<Redirect />);

    expect(openSkill).toHaveBeenCalledWith('global', 'grill-me', { replaceActive: true });
    expect(openSkill).not.toHaveBeenCalledWith('project', 'grill-me', expect.anything());
  });
});
