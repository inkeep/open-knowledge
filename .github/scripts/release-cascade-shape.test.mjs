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
const desktopBuildWinLinux = read('desktop-build-win-linux.yml');
const promoteStable = read('promote-stable.yml');
const releaseYml = read('release.yml');
const bugLane = read('bug-lane.yml');
const bugLaneVerify = read('bug-lane-verify.yml');

const workflowStep = (source, workflowName, name) => {
  const start = source.indexOf(`- name: ${name}`);
  if (start === -1) throw new Error(`${workflowName} has no step named ${name}`);
  const rest = source.slice(start);
  const end = rest.indexOf('\n      - name: ');
  return end === -1 ? rest : rest.slice(0, end);
};
const bugLaneVerifyStep = (name) => workflowStep(bugLaneVerify, 'bug-lane-verify.yml', name);
const selectBeta = read('select-beta-to-promote.yml');
const linearRelease = read('linear-release.yml');

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

function stepLevelIfConditions(source) {
  const lines = source.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {8}if: (.+)$/.exec(lines[i]);
    if (!m) continue;
    let cond = m[1].trim();
    if (/^[>|][+-]?$/.test(cond)) {
      const cont = [];
      for (let j = i + 1; j < lines.length; j++) {
        const cm = /^ {10,}(\S.*)$/.exec(lines[j]);
        if (!cm) break;
        cont.push(cm[1].trim());
      }
      cond = cont.join(' ');
    }
    out.push(cond);
  }
  return out;
}

