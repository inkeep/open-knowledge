/**
 * Adversarial proof that the release gates bite, plus the ordering and payload
 * invariants a later edit is most likely to break silently.
 *
 * GitHub Actions cannot be executed locally, so the ordering assertions parse
 * the workflow's flat step list and compare positions. That is the highest
 * fidelity available for "the gate runs before the thing it gates", and it is
 * precisely the invariant a well-meaning reorder would destroy without any
 * test noticing.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { buildDiscordPayload, buildSlackPayload } from './build-smoke-alert-payload.mjs';
import { selectPromotion } from './select-beta-to-promote.mjs';
import { smokePackagedDmg, VERDICT } from './smoke-packaged-dmg.mjs';

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows');
const read = (name) => readFileSync(join(WORKFLOWS, name), 'utf8');
const desktopRelease = read('desktop-release.yml');
const promoteStable = read('promote-stable.yml');
const releaseYml = read('release.yml');

/**
 * Ordered step names from a workflow's single-job flat step list. Fails loud
 * rather than silently returning [] if the shape ever changes.
 */
function stepNames(source) {
  const names = [...source.matchAll(/^ {6}- name: (.+)$/gm)].map((m) => m[1].trim());
  if (names.length < 5) {
    throw new Error(
      `step-name parse found only ${names.length} steps; the shape must have changed`,
    );
  }
  return names;
}

const indexOfStep = (names, needle) => names.findIndex((n) => n.includes(needle));

describe('the stable gate is upstream of everything that ships', () => {
  const names = stepNames(desktopRelease);

  test('the smoke gate runs after the DMG is built', () => {
    expect(indexOfStep(names, 'Smoke the packaged DMG')).toBeGreaterThan(
      indexOfStep(names, 'Build + sign + notarize + publish DMG/ZIP'),
    );
  });

  test('the smoke gate runs before the draft is promoted to published', () => {
    const smoke = indexOfStep(names, 'Smoke the packaged DMG');
    const promote = indexOfStep(names, 'Promote draft release to published');
    expect(smoke).toBeGreaterThan(-1);
    expect(promote).toBeGreaterThan(-1);
    expect(smoke).toBeLessThan(promote);
  });

  test('the smoke gate runs before the publish-stable dispatch, so npm cannot move first', () => {
    const smoke = indexOfStep(names, 'Smoke the packaged DMG');
    const npm = indexOfStep(names, 'Trigger release.yml to publish stable to npm');
    expect(npm).toBeGreaterThan(-1);
    expect(smoke).toBeLessThan(npm);
  });

  test('the smoke gate runs before both release announcements', () => {
    const smoke = indexOfStep(names, 'Smoke the packaged DMG');
    expect(smoke).toBeLessThan(indexOfStep(names, 'Announce stable release to Slack'));
    expect(smoke).toBeLessThan(indexOfStep(names, 'Announce stable release to Discord'));
  });

  test('nothing downstream of the gate opts out of the implicit success() guard', () => {
    // A downstream step carrying `if: always()` would run even after the gate
    // refused — which is exactly how a gate stops gating.
    const afterGate = desktopRelease.slice(
      desktopRelease.indexOf('- name: Smoke the packaged DMG'),
    );
    const shipping = afterGate.slice(
      0,
      afterGate.indexOf('- name: Alert on a blocked release'), // failure-conditioned by design
    );
    expect(shipping).not.toContain('if: always()');
    expect(shipping).not.toContain('!cancelled()');
  });

  test('every shipping step with an explicit if: spells success() itself', () => {
    // The subtler sibling of the test above, and the one that matters more.
    // Actions injects the implicit `success()` ONLY on steps with no `if:`;
    // declare one and you own the whole predicate. A shipping step whose `if:`
    // omits `success()` fires on a job that already failed — which is a gate
    // that does not gate. This escaped review once: the npm dispatch shipped
    // with `if: steps.channel... && github.event_name...` and no `success()`,
    // so a refused DMG would still have published to npm.
    const afterGate = desktopRelease.slice(
      desktopRelease.indexOf('- name: Smoke the packaged DMG'),
    );
    const shipping = afterGate.slice(0, afterGate.indexOf('- name: Alert on a blocked release'));
    const conditions = [...shipping.matchAll(/^\s*if: (.+)$/gm)].map((m) => m[1].trim());
    // The gate itself is channel-scoped and runs before anything can have
    // failed; everything after it is shipping and must be success()-gated.
    const shippingConditions = conditions.filter(
      (c) => c !== "steps.channel.outputs.channel == 'latest'",
    );
    expect(shippingConditions.length).toBeGreaterThan(0);
    for (const condition of shippingConditions) {
      expect(condition, `shipping step condition lacks success(): ${condition}`).toContain(
        'success()',
      );
    }
  });
});

