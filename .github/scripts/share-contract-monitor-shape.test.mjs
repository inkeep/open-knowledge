import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const WORKFLOW_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'workflows',
  'share-contract-monitor.yml',
);
const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
const REGRESSION_HANDLER_CONDITION = "if: always() && steps.probe.outcome == 'failure'";

function count(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function assertRegressionHandlersStayReachable(source) {
  const guardedCount = count(source, /^\s+if: always\(\) && steps\.probe\.outcome == 'failure'$/gm);
  if (guardedCount !== 3) {
    throw new Error(`expected 3 status-guarded regression handlers, found ${guardedCount}`);
  }
}

describe('share contract production monitor workflow', () => {
  test('runs on a schedule and manual dispatch without release-writing authority', () => {
    expect(workflow).toContain('schedule:');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('actions: read');
    expect(workflow).toContain('contents: read');
    expect(workflow).not.toMatch(/contents:\s*write/);
    expect(workflow).not.toMatch(/packages:\s*write/);
    expect(workflow).not.toContain('repository_dispatch');
  });

  test('the structural guard catches workflow wiring absence', () => {
    const withoutSchedule = workflow.replace('  schedule:\n', '');
    const withoutProbe = workflow.replace(
      'node .github/scripts/probe-share-contract.mjs',
      'node .github/scripts/other.mjs',
    );

    expect(withoutSchedule).not.toContain('schedule:');
    expect(count(withoutProbe, /node \.github\/scripts\/probe-share-contract\.mjs/g)).toBe(0);
  });

  test('uses the shared probe against production and uploads evidence on every outcome', () => {
    expect(count(workflow, /node \.github\/scripts\/probe-share-contract\.mjs/g)).toBe(1);
    expect(workflow).toContain('https://openknowledge.ai');
    expect(workflow).toContain('test-support/fixtures/share-url-v1-v2.json');
    expect(workflow).toContain('continue-on-error: true');
    expect(workflow).toContain('if: always()');
    expect(workflow).toContain('actions/upload-artifact@');
    expect(workflow).toContain('share-contract-evidence');
  });

  test('fails after alerting and retrieves last-compatible evidence only on regression', () => {
    assertRegressionHandlersStayReachable(workflow);
    expect(workflow).toContain('gh run list');
    expect(workflow).toContain('gh run download');
    expect(workflow).toContain('SLACK_RELEASES_WEBHOOK_URL');
    expect(workflow).toContain('exit 1');
  });

  test('rejects a regression handler that drops the explicit status override', () => {
    const withoutAlways = workflow.replace(
      REGRESSION_HANDLER_CONDITION,
      "if: steps.probe.outcome == 'failure'",
    );

    expect(() => assertRegressionHandlersStayReachable(withoutAlways)).toThrow(
      'expected 3 status-guarded regression handlers, found 2',
    );
  });
});
