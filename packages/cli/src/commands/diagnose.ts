/**
 * `ok diagnose process <pid>` — capture a diagnostic bundle for a running
 * open-knowledge server process without modifying production code or killing
 * the process.
 *
 * Captures by default:
 *   metadata.json          — process info, binary, content dir, lock state
 *   lsof.txt               — all open files and network connections
 *   inspector-endpoints.json — Node inspector /json/list response
 *   cpu.cpuprofile         — V8 CPU profile (15 s by default)
 *   stacks.txt             — human-readable top call stacks
 *   process-stats.jsonl    — CPU/MEM/RSS samples taken during profiling
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import pc from 'picocolors';
import {
  type CollectBundleDeps,
  type CollectedBundle,
  collectBundle,
  writeBundle,
} from '../diagnose/bundle.ts';
import {
  discoverLockDirs,
  type ProcessUsage,
  processCommand,
  processUsage,
} from '../utils/process-scan.ts';
import { healthCommand } from './diagnose-health.ts';
import { inspectLock, type LockState } from './lock-state.ts';

// ---------------------------------------------------------------------------
// Process stats
// ---------------------------------------------------------------------------

interface ProcessStat {
  ts: string;
  pid: number;
  cpuPercent: number;
  memPercent: number;
  rssKb: number;
  vszKb: number;
}

function sampleProcessStat(pid: number): ProcessStat | null {
  const r = spawnSync('ps', ['-p', String(pid), '-o', '%cpu=,%mem=,rss=,vsz='], {
    encoding: 'utf-8',
    timeout: 2000,
  });
  if (r.error || !r.stdout?.trim()) return null;
  const [cpu, mem, rss, vsz] = r.stdout.trim().split(/\s+/);
  const cpuPercent = Number.parseFloat(cpu ?? '');
  const memPercent = Number.parseFloat(mem ?? '');
  const rssKb = Number.parseInt(rss ?? '', 10);
  const vszKb = Number.parseInt(vsz ?? '', 10);
  if (
    Number.isNaN(cpuPercent) ||
    Number.isNaN(memPercent) ||
    Number.isNaN(rssKb) ||
    Number.isNaN(vszKb)
  )
    return null;
  return { ts: new Date().toISOString(), pid, cpuPercent, memPercent, rssKb, vszKb };
}

// ---------------------------------------------------------------------------
// lsof
// ---------------------------------------------------------------------------

function collectLsof(pid: number): string | null {
  const r = spawnSync('lsof', ['-p', String(pid)], { encoding: 'utf-8', timeout: 5000 });
  return r.error || !r.stdout ? null : r.stdout;
}

/** Parse localhost LISTEN ports from `lsof` output. */
function localhostListenPorts(lsofOutput: string): number[] {
  const ports: number[] = [];
  for (const line of lsofOutput.split('\n')) {
    const m = line.match(/127\.0\.0\.1:(\d+)\s*\(LISTEN\)/);
    if (m) {
      const p = Number.parseInt(m[1] ?? '', 10);
      if (!Number.isNaN(p)) ports.push(p);
    }
  }
  return ports;
}

// ---------------------------------------------------------------------------
// Inspector endpoint discovery
// ---------------------------------------------------------------------------

