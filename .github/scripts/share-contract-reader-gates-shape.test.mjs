import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

const githubDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function readGithubFile(...segments) {
  return readFileSync(join(githubDir, ...segments), 'utf8');
}

function workflowExpression(expression) {
  return `\${{ ${expression} }}`;
}

function stepBlock(source, stepName) {
  const block = source.split(/^\s*- name: /m).find((candidate) => candidate.startsWith(stepName));
  if (!block) throw new Error(`step not found: ${stepName}`);
  return block;
}

const composite = readGithubFile('composite-actions', 'share-contract-reader-gate', 'action.yml');
const deploymentGate = readGithubFile('workflows', 'share-contract-deployment-gate.yml');

const releaseLanes = [
  {
    name: 'beta and npm release',
    workflow: readGithubFile('workflows', 'release.yml'),
    gate: 'Attest production reader before release',
    mutation: '      - name: Tag + create prerelease GitHub Release',
    condition:
      "if: github.event.action == 'publish-stable' || needs.build.outputs.run_beta == 'true'",
  },
  {
    name: 'stable promotion',
    workflow: readGithubFile('workflows', 'promote-stable.yml'),
    gate: 'Attest production reader before promotion',
    mutation: '      - name: Tag stable at beta SHA',
    condition: "if: steps.ver.outputs.skip != 'true'",
  },
  {
    name: 'point release',
    workflow: readGithubFile('workflows', 'point-release.yml'),
    gate: 'Attest production reader before point release',
    mutation: '      - name: Run the point release',
    condition: 'if: inputs.dry_run == false',
  },
];

describe('share-contract reader gate composite', () => {
  test('runs the canonical probe against the fixed corpus with SHA pinning available', () => {
    const probe = stepBlock(composite, 'Probe reader compatibility');
    expect(probe).toContain('id: probe');
    expect(probe).toContain('probe-share-contract.mjs');
    expect(probe).toContain('test-support/fixtures/share-url-v1-v2.json');
    expect(probe).toContain('--expected-deployment-sha');
  });

  test('a probe failure cannot skip evidence: probe continues, evidence always lands, gate still fails', () => {
    expect(stepBlock(composite, 'Probe reader compatibility')).toContain('continue-on-error: true');
    expect(stepBlock(composite, 'Record reader-contract evidence')).toContain('if: always()');
    const upload = stepBlock(composite, 'Upload reader-contract evidence');
    expect(upload).toContain('if: always()');
    expect(upload).toContain('actions/upload-artifact@');
    expect(upload).toContain('if-no-files-found: error');
    expect(stepBlock(composite, 'Refuse an incompatible reader')).toContain(
      "if: always() && steps.probe.outcome == 'failure'",
    );
  });

  test('records every required attestation field in the run summary', () => {
    const record = stepBlock(composite, 'Record reader-contract evidence');
    for (const field of ['.status', '.epoch', '.corpusSha256', '.deploymentSha', '.probes']) {
      expect(record).toContain(field);
    }
  });
});

describe('share-contract candidate deployment gate', () => {
  test('targets only the production docs project and supports manual verification', () => {
    expect(deploymentGate).toContain('types: [vercel.deployment.ready]');
    expect(deploymentGate).toContain('workflow_dispatch:');
    expect(deploymentGate).toContain("github.event.client_payload.environment == 'production'");
    expect(deploymentGate).toContain(
      "github.event.client_payload.project.name == 'open-knowledge-docs'",
    );
    expect(deploymentGate).toContain('name: share-contract-v2-runner');
    expect(deploymentGate).not.toContain('name: share-contract-v2\n');
  });

  test('checks out and probes the candidate deployment, not production', () => {
    expect(stepBlock(deploymentGate, 'Checkout candidate deployment SHA')).toContain(
      `ref: ${workflowExpression('github.event.client_payload.git.sha || github.sha')}`,
    );
    const probe = stepBlock(deploymentGate, 'Probe candidate reader contract');
    expect(probe).toContain('id: reader');
    expect(probe).toContain('continue-on-error: true');
    expect(probe).toContain(
      `origin: ${workflowExpression('github.event.client_payload.url || inputs.origin')}`,
    );
    expect(probe).toContain(
      `expected-deployment-sha: ${workflowExpression(
        'github.event.client_payload.git.sha || inputs.expected_deployment_sha',
      )}`,
    );
  });

  test('reports the exact Vercel status on every outcome and refuses an incompatible candidate', () => {
    expect(deploymentGate).toContain('statuses: write');
    expect(deploymentGate.match(/context=share-contract-v2/g)).toHaveLength(2);
    expect(stepBlock(deploymentGate, 'Report candidate reader result to Vercel')).toContain(
      "if: always() && github.event_name == 'repository_dispatch'",
    );
    expect(stepBlock(deploymentGate, 'Refuse an incompatible candidate')).toContain(
      "if: always() && steps.reader.outcome == 'failure'",
    );
  });
});

describe.each(releaseLanes)('$name reader attestation', ({
  workflow,
  gate,
  mutation,
  condition,
}) => {
  test('blocks before the first release mutation and skips only no-op lanes', () => {
    const gateIndex = workflow.indexOf(
      'uses: ./.github/composite-actions/share-contract-reader-gate',
    );
    const mutationIndex = workflow.indexOf(mutation);
    expect(gateIndex).toBeGreaterThan(-1);
    expect(mutationIndex).toBeGreaterThan(-1);
    expect(gateIndex).toBeLessThan(mutationIndex);
    expect(stepBlock(workflow, gate)).toContain(condition);
  });
});

describe('stable release reader attestation', () => {
  test('runs the gate in the one job that checks out the workflow revision rather than the stable tag', () => {
    const gateAction = './.github/composite-actions/share-contract-reader-gate';
    const { jobs } = parse(readGithubFile('workflows', 'release.yml'));
    const gateJobs = Object.entries(jobs).filter(([, job]) =>
      (job.steps ?? []).some((step) => step.uses === gateAction),
    );
    expect(gateJobs.map(([id]) => id)).toEqual(['release']);
    const { steps } = gateJobs[0][1];
    const gateAt = steps.findIndex((step) => step.uses === gateAction);
    const checkouts = steps.filter((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0].with.ref).toBe(workflowExpression('github.sha'));
    expect(steps.indexOf(checkouts[0])).toBeLessThan(gateAt);
    const beforeGate = steps.slice(0, gateAt).map((step) => step.run ?? '').join('\n');
    expect(beforeGate).not.toMatch(/\bgit\s+(checkout|switch|restore|reset)\b/);
  });
});
