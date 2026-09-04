import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows');
const workflow = readFileSync(join(WORKFLOWS, 'linear-release.yml'), 'utf8');

const ALERT_STEP = 'Alert on failed stamping';

const ANY_STEP_START = /^ {6}- (.+)$/gm;

function stepLabels(source) {
  const labels = [...source.matchAll(ANY_STEP_START)].map((m) =>
    m[1].trim().replace(/^name: /, ''),
  );
  if (labels.length === 0) throw new Error('no steps parsed from the workflow');
  return labels;
}

function alertBlock(source) {
  const start = source.indexOf(`      - name: ${ALERT_STEP}`);
  if (start === -1) throw new Error(`no step named "${ALERT_STEP}"`);
  return source.slice(start);
}

function assertAlertIsFinalStep(source) {
  const last = stepLabels(source).at(-1);
  if (last !== ALERT_STEP) {
    throw new Error(`expected "${ALERT_STEP}" to be the final step, found "${last}"`);
  }
}

const pageText = (alert) => {
  const line = alert.split('\n').find((l) => l.includes('TEXT="'));
  if (!line) throw new Error('no TEXT= assignment in the alert step');
  return line;
};

const OUTCOME_BRANCH =
  /if \[\[ "\$\{JOB_STATUS:-\}" == "cancelled" \]\]; then\n\s+OUTCOME="was cancelled or timed out"\n\s+else\n\s+OUTCOME="failed"\n\s+fi/;

const UNDELIVERABLE_POST_ONLY_WARNS =
  /if ! curl[\s\S]*?; then\n\s+echo "::warning::Linear stamping failure alert failed to POST\."\n\s+fi/;

describe('linear release stamping workflow', () => {
  test('a failed stamp pages the releases channel', () => {
    const alert = alertBlock(workflow);
    expect(alert).toMatch(/^ {8}if: failure\(\) \|\| cancelled\(\)$/m);
    expect(alert).toContain('"${SLACK_RELEASES_WEBHOOK_URL:-${SLACK_WEBHOOK_URL:-}}"');
  });

  test('the page names the tag, the outcome and the run', () => {
    const alert = alertBlock(workflow);
    const text = pageText(alert);
    expect(text).toContain('${TAG}');
    expect(text).toContain('${RUN_URL}');
    expect(text).toContain('${OUTCOME}');

    expect(alert).toMatch(OUTCOME_BRANCH);
    expect(alert).toContain('JOB_STATUS: ${{ job.status }}');
    expect(alert).toContain('CHANNEL: ${{ steps.derive.outputs.channel }}');
    expect(text).toContain('${CHANNEL:+ (${CHANNEL})}');
    expect(alert).toContain('payload=$(jq -nc --arg text "$TEXT" \'{text: $text}\')');
  });

  test('the alert covers every working step', () => {
    assertAlertIsFinalStep(workflow);

    const withNamedStepBelow = `${workflow}\n      - name: Some later step\n        run: exit 1\n`;
    expect(() => assertAlertIsFinalStep(withNamedStepBelow)).toThrow(
      'expected "Alert on failed stamping" to be the final step, found "Some later step"',
    );

    const withNamelessStepBelow = `${workflow}\n      - uses: actions/github-script@v7\n        with:\n          script: core.setFailed('x')\n`;
    expect(() => assertAlertIsFinalStep(withNamelessStepBelow)).toThrow(
      'found "uses: actions/github-script@v7"',
    );
  });

  test('losing the notification cannot add a failure of its own', () => {
    const alert = alertBlock(workflow);
    expect(alert).toContain('set -uo pipefail');
    expect(alert).not.toContain('set -euo pipefail');
    expect(alert).toContain('if [[ -z "$WEBHOOK_URL" ]]; then');
    expect(alert).toMatch(/No Slack webhook secret is configured[\s\S]*?exit 0/);
    expect(alert).toMatch(UNDELIVERABLE_POST_ONLY_WARNS);
  });
});