function getInspectorEndpoints(port: number): unknown[] | null {
  const r = spawnSync('curl', ['-s', '--max-time', '2', `http://127.0.0.1:${port}/json/list`], {
    encoding: 'utf-8',
    timeout: 3000,
  });
  if (r.error || !r.stdout?.trim()) return null;
  try {
    const parsed = JSON.parse(r.stdout);
    return Array.isArray(parsed) ? (parsed as unknown[]) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CDP profiler
// ---------------------------------------------------------------------------

function writeCdpScript(wsUrl: string, profileMs: number, outputPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-cdp-'));
  const path = join(dir, 'profiler.mjs');
  writeFileSync(
    path,
    `import { writeFileSync } from 'node:fs';
const ws = new WebSocket(${JSON.stringify(wsUrl)});
let id = 0;
const send = (m) => ws.send(JSON.stringify({ id: ++id, method: m }));
ws.addEventListener('open', () => {
  send('Profiler.enable');
  send('Profiler.start');
  setTimeout(() => send('Profiler.stop'), ${profileMs});
});
ws.addEventListener('message', ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.result?.profile) {
    writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(msg.result.profile));
    ws.close();
  }
});
ws.addEventListener('close', () => process.exit(0));
ws.addEventListener('error', () => process.exit(1));
setTimeout(() => process.exit(2), ${profileMs + 10000});
`,
  );
  return path;
}

async function runProfiler(
  wsUrl: string,
  profileMs: number,
  pid: number,
  outDir: string,
  onStat: (s: ProcessStat) => void,
): Promise<boolean> {
  const profilePath = join(outDir, 'cpu.cpuprofile');
  const scriptPath = writeCdpScript(wsUrl, profileMs, profilePath);

  let succeeded = false;
  const child = spawn(process.execPath, [scriptPath], { stdio: 'ignore' });
  const interval = setInterval(() => {
    const s = sampleProcessStat(pid);
    if (s) onStat(s);
  }, 1000);

  await new Promise<void>((resolve) => {
    child.once('close', (code) => {
      succeeded = code === 0;
      resolve();
    });
    setTimeout(() => {
      child.kill();
      resolve();
    }, profileMs + 12000);
  });
  clearInterval(interval);

  try {
    rmSync(join(scriptPath, '..'), { recursive: true, force: true });
  } catch {
    // best-effort tmpdir cleanup
  }

  return succeeded;
}

// ---------------------------------------------------------------------------
// Stacks summary
// ---------------------------------------------------------------------------

type CpuProfile = {
  nodes: Array<{
    id: number;
    hitCount?: number;
    callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
    children?: number[];
  }>;
  samples?: number[];
  startTime?: number;
  endTime?: number;
};

function summarizeProfile(profileJson: string): string {
  let profile: CpuProfile;
  try {
    profile = JSON.parse(profileJson) as CpuProfile;
  } catch {
    return '(could not parse profile)';
  }

  const nodeMap = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes) {
    for (const childId of node.children ?? []) {
      parent.set(childId, node.id);
    }
  }

  const sampleCounts = new Map<number, number>();
  for (const sid of profile.samples ?? []) {
    sampleCounts.set(sid, (sampleCounts.get(sid) ?? 0) + 1);
  }

  const total = profile.samples?.length ?? 0;
  const durationMs =
    profile.endTime != null && profile.startTime != null
      ? ((profile.endTime - profile.startTime) / 1000).toFixed(2)
      : '?';

  const sorted = [...sampleCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const lines: string[] = [`samples ${total} duration_ms ${durationMs}`, '', 'Top leaf nodes'];

  for (const [nodeId, count] of sorted) {
    const node = nodeMap.get(nodeId);
    if (!node) continue;
    const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
    const { functionName, url, lineNumber, columnNumber } = node.callFrame;
    lines.push(
      ` ${count} ${pct}% id=${nodeId} ${functionName || '(anonymous)'} ${url}:${lineNumber}:${columnNumber} hit=${node.hitCount ?? 0}`,
    );
  }

  lines.push('', 'Top stacks');

  const walkStack = (nodeId: number): string[] => {
    const stack: string[] = [];
    let cur: number | undefined = nodeId;
    while (cur != null) {
      const n = nodeMap.get(cur);
      if (!n) break;
      const { functionName, url, lineNumber, columnNumber } = n.callFrame;
      stack.unshift(`  ${functionName || '(anonymous)'}  ${url} ${lineNumber} ${columnNumber}`);
      cur = parent.get(cur);
    }
    return stack;
  };

  for (const [nodeId, count] of sorted.slice(0, 5)) {
    const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
    lines.push('', `--- ${count} ${pct}%`, ...walkStack(nodeId));
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Injectable deps + options (for testing)
// ---------------------------------------------------------------------------

interface DiagnoseProcessDeps {
  discover?: () => Promise<string[]>;
  inspect?: (lockDir: string, name: 'server' | 'ui') => LockState;
  resolveCommand?: (pid: number) => string | null;
  resolveUsage?: (pid: number) => ProcessUsage | null;
  collectLsofFn?: (pid: number) => string | null;
  getEndpoints?: (port: number) => unknown[] | null;
  profiler?: (
    wsUrl: string,
    profileMs: number,
    pid: number,
    outDir: string,
    onStat: (s: ProcessStat) => void,
  ) => Promise<boolean>;
  isAlive?: (pid: number) => boolean;
  sendSignal?: (pid: number, signal: string) => void;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

interface RunDiagnoseOpts {
  pid: number;
  cpuProfileSecs?: number;
  output?: string;
  noInspector?: boolean;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

export async function runDiagnose(
  opts: RunDiagnoseOpts,
  deps: DiagnoseProcessDeps = {},
): Promise<void> {
  const { pid, cpuProfileSecs = 15, noInspector = false } = opts;
  const log = deps.log ?? ((m: string) => console.log(m));
  const discover = deps.discover ?? discoverLockDirs;
  const inspect = deps.inspect ?? inspectLock;
  const resolveCmd = deps.resolveCommand ?? processCommand;
  const resolveUsage = deps.resolveUsage ?? processUsage;
  const lsofFn = deps.collectLsofFn ?? collectLsof;
  const endpointsFn = deps.getEndpoints ?? getInspectorEndpoints;
  const profilerFn = deps.profiler ?? runProfiler;
  const isAlive =
    deps.isAlive ??
    ((p: number): boolean => {
      try {
        process.kill(p, 0);
        return true;
      } catch (err) {
        // EPERM: process exists but we lack signal permission — still alive
        return (err as NodeJS.ErrnoException).code === 'EPERM';
      }
    });
  const sendSignal =
    deps.sendSignal ??
    ((p: number, sig: string) => {
      process.kill(p, sig as NodeJS.Signals);
    });
  const sleepFn = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const profileMs = cpuProfileSecs * 1000;

  // Verify process is alive
  if (!isAlive(pid)) {
    log(pc.red(`No process with pid ${pid} found.`));
    return;
  }

  // Discover lock to get content dir (single pass — also used for lockInfo in metadata)
  const lockDirs = await discover();
  let contentDir: string | null = null;
  let lockInfo: unknown = null;
  for (const lockDir of lockDirs) {
    const s = inspect(lockDir, 'server');
    if (s.status !== 'missing' && s.status !== 'corrupt' && s.lock.pid === pid) {
      contentDir = s.lock.worktreeRoot;
      lockInfo = { lockDir, state: s.status, lockPath: s.lockPath, lock: s.lock };
      break;
    }
  }

  // Output directory
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = opts.output
    ? opts.output
    : contentDir
      ? join(contentDir, '.ok', 'local', 'diagnostics', `process-${pid}-${ts}`)
      : join(process.cwd(), `ok-diagnose-${pid}-${ts}`);
  try {
    mkdirSync(outDir, { recursive: true });
  } catch (err) {
    log(
      pc.red(`Cannot create output directory ${outDir}: ${(err as NodeJS.ErrnoException).message}`),
    );
    return;
  }

  log(pc.bold(`Diagnosing pid ${pid}`));
  log(`Output: ${outDir}`);
  log('');

  const write = (name: string, content: string): void => {
    writeFileSync(join(outDir, name), content);
    log(`  wrote ${name}`);
  };

  // 1. Metadata
  const command = resolveCmd(pid);
  const usage = resolveUsage(pid);
  write(
    'metadata.json',
    JSON.stringify(
      { capturedAt: new Date().toISOString(), pid, command, usage, lockInfo },
      null,
      2,
    ),
  );

  // 2. lsof
  log('  sampling lsof');
  const lsofOutput = lsofFn(pid);
  if (lsofOutput) write('lsof.txt', lsofOutput);

  if (!noInspector) {
    // 3. Find inspector port from lsof (Node inspector always binds 127.0.0.1)
    const inspectorPort = lsofOutput
      ? (localhostListenPorts(lsofOutput).find((p) => p >= 9229 && p <= 9299) ?? 9229)
      : 9229;

    let endpoints = endpointsFn(inspectorPort);

    if (!endpoints || endpoints.length === 0) {
      log(`  no inspector on :${inspectorPort}, sending SIGUSR1 to pid ${pid}`);
      try {
        sendSignal(pid, 'SIGUSR1');
        await sleepFn(2000);
        endpoints = endpointsFn(inspectorPort);
      } catch (err) {
        log(pc.yellow(`  SIGUSR1 delivery failed: ${(err as NodeJS.ErrnoException).message}`));
      }
    }

    if (endpoints && endpoints.length > 0) {
      write('inspector-endpoints.json', JSON.stringify(endpoints, null, 2));
      const wsUrl = (endpoints[0] as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl;
      if (wsUrl) {
        log(`  capturing ${cpuProfileSecs}s CPU profile`);
        const stats: ProcessStat[] = [];
        const ok = await profilerFn(wsUrl, profileMs, pid, outDir, (s) => stats.push(s));
        if (ok) {
          log('  wrote cpu.cpuprofile');
        } else {
          log(pc.yellow('  CPU profile capture failed'));
        }
        if (stats.length > 0) {
          write('process-stats.jsonl', `${stats.map((s) => JSON.stringify(s)).join('\n')}\n`);
        }
        try {
          const profileJson = readFileSync(join(outDir, 'cpu.cpuprofile'), 'utf-8');
          write('stacks.txt', summarizeProfile(profileJson));
        } catch (err) {
          log(pc.yellow(`  stacks.txt skipped: ${(err as NodeJS.ErrnoException).message}`));
        }
      }
    } else {
      log(pc.yellow('  Node inspector unavailable — skipping CPU profile'));
    }
  }

  // Privacy warning
  log('');
  log(pc.yellow('⚠  Before sharing, review what each file contains:'));
  log(
    '  metadata.json           — content directory paths, lock file locations, CPU/MEM at capture time',
  );
  log(
    '  lsof.txt                — all open files, network connections, and private paths for this process',
  );
  log('  inspector-endpoints.json — Node debugger metadata (titles, URLs)');
  log('  cpu.cpuprofile          — function names and source file paths from your Node process');
  log('  stacks.txt              — call stacks derived from cpu.cpuprofile; includes source paths');
  log('  process-stats.jsonl     — CPU/MEM/RSS numbers only; safe to share');
  log('');
  log(`Bundle: ${pc.bold(outDir)}`);
}

// ---------------------------------------------------------------------------
// `ok diagnose bundle` — telemetry/logs/state zip for bug reports
// ---------------------------------------------------------------------------

export interface RunDiagnoseBundleOpts {
  /** Project content directory (where `.ok/local/` lives). */
  contentDir: string;
  /**
   * Project root (where `.ok/config.yml` lives). Defaults to `contentDir`.
   * Forwarded to the collector so the manifest's `telemetry.localSink` block
   * reads from the project root rather than the content directory.
   */
  projectDir?: string;
  /** Optional PID — when set, runs `ok diagnose process <pid>` into a tmp dir and includes the output under `process/`. */
  pid?: number;
  /** Optional output path. Defaults to `<contentDir>/.ok/local/diagnostics/bundle-<ISO ts>.zip`. */
  out?: string;
  /** Skip the y/N prompt and write unconditionally. */
  yes?: boolean;
  /**
   * Apply `--redact`: hash `doc.name` attribute values in staged JSONLs and
   * replace the absolute content-dir prefix with the literal `<CONTENT_DIR>`
   * token. Originals under `<contentDir>/.ok/local/` are NOT modified — the
   * redactor mutates only the staged copies inside the bundle.
   */
  redact?: boolean;
}

export interface RunDiagnoseBundleResult {
  /** Absolute path to the written zip, or `null` if the user declined the prompt. */
  outputPath: string | null;
  /** True iff the user said no to the prompt. */
  declined: boolean;
}

export interface RunDiagnoseBundleDeps {
  /** Prints a single line to the terminal. */
  log?: (msg: string) => void;
  /** Asks the user for one trimmed line of input (production reads stdin). */
  prompt?: (question: string) => Promise<string>;
  /**
   * Invokes the existing process-diagnose flow into a fresh tmp dir and
   * returns the dir. Tests stub this to skip CDP/lsof side effects.
   */
  runProcessDiagnose?: (pid: number) => Promise<string>;
  /** Injected into `collectBundle` — see `CollectBundleDeps`. */
  collectDeps?: CollectBundleDeps;
  /**
   * Override for the timestamp used in the default output filename. Defaults
   * to `new Date()`. Tests pin this so the output path is deterministic.
   */
  now?: () => Date;
}

async function defaultPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function defaultRunProcessDiagnose(pid: number): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'ok-bundle-process-'));
  await runDiagnose({ pid, output: dir });
  return dir;
}

/**
 * Format bytes as a short human string (e.g. "1.2 MB"). For the y/N prompt
 * summary only — not parsed downstream. KiB-style binary units match what
 * macOS Finder + most CLI tools show.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * y / yes (case-insensitive, leading/trailing whitespace trimmed). Anything
 * else — including empty input from a bare Enter — counts as decline. Matches
 * the y/N convention spelled out in the prompt.
 */
function isAffirmative(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a === 'y' || a === 'yes';
}

function printSummary(
  log: (msg: string) => void,
  collected: CollectedBundle,
  outputPath: string,
): void {
  const { summary, manifest } = collected;
  log('');
  log(pc.bold('ok diagnose bundle — content summary'));
  log('');
  log(`  Files:               ${summary.fileCount}`);
  log(`  Total size:          ${formatBytes(summary.totalBytes)} uncompressed`);
  log(
    `  doc.name attributes:  ${summary.docNameCount} occurrence(s) in telemetry${
      summary.redacted ? ' (values hashed)' : ''
    }`,
  );
  log(
    `  Content-dir path:    ${summary.contentDirVisible ? `visible (${manifest.contentDir.absolutePath})` : 'not visible'}`,
  );
  log(`  Redacted:            ${summary.redacted ? 'yes' : 'no'}`);
  log(`  Server status:       ${manifest.serverStatus}`);
  log(`  Output:              ${outputPath}`);
  log('');
}

export async function runDiagnoseBundle(
  opts: RunDiagnoseBundleOpts,
  deps: RunDiagnoseBundleDeps = {},
): Promise<RunDiagnoseBundleResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const prompt = deps.prompt ?? defaultPrompt;
  const runProcess = deps.runProcessDiagnose ?? defaultRunProcessDiagnose;
  const now = deps.now ?? (() => new Date());

  // Resolve the default output path (or honor --out). When --out is supplied,
  // validate the parent BEFORE collecting — fail fast so we don't stage a
  // bundle the user will never see.
  let outputPath: string;
  if (opts.out !== undefined) {
    outputPath = opts.out;
    const parent = dirname(outputPath);
    if (!existsSync(parent)) {
      throw new Error(
        `ok diagnose bundle: --out parent directory does not exist: ${parent}. Create it first.`,
      );
    }
  } else {
    const ts = now().toISOString().replace(/[:.]/g, '-');
    const defaultDir = join(opts.contentDir, '.ok', 'local', 'diagnostics');
    mkdirSync(defaultDir, { recursive: true });
    outputPath = join(defaultDir, `bundle-${ts}.zip`);
  }

  // If --pid passed, run process diagnose into a tmp dir first; pass the
  // resulting dir to collectBundle so it lands under `process/`.
  let processDir: string | undefined;
  if (opts.pid !== undefined) {
    log(pc.dim(`Running ok diagnose process ${opts.pid} into a temp dir`));
    processDir = await runProcess(opts.pid);
  }

  const collected = await collectBundle({
    contentDir: opts.contentDir,
    projectDir: opts.projectDir,
    processDir,
    redact: opts.redact === true,
    deps: deps.collectDeps,
  });

  try {
    if (collected.manifest.serverStatus === 'not-running') {
      log(pc.yellow('  server not running — live state unavailable'));
    }
    printSummary(log, collected, outputPath);

    if (opts.yes !== true) {
      const answer = await prompt('Write bundle? [y/N]: ');
      if (!isAffirmative(answer)) {
        log(pc.dim('Aborted; no bundle written.'));
        return { outputPath: null, declined: true };
      }
    }

    await writeBundle({ collected, outputPath });
    log(pc.bold(`Bundle: ${outputPath}`));
    return { outputPath, declined: false };
  } finally {
    collected.cleanup();
    // Best-effort cleanup of the process-diagnose tmp dir. If a custom
    // `runProcessDiagnose` returned a caller-owned dir, this still tries to
    // remove it — the contract is "tmp dir owned by the runner."
    if (processDir !== undefined) {
      try {
        rmSync(processDir, { recursive: true, force: true });
      } catch {
        // The collector already snapshotted the contents into staging; a
        // failure to remove the tmp dir is not actionable for the user.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Commander command
// ---------------------------------------------------------------------------

export function diagnoseCommand(): Command {
  const root = new Command('diagnose').description(
    'Diagnostic utilities for open-knowledge processes',
  );

  root
    .command('process')
    .description('Capture a diagnostic bundle (metadata, lsof, CPU profile) for a running process')
    .argument('<pid>', 'Process ID to diagnose')
    .option('--cpu-profile <seconds>', 'CPU profile duration (default: 15)', '15')
    .option('--output <dir>', 'Output directory')
    .option('--no-inspector', 'Collect metadata only; skip Node inspector and CPU profile')
    .action(
      async (pidStr: string, opts: { cpuProfile: string; output?: string; inspector: boolean }) => {
        const pid = Number.parseInt(pidStr, 10);
        if (Number.isNaN(pid) || pid <= 0) {
          console.error(pc.red(`Invalid pid '${pidStr}': must be a positive integer`));
          process.exit(1);
        }
        const cpuProfileSecs = Number.parseInt(opts.cpuProfile, 10);
        if (Number.isNaN(cpuProfileSecs) || cpuProfileSecs <= 0) {
          console.error(pc.red('--cpu-profile must be a positive integer'));
          process.exit(1);
        }
        await runDiagnose({
          pid,
          cpuProfileSecs,
          output: opts.output,
          noInspector: !opts.inspector,
        });
      },
    );

  root.addCommand(healthCommand());

  root
    .command('bundle')
    .description(
      'Capture a support bundle (telemetry + logs + server state) into a zip suitable for bug reports',
    )
    .option(
      '--pid <pid>',
      'Include `ok diagnose process <pid>` output under process/ in the bundle',
    )
    .option('--out <path>', 'Write the zip to this path instead of the default location')
    .option('--yes', 'Skip the y/N prompt')
    .option('--redact', 'Hash doc names and strip the content-dir prefix from the staged bundle')
    .action(async (opts: { pid?: string; out?: string; yes?: boolean; redact?: boolean }) => {
      let pid: number | undefined;
      if (opts.pid !== undefined) {
        pid = Number.parseInt(opts.pid, 10);
        if (Number.isNaN(pid) || pid <= 0) {
          console.error(pc.red(`Invalid --pid '${opts.pid}': must be a positive integer`));
          process.exit(1);
        }
      }
      try {
        const { loadConfig } = await import('../config/loader.ts');
        const { resolveContentDir } = await import('@inkeep/open-knowledge-server');
        const cwd = process.cwd();
        const { config } = loadConfig(cwd);
        const contentDir = resolveContentDir(config, cwd);
        await runDiagnoseBundle({
          contentDir,
          projectDir: cwd,
          pid,
          out: opts.out,
          yes: opts.yes === true,
          redact: opts.redact === true,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(pc.red(msg));
        process.exit(1);
      }
    });

  return root;
}