describe('the stable gate is upstream of everything that ships', () => {
  const names = stepNames(desktopRelease);

  test('the smoke gate runs after the DMG is built', () => {
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

  test('no shipping STEP opts out of the implicit success() guard', () => {
    const afterGate = desktopRelease.slice(
      desktopRelease.indexOf('- name: Smoke the packaged DMG'),
    );
    const shipping = afterGate.slice(0, afterGate.indexOf('- name: Alert on a blocked release'));
    const stepIfs = stepLevelIfConditions(shipping);
    expect(stepIfs.length).toBeGreaterThan(0);
    for (const condition of stepIfs) {
      expect(condition, `step-level if opts out of success(): ${condition}`).not.toContain(
        'always()',
      );
      expect(condition, `step-level if opts out of success(): ${condition}`).not.toContain(
        '!cancelled()',
      );
    }
  });

  test('every shipping step with an explicit if: spells success() itself', () => {
    const afterGate = desktopRelease.slice(
      desktopRelease.indexOf('- name: Smoke the packaged DMG'),
    );
    const shipping = afterGate.slice(0, afterGate.indexOf('- name: Alert on a blocked release'));
    const conditions = stepLevelIfConditions(shipping);
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

describe('the Azure signing flag set satisfies the schema', () => {
  test('every schema-required azureSignOptions field is passed by both Windows packagers', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const desktopRequire = createRequire(join(repoRoot, 'packages/desktop/package.json'));
    const ebMain = desktopRequire.resolve('electron-builder');
    const ablRequire = createRequire(ebMain);
    const ablMain = ablRequire.resolve('app-builder-lib');
    const scheme = JSON.parse(readFileSync(join(dirname(ablMain), '..', 'scheme.json'), 'utf8'));
    const required = scheme.definitions.WindowsAzureSigningConfiguration.required;
    expect(required.length).toBeGreaterThanOrEqual(3);

    for (const workflow of [desktopRelease, desktopBuildWinLinux]) {
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

describe('the optional Windows signing lane proves what it reports', () => {
  test('signing_ran is authored only after Authenticode attestation succeeds', () => {
    const attestation = desktopBuildWinLinux.indexOf('id: attest-windows-signing');
    expect(attestation).toBeGreaterThan(0);
    expect(desktopBuildWinLinux.slice(0, attestation)).not.toContain('signing_ran=true');
    expect(desktopBuildWinLinux.slice(attestation)).toContain(
      "Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value 'signing_ran=true'",
    );
    expect(desktopBuildWinLinux).toContain(
      'steps.attest-windows-signing.outputs.signing_ran',
    );
  });

  test('attests and package-checks both Windows outer architectures', () => {
    for (const dir of ['dist-desktop/win-unpacked', 'dist-desktop/win-arm64-unpacked']) {
      expect(desktopBuildWinLinux).toContain(`Path = '${dir}'`);
      expect(desktopBuildWinLinux).toContain(`OK_WIN_PACKAGE_DIR: ${dir}`);
    }
  });
});

describe('the publishing Windows lane attests its signed native payload', () => {
  const GATE_CONDITION = "success() && steps.winterm.outputs.ships == 'true'";

  test('checks both outer architectures before staging release assets', () => {
    const detect = desktopRelease.indexOf(
      '- name: Detect whether this ref packages the Windows terminal',
    );
    const attest = desktopRelease.indexOf('- name: Attest signed Windows packages', detect);
    const conpty = desktopRelease.indexOf(
      '- name: Attest preserved Microsoft signatures on the packaged ConPTY pairs',
      attest,
    );
    const asar = desktopRelease.indexOf(
      '- name: Assert the packaged asar carries its dependencies',
      attest,
    );
    const upload = desktopRelease.indexOf(
      '- name: Upload Windows release assets for the fan-in publisher',
      attest,
    );

    expect(detect).toBeGreaterThan(0);
    expect(detect).toBeLessThan(attest);
    expect(attest).toBeLessThan(conpty);
    expect(conpty).toBeLessThan(asar);
    expect(asar).toBeLessThan(upload);
    const attestationSteps = desktopRelease.slice(attest, asar);
    expect(attestationSteps).toContain('Get-AuthenticodeSignature');
    expect(attestationSteps).toContain("-notmatch 'Microsoft'");
    expect(attestationSteps.match(/OK_WIN_PACKAGE_REQUIRED: "1"/gu) ?? []).toHaveLength(2);
    expect(attestationSteps).not.toContain('continue-on-error:');
    const conditions = stepLevelIfConditions(attestationSteps);
    expect(conditions).toHaveLength(3);
    for (const condition of conditions) {
      expect(condition).toBe(GATE_CONDITION);
    }
    for (const dir of ['dist-desktop/win-unpacked', 'dist-desktop/win-arm64-unpacked']) {
      expect(attestationSteps).toContain(`Path = '${dir}'`);
      expect(attestationSteps).toContain(`OK_WIN_PACKAGE_DIR: ${dir}`);
    }
  });

  test('the tree gate probes the pre-terminal exclusion and fails closed', () => {
    const detectStep = workflowStep(
      desktopRelease,
      'desktop-release.yml',
      'Detect whether this ref packages the Windows terminal',
    );
    expect(detectStep).toContain('packages/desktop/electron-builder.yml');
    expect(detectStep).toContain('grep -qF -- \'- "!**/node_modules/node-pty/**"\'');
    expect(detectStep.indexOf('ships=false')).toBeGreaterThan(-1);
    expect(detectStep.indexOf('ships=false')).toBeLessThan(detectStep.indexOf('ships=true'));
    const appAttestation = workflowStep(
      desktopRelease,
      'desktop-release.yml',
      'Attest signed Windows packages',
    );
    expect(stepLevelIfConditions(appAttestation)).toHaveLength(0);
  });

  test('keeps the shared signature-preservation core in both Windows lanes', () => {
    const releaseAppStep = workflowStep(
      desktopRelease,
      'desktop-release.yml',
      'Attest signed Windows packages',
    );
    expect(releaseAppStep).toContain('$signature = Get-AuthenticodeSignature $appExecutable');

    const conptyTokens = [
      '$signature = Get-AuthenticodeSignature $path',
      "-notmatch 'Microsoft'",
      "foreach ($name in @('conpty.dll', 'OpenConsole.exe'))",
      'node-pty[\\\\/]prebuilds[\\\\/]win32-(x64|arm64)[\\\\/]conpty$',
    ];
    const releaseConptyStep = workflowStep(
      desktopRelease,
      'desktop-release.yml',
      'Attest preserved Microsoft signatures on the packaged ConPTY pairs',
    );
    for (const token of conptyTokens) {
      expect(releaseConptyStep).toContain(token);
    }

    const qaAttestationStep = workflowStep(
      desktopBuildWinLinux,
      'desktop-build-win-linux.yml',
      'Attest signed Windows packages and preserved Microsoft signatures',
    );
    for (const token of [
      '$signature = Get-AuthenticodeSignature $appExecutable',
      ...conptyTokens,
    ]) {
      expect(qaAttestationStep).toContain(token);
    }
  });
});

describe('the fan-in publication DAG gates every platform', () => {
  test('publish-assets waits on all four build jobs', () => {
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

  test('the required-platforms valve gates exactly what it may skip — and mac has no bypass', () => {
    const pa = desktopRelease.slice(
      desktopRelease.indexOf('\n  publish-assets:'),
      desktopRelease.indexOf('\n  finalize:'),
    );
    expect(pa).toContain("needs.build-macos.result == 'success'");
    expect(pa).toContain(
      "needs.build-windows.result == 'success' || !contains(needs.prepare.outputs.required, 'windows')",
    );
    expect(pa).toContain(
      "needs.build-linux.result == 'success' || !contains(needs.prepare.outputs.required, 'linux')",
    );
    expect(pa).not.toContain("contains(needs.prepare.outputs.required, 'mac')");
    expect(pa).toContain('!cancelled()');
    const fin = desktopRelease.slice(
      desktopRelease.indexOf('\n  finalize:'),
      desktopRelease.indexOf('\n  alert:'),
    );
    expect(fin).toContain('!cancelled()');
    expect(fin).toContain("needs.publish-assets.result == 'success'");
    expect(fin).toContain("needs.build-macos.result == 'success'");
    expect(desktopRelease).toMatch(
      /::error::DESKTOP_RELEASE_REQUIRED_PLATFORMS must include 'mac'[^"]*"\s*\n\s*exit 1/,
    );
  });

  test('the alert pages on a blocked RELEASE, not on any failed job', () => {
    const alertJob = desktopRelease.slice(
      desktopRelease.indexOf('\n  alert:'),
      desktopRelease.indexOf('- name: Alert on a blocked release'),
    );
    expect(alertJob).toContain("needs.finalize.result != 'success'");
    expect(alertJob).not.toContain('if: failure()');
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
    publishedAt: '2026-07-28T11:00:00Z',
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
    const fake = join(scratch, 'NotReallyOpenKnowledge.dmg');
    writeFileSync(fake, 'this is not a disk image\n');

    const result = await smokePackagedDmg(fake, {
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
    expect(step).toContain('post "${SLACK_RELEASES_WEBHOOK_URL:-${SLACK_WEBHOOK_URL:-}}" Slack');
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
    const step = smokeStep();
    expect(step).toContain('git fetch --depth=1 origin "$GITHUB_SHA"');
    expect(step).toContain('git checkout "$GITHUB_SHA" --');
    expect(step).toContain('.github/scripts/dmg-mount.mjs');
  });

  test('the overlay cannot newly gate a ref that predates the harness', () => {
    const step = smokeStep();
    expect(step.indexOf('ref predates the harness')).toBeLessThan(
      step.indexOf('git checkout "$GITHUB_SHA" --'),
    );
  });

  test('the overlay degrades to the tag copy instead of blocking the release', () => {
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
    expect(scoped('- name: Smoke the packaged DMG (FR5b)')).toContain(
      "if: steps.channel.outputs.channel == 'latest'",
    );
  });

  test('the alert is stable-only too, so a beta hiccup does not page', () => {
    expect(scoped('- name: Alert on a blocked release (FR5c)')).toContain(
      "if: needs.prepare.outputs.channel == 'latest'",
    );
  });

  test('the beta path keeps its existing stuck-draft warning', () => {
    const warn = scoped('- name: Warn on stuck draft');
    expect(warn).toContain('RECOVERY="gh release edit');
    expect(warn).not.toContain("if: needs.prepare.outputs.channel == 'latest'");
  });
});

describe('the bug lane hands off instead of verifying in the evaluator', () => {
  test('the evaluator dispatches the verify workflow rather than running it', () => {
    expect(bugLane).toContain('gh workflow run bug-lane-verify.yml');
    expect(bugLane).not.toContain('- name: Verify the synthetic tree');
    expect(bugLane).not.toContain('git cherry-pick');
    expect(bugLane).not.toContain('turbo run typecheck test');
  });

  test('the evaluator will not queue a second verify behind a running one', () => {
    const inflight = bugLane.slice(
      bugLane.indexOf('- name: Skip while a release'),
      bugLane.indexOf('- name: Hand the batch to the verify workflow'),
    );
    expect(inflight.length).toBeGreaterThan(0);
    expect(inflight).toMatch(/for wf in [^\n]*bug-lane-verify\.yml/);
  });

  test('the verify half queues rather than cancelling a run mid-pick', () => {
    const concurrency = bugLaneVerify.slice(
      bugLaneVerify.indexOf('concurrency:'),
      bugLaneVerify.indexOf('env:'),
    );
    expect(concurrency).toContain('cancel-in-progress: false');
  });

  test('the verify half runs only on dispatch, so it cannot colour a commit', () => {
    const triggers = bugLaneVerify.slice(
      bugLaneVerify.indexOf('\non:'),
      bugLaneVerify.indexOf('\npermissions:'),
    );
    expect(triggers).toContain('workflow_dispatch:');
    expect(triggers).not.toContain('schedule:');
    expect(triggers).not.toMatch(/^\s*push:/m);
  });

  test('the arming switch moved with the steps that read it', () => {
    expect(bugLaneVerify).toContain('BUG_LANE_ARMED: "true"');
    expect(bugLane).not.toContain('BUG_LANE_ARMED:');
  });
});

describe('the failing-test names reach the refusal page', () => {
  test('the verify step publishes them as an output', () => {
    const verify = bugLaneVerifyStep('Verify the synthetic tree (cherry-pick + fast test tiers)');
    expect(verify).toContain('failures<<FAILURES_EOF');
    expect(verify).toContain('printf \'%s\\n\' "$FAILURES_JSON"');
  });

  test('the paging step reads that output and hands it to the payload builder', () => {
    const page = bugLaneVerifyStep('Page on a refusal (armed only)');
    expect(page).toContain('FAILURES: ${{ steps.verify.outputs.failures }}');
    expect(page).toContain('FAILURES_JSON="${FAILURES:-}"');
    expect(page).toContain('--argjson failures "$FAILURES_JSON"');
  });
});

describe('the bug lane verifies the synthetic tree at the same bar as main', () => {
  const verify = bugLaneVerify.slice(
    bugLaneVerify.indexOf('- name: Verify the synthetic tree'),
    bugLaneVerify.indexOf('- name: Dispatch the point release'),
  );

  test('a red tier gets one retry before the tick is refused', () => {
    const runs = [...verify.matchAll(/turbo run typecheck test/g)];
    expect(
      runs.length,
      'verify must invoke the tiers twice: once, then one flake retry',
    ).toBe(2);
    expect(verify).toContain('case "$FIRST_STATUS" in');
    const ordinaryArm = verify.indexOf('*)', verify.indexOf('case "$FIRST_STATUS" in'));
    expect(ordinaryArm, 'the ordinary-failure arm must exist').toBeGreaterThan(-1);
    expect(verify.indexOf('| tee "$RETRY_LOG"')).toBeGreaterThan(ordinaryArm);
  });

  test('the first attempt runs to completion so the retry stays incremental', () => {
    const invocations = verify
      .split('\n')
      .filter((l) => l.includes('pnpm exec turbo run typecheck test'));
    expect(invocations).toHaveLength(2);
    const [first, retry] = invocations;
    expect(first).toContain('--continue');
    expect(first).not.toContain('--force');
    expect(retry).not.toContain('--force');
  });

  test('only a second consecutive failure mints a refusing verdict', () => {
    const installGuardAt = verify.indexOf('verdict=fail');
    const retryAt = verify.indexOf('| tee "$RETRY_LOG"');
    expect(retryAt).toBeGreaterThan(-1);
    expect(installGuardAt).toBeGreaterThan(-1);
    expect(installGuardAt).toBeLessThan(retryAt);
    expect(verify.indexOf('verdict=${TIER_VERDICT}')).toBeGreaterThan(retryAt);
  });

  test('each tier attempt runs under its own budget, and a blown one still pages', () => {
    const wrappers = [...verify.matchAll(/timeout --foreground --kill-after=\d+s/g)];
    expect(wrappers.length, 'both attempts must carry their own budget').toBe(2);

    const gateAt = verify.indexOf('"${TIER_VERDICT:-fail}" == "could-not-verify" ]]; then\n              echo');
    expect(gateAt, 'the warning must branch on the computed budget flag').toBeGreaterThan(-1);
    const couldNotVerifyAt = verify.indexOf('COULD NOT VERIFY', gateAt);
    const notFlakeAt = verify.indexOf('not flake-class', gateAt);
    expect(couldNotVerifyAt).toBeGreaterThan(gateAt);
    expect(notFlakeAt).toBeGreaterThan(couldNotVerifyAt);

    const caseAt = verify.indexOf('case "$FIRST_STATUS" in');
    expect(caseAt).toBeGreaterThan(-1);
    const blowArm = verify.indexOf('124|137)', caseAt);
    const ordinaryRetryArm = verify.indexOf('*)', caseAt);
    expect(blowArm, 'the budget arm must sit inside the FIRST_STATUS case').toBeGreaterThan(caseAt);
    expect(blowArm, 'the budget arm must precede the retry arm').toBeLessThan(ordinaryRetryArm);
  });

  test('a tick that mints no verdict still refuses out loud', () => {
    const guard = bugLaneVerify.indexOf("steps.verify.outputs.verdict == ''");
    expect(guard, 'a no-verdict tick must still page').toBeGreaterThan(-1);
    const always = bugLaneVerify.lastIndexOf('always()', guard);
    expect(always, 'the guard is useless without always()').toBeGreaterThan(-1);
    expect(guard - always).toBeLessThan(40);
    const emits = bugLaneVerify.indexOf('::warning::', guard);
    expect(emits, 'the guarded step must emit something').toBeGreaterThan(guard);
    expect(bugLaneVerify.slice(guard, emits + 200)).toContain('COULD NOT VERIFY');
  });

  test('a budget blow and a real refusal do not share a page signature', () => {
    const sigFrom = bugLaneVerify.indexOf('- name: Refusal signature');
    const sigTo = bugLaneVerify.indexOf('- name: Has this refusal already been paged?');
    expect(sigFrom).toBeGreaterThan(-1);
    expect(sigTo).toBeGreaterThan(sigFrom);
    const sig = bugLaneVerify.slice(sigFrom, sigTo);
    expect(sig).toContain('"$VERDICT"');
    expect(verify).toContain('TIER_VERDICT=could-not-verify');
    expect(bugLaneVerify).not.toContain('budget_blown');
  });

  test('an unchanged refusal is paged once, not once per tick', () => {
    const page = bugLaneVerify.slice(
      bugLaneVerify.indexOf('- name: Page on a refusal'),
      bugLaneVerify.indexOf('- name: Record that this refusal was paged'),
    );
    expect(page).toContain("steps.paged_before.outputs.cache-hit != 'true'");
    expect(bugLaneVerify).toContain('actions/cache/save@');
    expect(bugLaneVerify).toContain('actions/cache/restore@');
  });

  test('the marker is gated on DELIVERY, not on the page step succeeding', () => {
    const refusalPage = bugLaneVerifyStep('Page on a refusal (armed only)');
    expect(refusalPage).toContain('echo "delivered=${delivered}" >> "$GITHUB_OUTPUT"');
    expect(refusalPage).toContain('delivered=true');
    for (const step of ['Record that this refusal was paged', 'Remember the refusal across ticks']) {
      expect(bugLaneVerifyStep(step), `${step} must gate on delivery`).toContain(
        "if: steps.page.outputs.delivered == 'true'",
      );
    }
  });

  test('an unchanged partial drop is paged once, not once per tick', () => {
    expect(bugLaneVerifyStep('Notify on a partial drop (armed only)')).toContain(
      "steps.drop_paged_before.outputs.cache-hit != 'true'",
    );
    for (const step of ['Has this drop already been paged?', 'Remember the drop across ticks']) {
      expect(bugLaneVerifyStep(step), `${step} must key on the drop signature`).toContain(
        'key: bug-lane-drop-${{ steps.drop.outputs.sig }}',
      );
    }
  });

  test('the drop marker is gated on DELIVERY, not on the notify step succeeding', () => {
    for (const step of ['Record that this drop was paged', 'Remember the drop across ticks']) {
      expect(bugLaneVerifyStep(step), `${step} must gate on delivery`).toContain(
        "if: steps.drop_page.outputs.delivered == 'true'",
      );
    }
  });

  test('the drop signature ignores the stable but tracks the dispatched subset', () => {
    const sig = bugLaneVerifyStep('Drop signature');
    expect(sig).toContain('"$DROPPED_REFS" "$SURVIVING_REFS"');
    expect(sig).not.toContain('$STABLE');
  });

  test('a suppressed drop still leaves a trace in the run', () => {
    const suppress = bugLaneVerifyStep('Note a suppressed drop');
    expect(suppress).toContain("if: steps.drop_paged_before.outputs.cache-hit == 'true'");
    expect(suppress).toContain('>> "$GITHUB_STEP_SUMMARY"');
  });

  test('the drop page states its delivery on every path', () => {
    const notify = bugLaneVerifyStep('Notify on a partial drop (armed only)');
    expect(notify).toContain('echo "delivered=${delivered}" >> "$GITHUB_OUTPUT"');
    expect(notify).not.toContain('exit 0');
  });

  test('a disarmed lane cannot post the drop page', () => {
    expect(bugLaneVerifyStep('Drop signature')).toContain("env.BUG_LANE_ARMED == 'true'");
  });

  test('the one page it does send says the following silence is deliberate', () => {
    const page = bugLaneVerify.slice(
      bugLaneVerify.indexOf('- name: Page on a refusal'),
      bugLaneVerify.indexOf('- name: Record that this refusal was paged'),
    );
    expect(page).toContain('bug-lane-refusal-payload.mjs');
    expect(
      readFileSync(join(WORKFLOWS, '..', 'scripts', 'bug-lane-refusal-payload.mjs'), 'utf8'),
    ).toContain('Further identical refusals stay silent');
  });

  test('a suppressed refusal still leaves a trace in the run', () => {
    const suppress = bugLaneVerify.slice(
      bugLaneVerify.indexOf('- name: Note a suppressed refusal'),
      bugLaneVerify.indexOf('- name: Page on a refusal'),
    );
    expect(suppress).toContain("if: steps.paged_before.outputs.cache-hit == 'true'");
    expect(suppress).toContain('>> "$GITHUB_STEP_SUMMARY"');
  });

  test('the refusal page does not claim a cause it has not established', () => {
    const page = bugLaneVerifyStep('Page on a refusal (armed only)');
    expect(page).not.toContain('the fix passes on main but not on the stable');
  });
});

describe('every release-pipeline post prefers the releases webhook', () => {
  const announce = desktopRelease.slice(
    desktopRelease.indexOf('- name: Announce stable release to Slack'),
    desktopRelease.indexOf('- name: Announce stable release to Discord'),
  );

  test('the announcement prefers the releases webhook, falling back to the shared one', () => {
    expect(announce).toContain(
      'SLACK_RELEASES_WEBHOOK_URL: ${{ secrets.SLACK_RELEASES_WEBHOOK_URL }}',
    );
    expect(announce).toContain(
      'WEBHOOK_URL="${SLACK_RELEASES_WEBHOOK_URL:-${SLACK_WEBHOOK_URL:-}}"',
    );
  });

  test('the announcement posts to the resolved URL, never straight to the shared secret', () => {
    expect(announce).toContain('--data "$payload" "$WEBHOOK_URL"');
    expect(announce).not.toContain('--data "$payload" "$SLACK_WEBHOOK_URL"');
  });

  test('neither secret set still no-ops rather than posting to an empty URL', () => {
    expect(announce).toContain('if [[ -z "$WEBHOOK_URL" ]]; then');
  });

  test('the blocked-release alarm resolves the same way the announcement does', () => {
    const alert = desktopRelease.slice(
      desktopRelease.indexOf('- name: Alert on a blocked release'),
    );
    expect(alert).toContain(
      'SLACK_RELEASES_WEBHOOK_URL: ${{ secrets.SLACK_RELEASES_WEBHOOK_URL }}',
    );
    expect(alert).toContain('post "${SLACK_RELEASES_WEBHOOK_URL:-${SLACK_WEBHOOK_URL:-}}" Slack');
    expect(alert).not.toContain('post "${SLACK_WEBHOOK_URL:-}" Slack');
  });

  const RESOLVED = 'WEBHOOK_URL="${SLACK_RELEASES_WEBHOOK_URL:-${SLACK_WEBHOOK_URL:-}}"';
  const stepAfter = (source, name, next) => {
    const start = source.indexOf(`- name: ${name}`);
    if (start === -1) throw new Error(`no step named ${name}`);
    return source.slice(
      start,
      next === undefined ? undefined : source.indexOf(`- name: ${next}`),
    );
  };

  for (const { label, step } of [
    {
      label: "the bug lane's refusal page",
      step: () => stepAfter(bugLaneVerify, 'Page on a refusal'),
    },
    {
      label: "the bug lane's partial-drop notice",
      step: () => stepAfter(bugLaneVerify, 'Notify on a partial drop', 'Page on a refusal'),
    },
    {
      label: 'the fast-tier refusal',
      step: () => stepAfter(selectBeta, 'Record a fast-tier refusal'),
    },
    {
      label: "the Linear stamp's failure page",
      step: () => stepAfter(linearRelease, 'Alert on failed stamping'),
    },
  ]) {
    test(`${label} resolves the releases webhook first`, () => {
      const s = step();
      expect(s).toContain('SLACK_RELEASES_WEBHOOK_URL: ${{ secrets.SLACK_RELEASES_WEBHOOK_URL }}');
      expect(s).toContain(RESOLVED);
      expect(s).toMatch(/--data "\$payload"[\s\\]*"\$WEBHOOK_URL"/);
      expect(s).not.toMatch(/--data "\$payload"[\s\\]*"\$SLACK_WEBHOOK_URL"/);
      expect(s).not.toContain('if [[ -z "${SLACK_WEBHOOK_URL:-}" ]]; then');
    });
  }

  test('the aggregate smoke alarm resolves the releases webhook first', () => {
    const alarm = stepAfter(selectBeta, 'Page the release channel');
    expect(alarm).toContain('SLACK_RELEASES_WEBHOOK_URL: ${{ secrets.SLACK_RELEASES_WEBHOOK_URL }}');
    expect(alarm).toContain('post "${SLACK_RELEASES_WEBHOOK_URL:-${SLACK_WEBHOOK_URL:-}}" Slack');
    expect(alarm).not.toContain('post "${SLACK_WEBHOOK_URL:-}" Slack');
  });
});
