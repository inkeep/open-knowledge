import { describe, expect, test } from 'bun:test';
import { STARTER_PACK_IDS, STARTER_PACKS } from './starter.ts';

/**
 * Every user-facing string a starter pack ships: pack name/description, each
 * folder's title/description, every template body, and every root file
 * (e.g. log.md). These land in front of novices at first project setup and
 * inside their first documents, so they must stay free of insider jargon.
 */
function userFacingStrings(): string[] {
  const out: string[] = [];
  for (const id of STARTER_PACK_IDS) {
    const pack = STARTER_PACKS[id];
    out.push(pack.name, pack.description);
    for (const folder of pack.folders) {
      out.push(folder.title, folder.description);
      if (folder.uiSummary) out.push(folder.uiSummary);
    }
    out.push(...Object.values(pack.templates));
    if (pack.rootFiles) out.push(...Object.values(pack.rootFiles));
  }
  return out;
}

describe('starter packs — no insider jargon in user-facing copy', () => {
  // "sweep" (agent-scan jargon) leaked into folder descriptions and a daily-note
  // template body; novices reading "(also in frontmatter for sweeps)" in their
  // own journal had no way to know what it meant. Guard against regressions.
  test('no "sweep" in any folder description, template body, or root file', () => {
    const offenders = userFacingStrings().filter((s) => /\bsweeps?\b/i.test(s));
    expect(offenders).toEqual([]);
  });
});

describe('starter packs — every folder ships a user-facing uiSummary', () => {
  // The picker preview surfaces `uiSummary` (not the agent `description`) so
  // users see jargon-free copy. A folder without one silently falls back to the
  // first sentence of the dense agent description — which truncates mid-code-span
  // (`YYYY-MM-DD-name.md` cut at the `.`). Require an authored line per folder.
  test('every folder has a non-empty uiSummary', () => {
    const missing: string[] = [];
    for (const id of STARTER_PACK_IDS) {
      for (const folder of STARTER_PACKS[id].folders) {
        if (!folder.uiSummary || folder.uiSummary.trim() === '') {
          missing.push(`${id}/${folder.path}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  // The whole point of the split is scannable, jargon-free copy: no code spans
  // (the truncation-bug source) and short enough not to get clipped in the card.
  test('every uiSummary is short and free of code spans', () => {
    const offenders: string[] = [];
    for (const id of STARTER_PACK_IDS) {
      for (const folder of STARTER_PACKS[id].folders) {
        const s = folder.uiSummary ?? '';
        if (s.includes('`') || s.length > 80) offenders.push(`${id}/${folder.path}: "${s}"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
