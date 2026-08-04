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
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { buildSlackPayload } from './build-smoke-alert-payload.mjs';
import { selectPromotion } from './select-beta-to-promote.mjs';
import { smokePackagedDmg, VERDICT } from './smoke-packaged-dmg.mjs';

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows');
const read = (name) => readFileSync(join(WORKFLOWS, name), 'utf8');
const desktopRelease = read('desktop-release.yml');
const promoteStable = read('promote-stable.yml');
const releaseYml = read('release.yml');

/**
 * Ordered step names across the workflow, in FILE order. Under the fan-out
 * topology file order equals execution order only WITHIN a job; cross-job
 * ordering is enforced by the `needs:` DAG, which the dedicated describe
 * below pins directly. Fails loud rather than silently returning [] if the
 * shape ever changes.
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
    // Both steps live in build-macos, so file order is execution order here.
    const build = indexOfStep(names, 'Build + sign + notarize DMG/ZIP');
    expect(build).toBeGreaterThan(-1);
    expect(indexOfStep(names, 'Smoke the packaged DMG')).toBeGreaterThan(build);
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
    // with a channel-and-event `if:` and no `success()`, so a refused DMG
    // would still have published to npm.
    const afterGate = desktopRelease.slice(
      desktopRelease.indexOf('- name: Smoke the packaged DMG'),
    );
    const shipping = afterGate.slice(0, afterGate.indexOf('- name: Alert on a blocked release'));
    const conditions = [...shipping.matchAll(/^\s*if: (.+)$/gm)].map((m) => m[1].trim());
    // Two conditions in this span are gates, not shipping: the smoke gate's
    // own channel scope, and the alert JOB's failure() header (the span ends
    // at the alert step's name, which sits after its job header). Everything
    // else ships and must be success()-gated.
    const shippingConditions = conditions.filter(
      (c) => c !== "steps.channel.outputs.channel == 'latest'" && c !== 'failure()',
    );
    expect(shippingConditions.length).toBeGreaterThan(0);
    for (const condition of shippingConditions) {
      expect(condition, `shipping step condition lacks success(): ${condition}`).toContain(
        'success()',
      );
    }
  });
});

describe('the Azure signing flag set satisfies the schema', () => {
  test('every schema-required azureSignOptions field is passed by both Windows packagers', () => {
    // app-builder-lib's validateConfig rejects a PARTIAL azureSignOptions
    // before packaging anything ("should be one of these: null"), and the
    // fan-in topology turns that one-job failure into a zero-platform
    // release. The required set is data (scheme.json), so pin the workflows'
    // flag sets against it — this is exactly the check that would have
    // caught the three-of-four-fields shape without a live Azure account.
    // Resolution goes through electron-builder's own tree because pnpm's
    // isolated layout hides transitive deps from the workspace packages.
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const desktopRequire = createRequire(join(repoRoot, 'packages/desktop/package.json'));
    const ebMain = desktopRequire.resolve('electron-builder');
    const ablRequire = createRequire(ebMain);
    const ablMain = ablRequire.resolve('app-builder-lib');
    const scheme = JSON.parse(readFileSync(join(dirname(ablMain), '..', 'scheme.json'), 'utf8'));
    const required = scheme.definitions.WindowsAzureSigningConfiguration.required;
    expect(required.length).toBeGreaterThanOrEqual(3); // schema sanity, not vacuous

    for (const workflow of [desktopRelease, read('desktop-build-win-linux.yml')]) {
      const passed = [...workflow.matchAll(/--config\.win\.azureSignOptions\.([A-Za-z]+)=/g)].map(
        (m) => m[1],
      );
      for (const field of required) {
        expect(passed, `workflow is missing schema-required azureSignOptions.${field}`).toContain(
          field,
        );
      }
    }
  });
});

describe('the fan-in publication DAG gates every platform', () => {
  test('publish-assets waits on all four build jobs', () => {
    // The single publication point must sit downstream of EVERY packaging
    // job — dropping one from `needs` publishes a release that platform
    // never built for.
    expect(desktopRelease).toContain(
      'needs: [prepare, build-macos, build-windows, build-linux]',
    );
  });

  test('finalize waits on publish-assets (and the smoke via build-macos)', () => {
    expect(desktopRelease).toContain('needs: [prepare, build-macos, publish-assets]');
  });

  test('no electron-builder invocation publishes; only the fan-in touches the Release', () => {
    expect(desktopRelease).not.toContain('--publish always');
    const invocations = [...desktopRelease.matchAll(/electron-builder --\w+/g)];
    expect(invocations.length).toBeGreaterThanOrEqual(3);
    expect(desktopRelease).toContain('gh release upload "$RELEASE_TAG"');
  });

  test('the inventory is asserted before upload and re-verified after', () => {
    const names = stepNames(desktopRelease);
    const assert = indexOfStep(names, 'Assert the complete cross-platform inventory');
    const upload = indexOfStep(names, 'Upload assets to the GitHub Release');
    const verify = indexOfStep(names, 'Verify the Release carries the full inventory');
    expect(assert).toBeGreaterThan(-1);
    expect(assert).toBeLessThan(upload);
    expect(upload).toBeLessThan(verify);
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
    expect(dispatch).toContain("needs.prepare.outputs.channel == 'latest'");
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

describe('a forced smoke failure pages Slack, not just an annotation', () => {
  const forced = {
    tag: 'v9.9.9',
    verdict: 'fail',
    reason: 'forced failure',
    runUrl: 'https://example.test/run/1',
  };

  test('the payload is produced and names the blocked release', () => {
    const slack = buildSlackPayload(forced);
    expect(slack.blocks.length).toBeGreaterThan(0);
    const s = JSON.stringify(slack);
    expect(s).toContain('RELEASE BLOCKED');
    expect(s).toContain('v9.9.9');
  });

  test('the workflow posts to the Slack webhook in addition to annotating', () => {
    const step = desktopRelease.slice(
      desktopRelease.indexOf('- name: Alert on a blocked release'),
      desktopRelease.indexOf('- name: Warn on stuck draft'),
    );
    expect(step).toContain('post "${SLACK_WEBHOOK_URL:-}" Slack');
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
    // The failure() half of the old combined predicate moved to the alert
    // JOB header (pinned by build-smoke-alert-payload.test.mjs); the step
    // keeps the channel scope.
    expect(scoped('- name: Alert on a blocked release (FR5c)')).toContain(
      "if: needs.prepare.outputs.channel == 'latest'",
    );
  });

  test('the beta path keeps its existing stuck-draft warning', () => {
    // No step-level channel gate: the warning fires for BOTH channels (the
    // alert job's failure() header is what conditions it on a broken run).
    const warn = scoped('- name: Warn on stuck draft');
    expect(warn).toContain('RECOVERY="gh release edit');
    expect(warn).not.toContain("if: needs.prepare.outputs.channel == 'latest'");
  });
});