describe('the moved dispatch keeps the contract release.yml consumes', () => {
  test('promote-stable no longer dispatches publish-stable', () => {
    expect(promoteStable).not.toContain('event_type: "publish-stable"');
    expect(desktopRelease).toContain('event_type: "publish-stable"');
  });

  test('the event type is exactly what release.yml listens for', () => {
    expect(releaseYml).toContain('types: [publish-stable]');
    expect(desktopRelease).toContain('{event_type: "publish-stable", client_payload:');
  });

  test('the payload carries the same three field names release.yml reads', () => {
    const dispatch = desktopRelease.slice(
      desktopRelease.indexOf('- name: Trigger release.yml to publish stable to npm'),
    );
    const payload = dispatch.slice(dispatch.indexOf('jq -nc'), dispatch.indexOf('gh api -X POST'));
    for (const field of ['ref: $ref', 'version: $version', 'dispatched_by: $by']) {
      expect(payload).toContain(field);
    }
    // And release.yml still reads each of them.
    expect(releaseYml).toContain('github.event.client_payload.ref');
    expect(releaseYml).toContain('github.event.client_payload.version');
    expect(releaseYml).toContain('github.event.client_payload.dispatched_by');
  });

  test('the dispatch is gated so beta cuts and manual re-runs never publish npm', () => {
    const dispatch = desktopRelease.slice(
      desktopRelease.indexOf('- name: Trigger release.yml to publish stable to npm'),
      desktopRelease.indexOf('# The on-site changelog'),
    );
    expect(dispatch).toContain("steps.channel.outputs.channel == 'latest'");
    expect(dispatch).toContain("github.event_name != 'workflow_dispatch'");
  });
});

describe('a non-pass verdict keeps a beta off the fast tier', () => {
  const meta = {
    isDraft: false,
    publishedAt: '2026-07-28T11:00:00Z', // 1h old — under-soaked
    assets: [{ name: 'x.dmg' }, { name: 'beta-mac.yml' }],
  };
  const soaked = { ...meta, publishedAt: '2026-07-25T11:00:00Z' };
  const NOW = Date.parse('2026-07-28T12:00:00Z');

  const decide = (smokeVerdict) =>
    selectPromotion({
      betaTags: ['v1.0.0-beta.2', 'v1.0.0-beta.1'],
      isAlreadyShipped: () => false,
      fetchReleaseMeta: (t) => (t === 'v1.0.0-beta.2' ? meta : soaked),
      soakSeconds: 86400,
      nowMs: NOW,
      qualifiesForFastTier: () => true,
      smokeBeta: () => smokeVerdict,
    });

  test('pass promotes early; fail and error both fall back to the 24h tier', () => {
    expect(decide('pass')).toEqual({ kind: 'select', target: 'v1.0.0-beta.2', tier: 'fast' });
    for (const bad of ['fail', 'error']) {
      expect(decide(bad)).toEqual({ kind: 'select', target: 'v1.0.0-beta.1', tier: 'soak' });
    }
  });
});

describe('a deliberately broken DMG never reads as a pass', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'ok-broken-dmg-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  test('a file that is named .dmg but is not one yields a non-pass verdict', async () => {
    // No mocks anywhere below this line: the real driver, the real mount
    // helper, the real filesystem. On macOS hdiutil refuses the garbage file;
    // on Linux hdiutil does not exist. Both are infrastructure, so both are
    // `error` — and the point of the test is that neither is ever `pass`.
    const fake = join(scratch, 'NotReallyOpenKnowledge.dmg');
    writeFileSync(fake, 'this is not a disk image\n');

    const result = await smokePackagedDmg(fake, {
      // Fail loud if the runner is somehow reached — a broken DMG must never
      // get that far.
      runPlaywright: async () => {
        throw new Error('the Playwright runner must not be reached for a broken DMG');
      },
    });

    expect(result.verdict).not.toBe(VERDICT.pass);
    expect(result.verdict).toBe(VERDICT.error);
    expect(result.reason).toContain('could not prepare the DMG');
  });
});

