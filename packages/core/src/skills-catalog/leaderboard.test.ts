import { describe, expect, test } from 'vitest';
import { parseSkillsShLeaderboard, parseSkillsShLeaderboardCards } from './leaderboard.ts';

// A minimal raw RSC Flight stream: three cards (one duplicate, one incomplete).
const RAW_FLIGHT =
  'noise{"skillId":"design","source":"anthropics/skills","installs":50}xx' +
  '{"skillId":"pr-writer","source":"inkeep/skills","installs":120}' +
  '{"skillId":"design","source":"anthropics/skills","installs":50}' + // duplicate id
  '{"skillId":"partial","source":"acme/skills"}'; // no installs -> dropped

describe('parseSkillsShLeaderboard', () => {
  test('extracts complete cards in payload order, dropping incomplete ones', () => {
    const cards = parseSkillsShLeaderboardCards(RAW_FLIGHT);
    // 3 complete cards (the partial with no installs is dropped); duplicate kept
    // at card level (dedup happens in the mapping step).
    expect(cards.map((c) => c.skillId)).toEqual(['design', 'pr-writer', 'design']);
    expect(cards.every((c) => typeof c.installs === 'number')).toBe(true);
  });

  test('maps to ranked SkillSearchResults: install-desc, de-duped, owner as publisher', () => {
    const ranked = parseSkillsShLeaderboard(RAW_FLIGHT);
    expect(ranked.map((r) => r.id)).toEqual([
      'inkeep/skills/pr-writer',
      'anthropics/skills/design',
    ]);
    expect(ranked[0]).toMatchObject({
      id: 'inkeep/skills/pr-writer',
      name: 'pr-writer',
      source: 'inkeep/skills',
      installs: 120,
      publisher: 'inkeep',
    });
    // Strictly install-descending (we impose the sort, not the payload).
    for (let i = 1; i < ranked.length; i++) {
      expect((ranked[i - 1]?.installs ?? 0) >= (ranked[i]?.installs ?? 0)).toBe(true);
    }
  });

  test('parses the HTML-wrapped form (self.__next_f.push chunks)', () => {
    const inner = '{"skillId":"a","source":"o/r","installs":9}';
    const html = `<script>self.__next_f.push([1,${JSON.stringify(inner)}])</script>`;
    expect(parseSkillsShLeaderboard(html).map((r) => r.id)).toEqual(['o/r/a']);
  });

  test('returns [] on an unparseable payload (caller degrades to topics)', () => {
    expect(parseSkillsShLeaderboard('<html>no cards here</html>')).toEqual([]);
  });
});

describe('shape drift never mispairs a card', () => {
  // The failure this guards: a stray key with a card field's NAME appearing
  // anywhere else on the page (an `<Image source=…>` prop, a stats header with
  // `installs`, an author card). A positional scan cut the card there and
  // re-seeded the next one with the stray, so every later card carried the
  // previous card's repository under this card's name — complete-looking,
  // undetectable downstream, and cached as "last good" indefinitely.
  test('a stray field elsewhere on the page drops nothing and mixes nothing', () => {
    const payload = [
      '{"skillId":"design","source":"anthropics/skills","installs":50}',
      '{"source":"unsplash"}',
      '{"skillId":"pr-writer","source":"inkeep/skills","installs":120}',
      '{"skillId":"triage","source":"acme/tools","installs":10}',
    ].join(',');

    expect(parseSkillsShLeaderboardCards(payload)).toEqual([
      { skillId: 'design', source: 'anthropics/skills', installs: 50 },
      { skillId: 'pr-writer', source: 'inkeep/skills', installs: 120 },
      { skillId: 'triage', source: 'acme/tools', installs: 10 },
    ]);
  });

  test('braces and quotes inside a description cannot desynchronize the scan', () => {
    const payload =
      '{"skillId":"a","source":"o/r","installs":1,"desc":"use {curly} and \\"quoted\\" text"},' +
      '{"skillId":"b","source":"o/r2","installs":2}';

    expect(parseSkillsShLeaderboardCards(payload).map((c) => c.skillId)).toEqual(['a', 'b']);
  });

  test('a card nested inside a wrapper is found, and the wrapper is not a card', () => {
    const payload = '{"items":[{"skillId":"a","source":"o/r","installs":3}],"installs":999}';
    expect(parseSkillsShLeaderboardCards(payload)).toEqual([
      { skillId: 'a', source: 'o/r', installs: 3 },
    ]);
  });

  test('fields of the right name but wrong type drop the card', () => {
    const payload = '{"skillId":"a","source":"o/r","installs":"many"}';
    expect(parseSkillsShLeaderboardCards(payload)).toEqual([]);
  });
});

describe('real Flight payloads, which are not all valid JSON', () => {
  // Next.js Flight cards routinely carry references like `"icon":$L12`. Parsing
  // each candidate object STRICTLY and skipping what fails would have returned
  // zero cards on exactly the payload this parser exists to read — an empty
  // popular shelf on every load.
  test('reads a card whose object contains a Flight reference', () => {
    const payload =
      '{"skillId":"design","source":"anthropics/skills","installs":50,"icon":$L12},' +
      '{"skillId":"triage","source":"acme/tools","installs":10,"badge":$L13}';

    expect(parseSkillsShLeaderboardCards(payload)).toEqual([
      { skillId: 'design', source: 'anthropics/skills', installs: 50 },
      { skillId: 'triage', source: 'acme/tools', installs: 10 },
    ]);
  });

  test('a nested object cannot shadow the card own field', () => {
    const payload =
      '{"skillId":"design","author":{"source":"WRONG/repo"},"source":"right/repo","installs":5,"x":$L1}';

    expect(parseSkillsShLeaderboardCards(payload)).toEqual([
      { skillId: 'design', source: 'right/repo', installs: 5 },
    ]);
  });

  test('still drops a Flight-shaped object missing a card field', () => {
    expect(parseSkillsShLeaderboardCards('{"skillId":"a","source":"o/r","icon":$L1}')).toEqual([]);
  });
});

describe('the slice-size guard is a real boundary', () => {
  // `fieldsAtOwnDepth` allocates a depth map per candidate slice, so it refuses
  // anything card-sized-and-then-some. Pinned because the constant is a
  // correctness boundary: raise it and a megabyte wrapper gets depth-mapped;
  // invert the guard and legitimate cards vanish.
  test('a valid card padded past the cap is dropped, and one just under is kept', () => {
    const card = (pad: string) =>
      `{"skillId":"design","source":"o/r","installs":5,"pad":"${pad}","x":$L1}`;

    // Over the 8192-byte cap: JSON.parse also refuses it (the $L1), so the
    // fallback is the only reader — and it declines.
    expect(parseSkillsShLeaderboardCards(card('p'.repeat(9000)))).toEqual([]);

    // Comfortably under: the same shape still reads.
    expect(parseSkillsShLeaderboardCards(card('p'.repeat(100)))).toEqual([
      { skillId: 'design', source: 'o/r', installs: 5 },
    ]);
  });

  test('an oversized card that IS valid JSON still parses (the cap is fallback-only)', () => {
    const big = `{"skillId":"design","source":"o/r","installs":5,"pad":"${'p'.repeat(9000)}"}`;
    expect(parseSkillsShLeaderboardCards(big)).toEqual([
      { skillId: 'design', source: 'o/r', installs: 5 },
    ]);
  });
});
