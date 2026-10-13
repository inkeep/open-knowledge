import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import {
  changedLoadedInputs,
  parseTestServerLoadedInputs,
} from '../../../../src/build/test-server-loaded-inputs.ts';
import {
  TEST_SERVER_IDENTITY_PATH,
  TEST_SERVER_LOADED_INPUTS_PATH,
  type TestServerStartupReceipt,
} from '../../../../src/build/test-server-startup-contract.ts';
import {
  reuseDecision,
  type ServerFingerprint,
  serverFingerprint,
} from '../../../foundation/test-server-inputs.ts';
import {
  compatibilityMismatch,
  type LeaseOutcome,
  type LeaseRequest,
  type LeaseVerdict,
  type RefusalReason,
  type SlotCompatibility,
  type SlotStatus,
  type WorkerServerEnv,
  workerServerEnvChange,
} from './lease-protocol.ts';

export interface OwnedServer {
  readonly proc: ChildProcess;
  readonly identity: TestServerStartupReceipt;
  readonly baseURL: string;
  readonly contentDir: string;
  release(): Promise<void>;
}

export type LaunchOwnedServer = (
  slot: number,
  workerServerEnv: WorkerServerEnv,
) => Promise<OwnedServer>;

export interface SupervisorOptions {
  readonly okRoot: string;
  readonly launch: LaunchOwnedServer;
  readonly identityTimeoutMs: number;
}

interface Lease {
  readonly token: string;
  readonly run: string;
  granted: boolean;
  lost: string | undefined;
}

interface OwnedSlotServer {
  readonly slot: number;
  readonly server: OwnedServer;
  readonly compatibility: SlotCompatibility;
  readonly fingerprint: ServerFingerprint;
}

interface SlotEntry {
  readonly slot: number;
  owned: OwnedSlotServer | undefined;
  lease: Lease | undefined;
  discardedBecause: string | undefined;
}

