import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const OK_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PINNED = '0.18.0-abeeaeb';

describe('the Excalidraw pin', () => {
  test('is declared as the exact prerelease snapshot, not a range and not the released version', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('packages/app/package.json', `file://${OK_ROOT}`), 'utf8'),
    );

    const declared = manifest.dependencies['@excalidraw/excalidraw'];

    expect(
      declared,
      `@excalidraw/excalidraw must stay pinned to the exact snapshot ${PINNED}, not ${declared}. It is built from the head of upstream's release branch, so it sorts BELOW the released 0.18.1 under semver while carrying ~99 commits more, including the stroke Pressure control this app ships and the board-format fields it writes to disk. Moving to a semver-greater release is a DOWNGRADE that removes a shipped feature and changes user data at rest, and a caret or tilde range resolves 0.18.1 in preference to this snapshot. Retire this file only when a stable release contains excalidraw/excalidraw#11507; at that point re-check packages/app/src/lib/excalidraw-scene.ts by hand, because restore() may be exported again and serializeAsJSON('local') may filter deleted elements again, and no test in this tree can detect either.`,
    ).toBe(PINNED);
  });

  test('resolves to that same snapshot, so no override or second declaration can move it', () => {
    const lock = readFileSync(new URL('pnpm-lock.yaml', `file://${OK_ROOT}`), 'utf8');

    const resolved = [
      ...new Set(
        [...lock.matchAll(/^ {2}'@excalidraw\/excalidraw@([^'(]+)/gm)].map((match) => match[1]),
      ),
    ];

    expect(
      resolved,
      `the lockfile must resolve @excalidraw/excalidraw to exactly [${PINNED}], not [${resolved.join(', ')}]. A pnpm-workspace.yaml overrides: entry, which is the remedy .github/dependabot.yml documents for a security advisory on this package, moves the resolved version while leaving packages/app/package.json untouched, so the declared-specifier assertion above stays green through a downgrade that removes the shipped Pressure control.`,
    ).toEqual([PINNED]);
  });
});
