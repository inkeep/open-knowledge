/**
 * One-shot memory for the Skills Studio first-visit intro.
 *
 * The intro exists because `write-skill` was pulled out of first-launch setup:
 * setup is when a person has the least context for deciding whether
 * they want a skill-authoring workflow, and opening Skills Studio is when they
 * have the most. Removing the offer entirely would have traded an unwanted
 * prompt for an undiscoverable feature, so the offer moved to the moment of
 * intent instead.
 *
 * Per-machine `localStorage`, not user config: "have I seen this once" is UI
 * state about this install, not a preference worth syncing or surviving into
 * someone else's checkout. Same shape as the other `ok-*-v1` stores here, with
 * the storage injected so tests don't need a DOM global.
 */

/** Bumped only if the intro's content changes enough to be worth re-showing. */
export const SKILLS_STUDIO_INTRO_KEY = 'ok-skills-studio-intro-seen-v1';

/** Minimal localStorage surface — a test seam so unit tests inject a fake. */
export interface IntroSeenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): IntroSeenStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Access itself throws in some privacy modes.
    return null;
  }
}

/**
 * True when the intro has already been shown once.
 *
 * Fails CLOSED — an unreadable store answers "seen". A dismissal we cannot
 * persist is a dismissal we cannot honour, and re-prompting on every visit is
 * worse than never prompting: the intro is a courtesy, the row underneath it
 * carries the same offer permanently.
 */
export function hasSeenSkillsStudioIntro(storage?: IntroSeenStorage | null): boolean {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return true;
  try {
    return store.getItem(SKILLS_STUDIO_INTRO_KEY) !== null;
  } catch {
    return true;
  }
}

/** Record that the intro has been shown. Fail-soft: a write that throws leaves
 *  the intro un-dismissed rather than breaking the page that called it. */
export function markSkillsStudioIntroSeen(storage?: IntroSeenStorage | null): void {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return;
  try {
    store.setItem(SKILLS_STUDIO_INTRO_KEY, new Date().toISOString());
  } catch {
    // Quota or privacy mode. Nothing to do — worst case the intro shows again.
  }
}