describe('a forced smoke failure pages both channels, not just an annotation', () => {
  const forced = {
    tag: 'v9.9.9',
    verdict: 'fail',
    reason: 'forced failure',
    runUrl: 'https://example.test/run/1',
  };

  test('both payloads are produced and both name the blocked release', () => {
    const slack = buildSlackPayload(forced);
    const discord = buildDiscordPayload(forced);
    expect(slack.blocks.length).toBeGreaterThan(0);
    expect(discord.embeds.length).toBeGreaterThan(0);
    for (const s of [JSON.stringify(slack), JSON.stringify(discord)]) {
      expect(s).toContain('RELEASE BLOCKED');
      expect(s).toContain('v9.9.9');
    }
  });

  test('the workflow posts to both webhooks in addition to annotating', () => {
    const step = desktopRelease.slice(
      desktopRelease.indexOf('- name: Alert on a blocked release'),
      desktopRelease.indexOf('- name: Warn on stuck draft'),
    );
    expect(step).toContain('post slack');
    expect(step).toContain('post discord');
    expect(step).toContain('::error::RELEASE BLOCKED');
  });
});

describe('the smoke harness comes from the workflow SHA, not the release tag', () => {
  const smokeStep = () => {
    const at = desktopRelease.indexOf('- name: Smoke the packaged DMG (FR5b)');
    expect(at).toBeGreaterThan(-1);
    const rest = desktopRelease.slice(at + 1);
    const end = rest.indexOf('      - name: ');
    return end === -1 ? rest : rest.slice(0, end);
  };

  test('the step overlays the harness from GITHUB_SHA', () => {
    // The harness is CI tooling. Read it from the release tag and a fix to the
    // copy logic can never reach an already-cut tag — and since promote-stable
    // tags the stable at the beta's SHA, every soaked beta is older than the
    // fix, so all of them stay unreleasable.
    const step = smokeStep();
    expect(step).toContain('git fetch --depth=1 origin "$GITHUB_SHA"');
    expect(step).toContain('git checkout "$GITHUB_SHA" --');
    expect(step).toContain('.github/scripts/dmg-mount.mjs');
  });

  test('the overlay cannot newly gate a ref that predates the harness', () => {
    // Order is the whole safety property: a ref with no harness must still take
    // the absent-gate exit, not get one grafted on from the default branch.
    const step = smokeStep();
    expect(step.indexOf('ref predates the harness')).toBeLessThan(
      step.indexOf('git checkout "$GITHUB_SHA" --'),
    );
  });

  test('the overlay degrades to the tag copy instead of blocking the release', () => {
    // A transient fetch failure must not turn into a refused release.
    expect(smokeStep()).toContain('::warning::Could not read the smoke harness');
  });
});

describe('the stable gate does not touch the beta cadence', () => {
  const scoped = (stepHeader) => {
    const at = desktopRelease.indexOf(stepHeader);
    expect(at).toBeGreaterThan(-1);
    return desktopRelease.slice(at, at + 500);
  };

  test('the smoke gate is stable-only', () => {
    // Betas flow through this same job. Gating them here would add 5-15 min to
    // every cadence cut and let a bad DMG block the cadence itself; the beta
    // equivalent is the selection-time gate, which runs after publication.
    expect(scoped('- name: Smoke the packaged DMG (FR5b)')).toContain(
      "if: steps.channel.outputs.channel == 'latest'",
    );
  });

  test('the alert is stable-only too, so a beta hiccup does not page', () => {
    expect(scoped('- name: Alert on a blocked release (FR5c)')).toContain(
      "if: failure() && steps.channel.outputs.channel == 'latest'",
    );
  });

  test('the beta path keeps its existing stuck-draft warning', () => {
    const warn = scoped('- name: Warn on stuck draft');
    expect(warn).toContain('if: failure()');
    expect(warn).not.toContain("channel == 'latest'");
  });
});
