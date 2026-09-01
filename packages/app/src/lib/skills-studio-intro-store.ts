export const SKILLS_STUDIO_INTRO_KEY = 'ok-skills-studio-intro-seen-v1';

export interface IntroSeenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): IntroSeenStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function hasSeenSkillsStudioIntro(storage?: IntroSeenStorage | null): boolean {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return true;
  try {
    return store.getItem(SKILLS_STUDIO_INTRO_KEY) !== null;
  } catch {
    return true;
  }
}

export function markSkillsStudioIntroSeen(storage?: IntroSeenStorage | null): void {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return;
  try {
    store.setItem(SKILLS_STUDIO_INTRO_KEY, new Date().toISOString());
  } catch {}
}
