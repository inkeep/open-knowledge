import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { expect, test, vi } from 'vitest';
import {
  bootArtifactAdmissionRig,
  settleArtifactContributors,
} from './artifact-admission-rig.test-helper.ts';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, rawRequest } from './composition-rig.test-helper.ts';
import { __formatContributorsForTests } from './contributor-tracker.ts';
import * as persistence from './persistence.ts';
import * as shadowRepo from './shadow-repo.ts';

test('test flush waits for accepted artifact attribution before acknowledging settlement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-artifact-flush-settlement-'));
  mkdirSync(join(root, 'templates'));
  let server: BootedServer | undefined;
  let gated = false;
  let released = false;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gitFlushes: boolean[] = [];
  const create = persistence.createPersistenceExtension;
  vi.spyOn(persistence, 'createPersistenceExtension').mockImplementation((...args) => {
    const result = create(...args);
    const flush = result.flushContributors;
    const flushGit = result.flushPendingGitCommit;
    result.flushContributors = async () => {
      if (gated) {
        entered();
        await gate;
      }
      await flush();
    };
    result.flushPendingGitCommit = async () => {
      if (gated) gitFlushes.push(released);
      await flushGit();
    };
    return result;
  });
  try {
    server = await bootCompositionRig(root, { enableTestRoutes: true });
    await server.ready;
    await server.generatedIndexSweepReady;
    gated = true;
    const write = await rawRequest(server.port, '/api/template', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folder: 'templates',
        name: 'example',
        body: 'Safe.\n',
        frontmatter: { title: 'Example' },
      }),
    });
    expect(write.status, write.body).toBe(200);
    await started;
    expect(__formatContributorsForTests()).toContain('templates/.ok/templates/example');
    let received!: () => void;
    const requestReceived = new Promise<void>((resolve) => {
      received = resolve;
    });
    server.httpServer.prependListener('request', (req) => {
      if (req.url === '/api/test-flush-git') received();
    });
    const flushing = rawRequest(server.port, '/api/test-flush-git', { method: 'POST' });
    await requestReceived;
    await setImmediate();
    const beforeRelease = [...gitFlushes];
    released = true;
    release();
    const response = await flushing;
    expect(beforeRelease).toEqual([]);
    expect(response.status, response.body).toBe(200);
    expect(gitFlushes).toEqual([true]);
    expect(__formatContributorsForTests()).toBe('');
  } finally {
    release();
    await server?.destroy();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});

test('shared settlement joins the separate skill-file attribution flush', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-skill-file-flush-settlement-'));
  const directory = join(root, '.agents', 'skills', 'example');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'SKILL.md'),
    '---\nname: example\ndescription: Example\n---\nGuidance.\n',
  );
  let server: BootedServer | undefined;
  let tracked = false;
  let release!: () => void;
  let commitEntered!: () => void;
  let joinEntered!: () => void;
  const commitGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const commitStarted = new Promise<void>((resolve) => {
    commitEntered = resolve;
  });
  const joinStarted = new Promise<void>((resolve) => {
    joinEntered = resolve;
  });
  let joinCompleted = false;
  const commit = shadowRepo.commitWipFromTree;
  vi.spyOn(shadowRepo, 'commitWipFromTree').mockImplementation(async (...args) => {
    if (tracked) {
      commitEntered();
      await commitGate;
    }
    return commit(...args);
  });
  const create = persistence.createPersistenceExtension;
  vi.spyOn(persistence, 'createPersistenceExtension').mockImplementation((...args) => {
    const result = create(...args);
    const flushGit = result.flushPendingGitCommit;
    result.flushPendingGitCommit = async () => {
      const work = flushGit();
      if (tracked) joinEntered();
      await work;
      if (tracked) joinCompleted = true;
    };
    return result;
  });
  try {
    server = await bootArtifactAdmissionRig(root);
    await settleArtifactContributors(server);
    tracked = true;
    const response = await rawRequest(server.port, '/api/skill-file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'example',
        scope: 'project',
        path: 'references/example.md',
        content: 'Safe.\n',
        agentId: 'file-writer',
      }),
    });
    expect(response.status, response.body).toBe(200);
    await commitStarted;
    const settling = settleArtifactContributors(server);
    await joinStarted;
    await setImmediate();
    const completedBeforeRelease = joinCompleted;
    release();
    await settling;
    expect(completedBeforeRelease).toBe(false);
    expect(joinCompleted).toBe(true);
    expect(__formatContributorsForTests()).toBe('');
  } finally {
    release();
    await server?.destroy();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});
