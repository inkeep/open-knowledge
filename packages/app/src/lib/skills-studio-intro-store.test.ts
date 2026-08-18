import { describe, expect, it } from 'vitest';
import {
  hasSeenSkillsStudioIntro,
  markSkillsStudioIntroSeen,
  SKILLS_STUDIO_INTRO_KEY,
} from './skills-studio-intro-store';

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    size: () => map.size,
  };
}

describe('skills-studio-intro-store', () => {
  it('is unseen until marked, then seen', () => {
    const store = fakeStorage();
    expect(hasSeenSkillsStudioIntro(store)).toBe(false);
    markSkillsStudioIntroSeen(store);
    expect(hasSeenSkillsStudioIntro(store)).toBe(true);
  });

  it('treats an absent store as seen, so a machine that cannot remember is never nagged', () => {
    expect(hasSeenSkillsStudioIntro(null)).toBe(true);
  });

  it('treats a throwing store as seen rather than propagating', () => {
    const hostile = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(hasSeenSkillsStudioIntro(hostile)).toBe(true);
    // And marking must not throw into the caller's render path.
    expect(() => markSkillsStudioIntroSeen(hostile)).not.toThrow();
  });

  it('writes under the versioned key', () => {
    const store = fakeStorage();
    markSkillsStudioIntroSeen(store);
    expect(store.getItem(SKILLS_STUDIO_INTRO_KEY)).toBeTruthy();
  });
});
