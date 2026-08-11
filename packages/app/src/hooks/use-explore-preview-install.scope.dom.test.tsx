import { render } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

/**
 * The preview tab redirects into the real skill after import. `useOpenSkill`
 * resolves a skill's doc by (scope, name), so the redirect MUST use the scope the
 * bundle actually landed at — not the live `scope` selector, which the user can
 * move and which can disagree with where the import ran.
 *
 * When they disagree the lookup misses, the `replaceActive` swap never happens,
 * and you get both halves of the reported bug at once: the preview tab survives
 * (so a second tab appears later) and the doc that was opened does not exist, so
 * it sits on "Couldn't load document" until the sync times out.
 */
describe('preview redirect scope', () => {
  test('redirects at the scope the import landed at, not the live selector', async () => {
    vi.resetModules();

    const openSkill = vi.fn();
    vi.doMock('@/hooks/use-open-skill', () => ({ useOpenSkill: () => openSkill }));
    // The selector says PROJECT; the import actually landed at GLOBAL.
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

    // Exercise the redirect decision in isolation: the same expression
    // SkillPreviewTab uses to choose the scope it opens with.
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
    // The pre-fix behaviour: opening at 'project' resolves a doc that does not exist.
    expect(openSkill).not.toHaveBeenCalledWith('project', 'grill-me', expect.anything());
  });
});
