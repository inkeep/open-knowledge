import { beforeEach, describe, expect, test, vi } from 'vitest';

const listPackSkillSources = vi.hoisted(() => vi.fn(() => []));

vi.mock('../skill-pack-sources.ts', () => ({ listPackSkillSources }));

import { resolvePackSkillSources } from './install-pack-skill.ts';

describe('resolvePackSkillSources', () => {
  beforeEach(() => {
    listPackSkillSources.mockClear();
  });

  test('resolves against the running server bundle, not a co-installed desktop', () => {
    resolvePackSkillSources('okf');

    expect(listPackSkillSources).toHaveBeenCalledWith('okf', { checkDesktop: false });
  });
});
