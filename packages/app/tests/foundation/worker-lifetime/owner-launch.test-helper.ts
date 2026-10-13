import { type ChildProcess, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { z } from 'zod';

export const HELPERS_DIR = import.meta.dirname;
export const APP_DIR = join(HELPERS_DIR, '..', '..', '..');
export const identitySchema = z.object({
  pid: z.number().int().positive(),
  found: z.boolean(),
  uid: z.number().int().optional(),
  stamp: z.string().optional(),
  state: z.string().optional(),
  ppid: z.number().int().optional(),
  executable: z.string().optional(),
});
export type ProcessIdentity = z.infer<typeof identitySchema>;

const nativeIdentity: {
  identifyAll(pids: number[], eventsPath?: string, runId?: string): unknown;
} = createRequire(import.meta.url)('./process-identity.cjs');

export function identities(pids: number[], dir: string, runId: string): ProcessIdentity[] {
  return z
    .array(identitySchema)
    .parse(nativeIdentity.identifyAll(pids, join(dir, 'events.jsonl'), runId));
}

export function isSameLiveIdentity(birth: ProcessIdentity, current: ProcessIdentity): boolean {
  return (
    birth.found &&
    current.found &&
    birth.pid === current.pid &&
    birth.uid === current.uid &&
    birth.stamp === current.stamp &&
    current.state !== 'Z'
  );
}

export const cleanupSchema = z.object({
  runId: z.string(),
  reason: z.string(),
  at: z.number(),
  before: z.array(z.object({ birth: identitySchema, current: identitySchema })),
  after: z.array(z.object({ birth: identitySchema, current: identitySchema })),
  actions: z.array(
    z.object({
      recorded: identitySchema,
      verified: identitySchema,
      signal: z.string(),
      at: z.number(),
      error: z.string().optional(),
    }),
  ),
  liveSurvivors: z.array(z.object({ birth: identitySchema, current: identitySchema })),
  workDirAbsent: z.boolean(),
});
export type CleanupReceipt = z.infer<typeof cleanupSchema>;

export function readCleanup(dir: string): CleanupReceipt {
  return cleanupSchema.parse(JSON.parse(readFileSync(join(dir, 'cleanup.json'), 'utf8')));
}

export async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`condition did not settle in ${timeoutMs}ms`);
    await pause(25);
  }
}

export function makeRunDir(label: string): { dir: string; workDir: string; runId: string } {
  const root = process.env.OK_WORKER_LIFETIME_ARTIFACT_ROOT ?? tmpdir();
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, `ok-worker-lifetime-${label}-`));
  const workDir = join(dir, 'scratch');
  mkdirSync(workDir);
  const runId = randomUUID();
  writeFileSync(
    join(dir, 'intent.json'),
    `${JSON.stringify({ label, runId, at: Date.now(), outerPid: process.pid, node: process.version }, null, 2)}\n`,
  );
  return { dir, workDir, runId };
}

export type OwnerConfig = {
  dir: string;
  workDir: string;
  runId: string;
  cwd: string;
  args: string[];
  environment: Record<string, string>;
  deadlineMs: number;
};

export function writeOwnerConfig(config: OwnerConfig): string {
  const path = join(config.dir, 'owner-config.json');
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

export function launchRecorded(
  script: string,
  args: string[],
  dir: string,
  runId: string,
): {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
} {
  identities([process.pid], dir, runId);
  const child = fork(script, args, { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  if (child.pid === undefined) throw new Error(`process did not launch: ${script}`);
  const birth = identities([child.pid], dir, runId)[0];
  writeFileSync(
    join(dir, `outer-launch-${child.pid}.json`),
    `${JSON.stringify({ script, args, pid: child.pid, birth, at: Date.now(), runId }, null, 2)}\n`,
  );
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    },
  );
  return { child, exited };
}

const ownerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    runId: z.string(),
    type: z.literal('started'),
    pid: z.number(),
    childPid: z.number(),
    birth: identitySchema,
  }),
  z.object({
    runId: z.string(),
    type: z.literal('subject-exit'),
    exit: z.object({ code: z.number().nullable(), signal: z.string().nullable(), at: z.number() }),
  }),
  z.object({ runId: z.string(), type: z.literal('cleaned'), receipt: cleanupSchema }),
]);

export function startResourceOwner(config: OwnerConfig): {
  child: ChildProcess;
  subjectExit: Promise<{ code: number | null; signal: string | null; at: number }>;
  release: () => Promise<CleanupReceipt>;
} {
  const path = writeOwnerConfig(config);
  const { child, exited } = launchRecorded(
    join(HELPERS_DIR, 'resource-owner.cjs'),
    [path],
    config.dir,
    config.runId,
  );
  const {
    promise: subjectExit,
    resolve: resolveSubject,
    reject: rejectSubject,
  } = Promise.withResolvers<{ code: number | null; signal: string | null; at: number }>();
  child.on('message', (message: unknown) => {
    const parsed = ownerMessageSchema.parse(message);
    if (parsed.runId !== config.runId) throw new Error('foreign resource owner message');
    if (parsed.type === 'subject-exit') resolveSubject(parsed.exit);
  });
  void exited.then(() => {
    if (!existsSync(join(config.dir, 'exit.json')))
      rejectSubject(new Error(`resource owner exited before its subject; see ${config.dir}`));
  }, rejectSubject);
  return {
    child,
    subjectExit,
    release: async () => {
      if (child.connected) child.send({ type: 'release', runId: config.runId }, () => {});
      await exited;
      return readCleanup(config.dir);
    },
  };
}