function isRunning(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

function describeExit(proc: ChildProcess): string {
  return proc.signalCode === null ? `with code ${proc.exitCode}` : `on ${proc.signalCode}`;
}

function sameIdentity(observed: unknown, expected: TestServerStartupReceipt): boolean {
  if (typeof observed !== 'object' || observed === null) return false;
  const fields = observed as Record<string, unknown>;
  return (
    fields.nonce === expected.nonce &&
    fields.address === expected.address &&
    fields.family === expected.family &&
    fields.port === expected.port
  );
}

export async function identityProblem(
  server: OwnedServer,
  timeoutMs: number,
): Promise<string | undefined> {
  let response: Response;
  try {
    response = await fetch(`${server.baseURL}${TEST_SERVER_IDENTITY_PATH}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return `its identity endpoint did not answer: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (response.status !== 200) return `its identity endpoint returned status ${response.status}`;
  let observed: unknown;
  try {
    observed = await response.json();
  } catch {
    return 'its identity endpoint did not return JSON';
  }
  return sameIdentity(observed, server.identity)
    ? undefined
    : 'its identity endpoint answers for a different server';
}

function displayPath(okRoot: string, path: string): string {
  const fromRoot = relative(okRoot, path);
  const outside = fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
  return outside ? path : fromRoot.split(sep).join('/');
}

async function loadedInputsProblem(
  server: OwnedServer,
  okRoot: string,
  timeoutMs: number,
): Promise<string | undefined> {
  let response: Response;
  try {
    response = await fetch(`${server.baseURL}${TEST_SERVER_LOADED_INPUTS_PATH}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return `its loaded-inputs endpoint did not answer: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (response.status !== 200)
    return `its loaded-inputs endpoint returned status ${response.status}`;
  let reported: unknown;
  try {
    reported = await response.json();
  } catch {
    return 'its loaded-inputs endpoint did not return JSON';
  }
  const loaded = parseTestServerLoadedInputs(reported);
  if (loaded === undefined) {
    return 'its loaded-inputs endpoint did not report the inputs its configuration loaded';
  }
  const changed = changedLoadedInputs(loaded);
  return changed.length === 0
    ? undefined
    : `its loaded configuration inputs changed: ${changed.map((path) => displayPath(okRoot, path)).join(', ')}`;
}

function refused(reason: RefusalReason, detail: string): LeaseOutcome {
  return { kind: 'refused', reason, detail };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WorkerServerSupervisor {
  readonly #options: SupervisorOptions;
  readonly #slots = new Map<number, SlotEntry>();
  readonly #abortedRuns = new Map<string, string>();
  readonly #releases = new Map<OwnedSlotServer, Promise<void>>();
  readonly #admissions = new Set<Promise<LeaseOutcome>>();
  #closed = false;

  constructor(options: SupervisorOptions) {
    this.#options = options;
  }

  async acquire(request: LeaseRequest): Promise<LeaseOutcome> {
    const admission = this.#admit(request);
    this.#admissions.add(admission);
    try {
      return await admission;
    } finally {
      this.#admissions.delete(admission);
    }
  }

  async #admit(request: LeaseRequest): Promise<LeaseOutcome> {
    if (this.#closed) return refused('supervisor-closed', 'the supervisor is shutting down');
    const aborted = this.#abortedRuns.get(request.run);
    if (aborted !== undefined) {
      return refused('run-aborted', `run ${request.run} lost an earlier lease: ${aborted}`);
    }
    if (request.worktree !== this.#options.okRoot) {
      return refused(
        'incompatible',
        `worktree ${request.worktree} is not this supervisor's worktree ${this.#options.okRoot}; it would test that checkout's code`,
      );
    }
    let entry = this.#slots.get(request.slot);
    if (entry?.lease !== undefined) {
      return refused('busy', `slot ${request.slot} is leased to run ${entry.lease.run}`);
    }
    if (entry?.owned !== undefined) {
      const mismatch = compatibilityMismatch(entry.owned.compatibility, request);
      if (mismatch !== undefined) return refused('incompatible', mismatch);
    }
    if (entry === undefined) {
      entry = {
        slot: request.slot,
        owned: undefined,
        lease: undefined,
        discardedBecause: undefined,
      };
      this.#slots.set(request.slot, entry);
    }
    const lease: Lease = {
      token: randomUUID(),
      run: request.run,
      granted: false,
      lost: undefined,
    };
    entry.lease = lease;

    let relaunchedBecause: string | null = entry.discardedBecause ?? null;
    const owned = entry.owned;
    if (owned !== undefined) {
      try {
        const unusable =
          workerServerEnvChange(owned.compatibility, request) ??
          (await this.#unusableReason(owned));
        if (unusable === undefined && entry.owned === owned) {
          return this.#granted(entry, lease, owned, false, null);
        }
        relaunchedBecause = unusable ?? 'its server was discarded while admission checked it';
        await this.#discard(entry, owned);
      } catch (error) {
        entry.lease = undefined;
        return refused(
          'launch-failed',
          `slot ${request.slot} could not check or discard its previous server: ${describe(error)}`,
        );
      }
    }
    if (this.#closed) {
      entry.lease = undefined;
      return refused(
        'supervisor-closed',
        'the supervisor shut down while admission checked the slot',
      );
    }

    let launched: OwnedSlotServer;
    try {
      launched = await this.#launch(request);
    } catch (error) {
      entry.lease = undefined;
      return refused(
        'launch-failed',
        `slot ${request.slot} could not start an owned server: ${describe(error)}`,
      );
    }
    if (this.#closed) {
      entry.lease = undefined;
      await this.#discard(entry, launched);
      return refused('supervisor-closed', 'the supervisor shut down while the slot was starting');
    }
    entry.owned = launched;
    entry.discardedBecause = undefined;
    this.#watchOwner(entry, launched);
    return this.#granted(entry, lease, launched, true, relaunchedBecause);
  }

  async verify(token: string): Promise<LeaseVerdict> {
    const entry = this.#entryLeasedTo(token);
    if (entry?.lease === undefined) return { held: false, reason: 'the lease is not held' };
    const { lease } = entry;
    if (lease.lost !== undefined) return { held: false, reason: lease.lost };
    const owned = entry.owned;
    if (owned === undefined) {
      return this.#lose(entry, lease, 'its server is no longer owned by the supervisor');
    }
    if (!isRunning(owned.server.proc)) {
      return this.#lose(
        entry,
        lease,
        `its server process exited ${describeExit(owned.server.proc)} during the lease`,
      );
    }
    const problem = await identityProblem(owned.server, this.#options.identityTimeoutMs);
    if (problem !== undefined) {
      return this.#lose(entry, lease, `its server identity changed during the lease: ${problem}`);
    }
    return lease.lost === undefined ? { held: true } : { held: false, reason: lease.lost };
  }

  release(token: string, discard: boolean): Promise<void> {
    return this.#endLease(token, discard ? 'its last holder discarded it' : undefined);
  }

  async abandon(token: string): Promise<void> {
    const entry = this.#entryLeasedTo(token);
    if (entry?.lease === undefined) return;
    const { run } = entry.lease;
    try {
      await this.#endLease(token, 'its holder disconnected without releasing it');
    } catch (error) {
      console.warn(
        `[server reuse] slot ${entry.slot}: discarding the server of run ${run}, whose lease connection closed without a release, failed: ${describe(error)}`,
      );
    }
  }

  status(): SlotStatus[] {
    return [...this.#slots.values()]
      .sort((left, right) => left.slot - right.slot)
      .map((entry) => ({
        slot: entry.slot,
        baseURL: entry.owned?.server.baseURL ?? null,
        config: entry.owned?.compatibility.config ?? null,
        leasedBy: entry.lease?.run ?? null,
      }));
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
    const discarding: Promise<void>[] = [];
    for (const entry of this.#slots.values()) {
      if (entry.lease !== undefined && entry.lease.lost === undefined) {
        entry.lease.lost = 'the supervisor shut down during the lease';
        this.#abortedRuns.set(entry.lease.run, entry.lease.lost);
      }
      if (entry.owned !== undefined) discarding.push(this.#discard(entry, entry.owned));
    }
    const discarded = Promise.allSettled(discarding);
    await Promise.allSettled(this.#admissions);
    await discarded;
    const failures = (
      await Promise.all(
        [...this.#releases].map(([owned, releasing]) =>
          releasing.then(
            () => [],
            (reason: unknown) => [{ slot: owned.slot, reason }],
          ),
        ),
      )
    ).flat();
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map(({ reason }) => reason),
        `releasing the owned servers failed: ${failures.map(({ slot, reason }) => `slot ${slot}: ${describe(reason)}`).join('; ')}`,
      );
    }
  }

  async #endLease(token: string, discardBecause: string | undefined): Promise<void> {
    const entry = this.#entryLeasedTo(token);
    if (entry?.lease === undefined) return;
    const reason = entry.lease.lost ?? discardBecause;
    entry.lease = undefined;
    const owned = entry.owned;
    if (owned === undefined || reason === undefined) return;
    entry.discardedBecause = reason;
    await this.#discard(entry, owned);
  }

  #entryLeasedTo(token: string): SlotEntry | undefined {
    for (const entry of this.#slots.values()) {
      if (entry.lease?.token === token) return entry;
    }
    return undefined;
  }

  async #unusableReason(owned: OwnedSlotServer): Promise<string | undefined> {
    const { server } = owned;
    if (!isRunning(server.proc)) return `its server process exited ${describeExit(server.proc)}`;
    if (!existsSync(server.contentDir)) return `its content root ${server.contentDir} is gone`;
    const problem = await identityProblem(server, this.#options.identityTimeoutMs);
    if (problem !== undefined) return `its server identity changed: ${problem}`;
    const decision = reuseDecision(
      owned.fingerprint,
      serverFingerprint(this.#options.okRoot, owned.compatibility.workerServerEnv),
    );
    if (!decision.reuse) {
      return `its consumed inputs changed: ${[...decision.changedInputs, ...decision.changedEnv].join(', ')}`;
    }
    return loadedInputsProblem(server, this.#options.okRoot, this.#options.identityTimeoutMs);
  }

  async #launch(request: LeaseRequest): Promise<OwnedSlotServer> {
    const compatibility: SlotCompatibility = {
      config: request.config,
      workerServerEnv: { ...request.workerServerEnv },
      serverMode: request.serverMode,
    };
    const fingerprint = serverFingerprint(this.#options.okRoot, compatibility.workerServerEnv);
    const server = await this.#options.launch(request.slot, compatibility.workerServerEnv);
    return { slot: request.slot, server, compatibility, fingerprint };
  }

  #granted(
    entry: SlotEntry,
    lease: Lease,
    owned: OwnedSlotServer,
    launched: boolean,
    relaunchedBecause: string | null,
  ): LeaseOutcome {
    lease.granted = true;
    return {
      kind: 'granted',
      token: lease.token,
      slot: entry.slot,
      baseURL: owned.server.baseURL,
      port: owned.server.identity.port,
      contentDir: owned.server.contentDir,
      launched,
      relaunchedBecause,
    };
  }

  #watchOwner(entry: SlotEntry, owned: OwnedSlotServer): void {
    owned.server.proc.on('error', (error: Error) => {
      if (entry.owned !== owned) return;
      const lease = entry.lease;
      let ending: Promise<unknown>;
      if (lease?.granted === true) {
        ending = this.#lose(
          entry,
          lease,
          `its server lifetime failed during the lease: ${describe(error)}`,
        );
      } else {
        entry.discardedBecause = `its server lifetime failed: ${describe(error)}`;
        ending = this.#discard(entry, owned);
      }
      ending.catch((releaseError: unknown) => {
        console.warn(
          `[server reuse] slot ${entry.slot}: releasing the server whose lifetime failed did not complete: ${describe(releaseError)}`,
        );
      });
    });
    owned.server.proc.once('exit', () => {
      const lease = entry.lease;
      if (entry.owned !== owned || lease?.granted !== true || lease.lost !== undefined) return;
      const reason = `its server process exited ${describeExit(owned.server.proc)} during the lease`;
      this.#lose(entry, lease, reason).catch((error: unknown) => {
        console.warn(
          `[server reuse] slot ${entry.slot}: releasing its exited server failed: ${describe(error)}`,
        );
      });
    });
  }

  async #lose(entry: SlotEntry, lease: Lease, reason: string): Promise<LeaseVerdict> {
    lease.lost ??= reason;
    this.#abortedRuns.set(lease.run, lease.lost);
    entry.discardedBecause = lease.lost;
    if (entry.owned !== undefined) await this.#discard(entry, entry.owned);
    return { held: false, reason: lease.lost };
  }

  #discard(entry: SlotEntry, owned: OwnedSlotServer): Promise<void> {
    if (entry.owned === owned) entry.owned = undefined;
    const pending = this.#releases.get(owned);
    if (pending !== undefined) return pending;
    const releasing = owned.server.release();
    this.#releases.set(owned, releasing);
    return releasing;
  }
}
