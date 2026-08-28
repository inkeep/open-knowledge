/**
 * Standard bug-report capture — the `ok bug-report` content set (user-level
 * logs, per-project lock/spawn-error files, local sink logs, sysinfo) packaged
 * into a redacted zip. Extracted from `bug-report.ts` for the same reason as
 * `bug-report-redact.ts`: `bug-report.ts` imports `cli.ts`, which parses argv
 * at module load, so it can't be imported by tests or by Electron main.
 * Desktop calls this in-process instead of shelling out to the CLI.
 *
 * CLI-facing concerns (stdout path echo, stderr redaction notice, Finder
 * reveal) stay in `bug-report.ts` — this module only collects and packages.
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { freemem, homedir, type as osType, platform, release, totalmem, uptime } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  type BundleManifest,
  type BundleRedaction,
  REPORT_SENT_MARKER_SUFFIX,
  REPORT_SIDECAR_BUNDLE_DIR,
  SERVER_CRASH_LOG,
} from '@inkeep/open-knowledge-core';
import { withHiddenWindowsConsole } from '@inkeep/open-knowledge-server';
import type { ZipFile } from 'yazl';
// Keep this import type-only: `diagnose/bundle.ts` imports from this module
// too, so a value import in either direction would form a runtime cycle.
import type { DesktopMetadata } from '../diagnose/bundle.ts';
import type { LanguageMetadata } from '../report-language.ts';
import { redactContent, SECRET_PATTERN_NAMES } from './bug-report-redact.ts';
import { DESKTOP_BUNDLE_ID } from './desktop-dispatch.ts';

/**
 * Where `ok bug-report` (and the desktop report flow) write bundles by
 * default. A function, not a module-level constant: `homedir()` is
 * env-sensitive, and freezing it at import time makes the value depend on
 * module load order (test processes mutate HOME).
 */
export function okBugReportsDir(): string {
  return join(homedir(), '.ok', 'bug-reports');
}

export function defaultBugReportZipPath(now: Date = new Date()): string {
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const dir = okBugReportsDir();
  const base = `${timestamp}-bugreport`;
  // The ms-precision ISO basename is the report's stable `id` once the retry
  // list makes it load-bearing, so it must be unique. Two same-millisecond
  // generations (a crash-invite capture coinciding with a manual report) would
  // otherwise collide and overwrite one bundle under one id — append a counter
  // on collision so both survive with distinct ids.
  let candidate = join(dir, `${base}.zip`);
  for (let counter = 2; existsSync(candidate); counter += 1) {
    candidate = join(dir, `${base}-${counter}.zip`);
  }
  return candidate;
}

/** Structural subset of a pino logger, so callers outside the CLI can inject their own. */
export interface BundleLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
}

/** File copied byte-for-byte into the bundle under `extra/` — never text-scrubbed. */
export interface BundleExtraFile {
  sourcePath: string;
  /** Zip entry name under `extra/`; defaults to the source file's basename. */
  zipName?: string;
}

export interface CollectStandardBundleOptions {
  /**
   * Project directory whose `.ok/local` artifacts (lock/spawn-error, local
   * sink logs) are captured and whose slug scopes the user-log filter. Omit
   * for a system-wide bundle: user-level logs + sysinfo only.
   */
  projectDir?: string;
  /** Apply the secret-pattern scrub to every bundled file. */
  redact: boolean;
  /**
   * Ship document names as written instead of as digests. Defaults to false,
   * because this collector's tier discloses logs and system info and says
   * nothing about which documents a session opened.
   *
   * Set only for a `full` bundle, whose consent covers them. That level
   * normally uses its own staging path and never reaches here — except when it
   * runs with no `projectDir`, where every full-only artifact is
   * project-scoped and the two levels collapse onto this collector. Passing the
   * level explicitly is what keeps the consented case consented there, rather
   * than leaving it to that coincidence.
   */
  revealDocNames?: boolean;
  /** Zip destination; parent directories are created as needed. */
  outputPath: string;
  /** Override the user-level logs directory (defaults to `~/.ok/logs`). */
  userLogsDir?: string;
  /**
   * Squirrel.Mac ShipIt install logs, already resolved by the caller (see
   * `collectShipItLogFiles`). Passed in rather than resolved here so this
   * collector keeps no implicit dependency on the real home directory — the
   * same reason `userLogsDir` is injectable, but enforced by construction.
   */
  shipItLogFiles?: string[];
  /**
   * Per-report send-ledger sidecars, already resolved by the caller (see
   * `collectBugReportLedgerFiles`). Injected rather than resolved here for the
   * same reason as `shipItLogFiles`: this collector keeps no implicit
   * dependency on the real home directory.
   */
  bugReportLedgerFiles?: string[];
  /** User note added as `note.txt`, scrubbed like any content file when `redact` is on. */
  note?: string;
  /** Extra files (e.g. an opted-in crash minidump) added under `extra/`. */
  extraFiles?: BundleExtraFile[];
  /**
   * Desktop host metadata recorded in `sysinfo.json` (and, through it, the
   * manifest). `null`/omitted reads as "not an Electron host" — mirroring the
   * full-level bundle's `host.desktop: null` convention.
   */
  desktop?: DesktopMetadata | null;
  /**
   * Interface-language metadata recorded in `sysinfo.json` (and, through it,
   * the manifest). Omitted reads as "the caller supplied no reader", which is
   * distinguishable from a bundle predating the field.
   */
  language?: LanguageMetadata | null;
  logger?: BundleLogger;
}

interface StandardBundleSummary {
  projectSlug: string | null;
  /** Zip entry names of the captured content files (mirrors MANIFEST.json `files`). */
  files: string[];
  /** Per-file redaction audit (mirrors MANIFEST.json `redactions`). */
  redactions: BundleRedaction[];
  /** Total lines scrubbed across all files. */
  redactedLineCount: number;
  generatedAt: string;
}

export interface StandardBundleResult {
  zipPath: string;
  summary: StandardBundleSummary;
}

export function resolveProjectSlug(cwd: string, logger?: BundleLogger): string | null {
  const configPath = join(cwd, '.ok', 'config.yml');
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, 'utf8');
      const nameMatch = content.match(/^\s*name:\s*['"]?(.+?)['"]?\s*$/m);
      if (nameMatch?.[1]) return nameMatch[1];
    } catch (err) {
      // A malformed/unreadable .ok/config.yml falls back to a path-hash slug
      // (or null), but log it so a missing/wrong project slug in the bundle is
      // diagnosable rather than silent — same rationale as resolveContentDir.
      logger?.warn(
        { configPath, err },
        'bug-report: failed to read .ok/config.yml for project slug; using path-hash fallback',
      );
    }
  }

  if (existsSync(join(cwd, '.ok'))) {
    return createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 12);
  }

  return null;
}

function collectSysinfo(): Record<string, unknown> {
  const info: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    platform: platform(),
    osType: osType(),
    osRelease: release(),
    hostname: '[redacted]',
    uptime: uptime(),
    freeMem: freemem(),
    totalMem: totalmem(),
    nodeVersion: process.version,
    bunVersion: process.versions.bun ?? null,
    v8Version: process.versions.v8 ?? null,
    pid: process.pid,
  };

  try {
    const ver = execSync(
      'sw_vers -productVersion 2>/dev/null',
      withHiddenWindowsConsole({ encoding: 'utf8' }),
    ).trim();
    info.macosVersion = ver;
  } catch {}

  try {
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      info.okVersion = pkg.version;
    }
  } catch {}

  return info;
}

// The writers that share `~/.ok/logs`, and whether their record schema can
// carry a `project` field at all. Only the CLI logger's pino base sets one; the
// desktop logger's base has no such key and the MCP stderr mirror is plain text
// rather than JSON — so a slug predicate is *inapplicable* to those families,
// not false for them, and must not decide whether they belong in a bundle.
// Anything absent from this table is treated as untaggable and retained, so a
// new writer joining this directory is collected without a collector change.
//
// Each prefix is owned independently, so a rename has three possible homes:
//   cli      `packages/cli/src/cli.ts` passes the name to the
//            `<name>.<date>.log` factory in `packages/server/src/file-logger.ts`,
//            which takes it from its caller rather than owning it
//   desktop  `packages/desktop/src/main/desktop-logger.ts` hardcodes its own
//   mcp      `packages/cli/src/mcp/stderr-mirror.ts` hardcodes its own
// TypeScript cannot see across those package boundaries, so a rename there has
// to be mirrored here; a stale entry degrades to "untaggable → retained",
// never to a dropped file.
const USER_LOG_FAMILIES = [
  { prefix: 'cli', projectTagged: true },
  { prefix: 'desktop', projectTagged: false },
  { prefix: 'mcp', projectTagged: false },
] as const satisfies readonly { prefix: string; projectTagged: boolean }[];

// Prefix-anchored rather than suffix-anchored so rotated files (`cli.<date>.log.2`)
// stay in the family that owns them.
function isProjectTaggable(file: string): boolean {
  const name = basename(file);
  return USER_LOG_FAMILIES.some((f) => f.projectTagged && name.startsWith(`${f.prefix}.`));
}

/**
 * User-level log files (`~/.ok/logs/*.log`), optionally narrowed to one
 * project. Shared with the full bundle so both report levels harvest the same
 * set — on desktop these carry the renderer console, which reaches no other
 * sink.
 *
 * Narrowing reaches only the log families whose records can carry a `project`
 * field; a family the slug cannot describe survives regardless of it. Within
 * the taggable family the filter stays best-effort: when no file matches the
 * slug, every file is returned rather than none, because a log that predates
 * project tagging is still better evidence than an empty bundle.
 */
export function collectUserLogFiles(projectSlug: string | null, logsDir: string): string[] {
  return collectLogs(projectSlug, logsDir).files;
}

/**
 * The one desktop-identity constant, re-exported so ShipIt-log collection and
 * `open -b` dispatch can never drift apart. Its own drift guard against
 * `electron-builder.yml`'s `appId` lives beside the declaration.
 */
export { DESKTOP_BUNDLE_ID };

/**
 * The two text log STREAMS Squirrel.Mac's ShipIt writes into its per-bundle
 * cache dir. `ShipItState.plist` sits beside them but is a binary plist —
 * staging it through the text scrub would garble it, and the swap narrative
 * lives in stderr regardless.
 *
 * These are stream names rather than filenames because ShipIt opens each one
 * with `ensureWritable`: when the existing file cannot be opened for writing it
 * appends `.1`, `.2`, … (walking as far as `.100`) and writes to that instead.
 * Squirrel's own source attributes the un-writable case to the log ending up
 * owned by root, which is exactly the state a machine whose installs escalate
 * gets into — so on the machines most worth collecting from, the base name
 * holds a stale log and the live run is in a suffixed sibling.
 */
const SHIPIT_LOG_STREAMS = ['ShipIt_stderr.log', 'ShipIt_stdout.log'] as const;

/**
 * How many files one stream may contribute, in suffix order.
 *
 * Spent on siblings when the base file is absent, which is what you want: once
 * the log is root-owned the base holds a stale run and every live one sits in a
 * sibling, so a missing base should not shrink what gets collected.
 *
 * Squirrel walks to `.100` and each file can reach megabytes, so an uncapped
 * collector would scale the bundle with how long a machine has been failing to
 * install. Lowest suffix first: Squirrel takes the FIRST candidate it can open,
 * so the low numbers are the ones still being written.
 *
 * Capped on file COUNT, not bytes — the bundle's overall size guard is what
 * bounds total volume, and splitting that budget per-source here would make one
 * noisy stream silently evict another.
 */
const SHIPIT_LOG_FILES_PER_STREAM = 4;

/**
 * Squirrel.Mac's own install logs (`~/Library/Caches/<bundleId>.ShipIt/`).
 *
 * ShipIt performs the bundle swap AFTER the app has exited, so no OK process
 * is alive to witness a failed install. The updater's boot-time detector can
 * report THAT an install did not take but never why — these logs are the only
 * artifact carrying ShipIt's own reason (the per-step move narration, the
 * NSError domain/code it aborted on, and its exit status).
 *
 * Matched on the exact bundle id rather than a `*.ShipIt` glob: every other
 * Squirrel app on the machine keeps its install history in a sibling directory,
 * and harvesting those would leak unrelated software's update history into a
 * bundle the user forwards to support. Exactness also makes a stale bundle id
 * fail safe — it degrades to "no ShipIt logs collected", never to another
 * app's logs being harvested.
 *
 * macOS-only by construction — on other platforms the caches dir does not
 * exist and this returns empty rather than special-casing the platform.
 */
export function collectShipItLogFiles(
  cachesDir: string,
  bundleId: string = DESKTOP_BUNDLE_ID,
): string[] {
  const shipItDir = join(cachesDir, `${bundleId}.ShipIt`);
  if (!existsSync(shipItDir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(shipItDir);
  } catch {
    // Same empty result as the missing-directory case above, and deliberately
    // indistinguishable from it downstream: the realistic reason a ShipIt dir
    // exists but cannot be read is the root ownership this whole collector is
    // built around, and there is nothing a bug reporter could do about it. The
    // absence shows up where it is actionable — the bundle simply carries no
    // ShipIt logs, which the reader can see.
    return [];
  }

  return SHIPIT_LOG_STREAMS.flatMap((stream) =>
    entries
      .map((entry) => {
        // Sorted as a number, so the base file leads and `.2` precedes `.10`.
        if (entry === stream) return { entry, suffix: -1 };
        if (!entry.startsWith(`${stream}.`)) return null;
        // Anchored on digits alone: the suffix is the only thing distinguishing
        // a fallback from a neighbour that merely shares the prefix.
        const suffix = entry.slice(stream.length + 1);
        return /^\d+$/.test(suffix) ? { entry, suffix: Number(suffix) } : null;
      })
      .filter((match) => match !== null)
      .sort((a, b) => a.suffix - b.suffix)
      .slice(0, SHIPIT_LOG_FILES_PER_STREAM)
      .map((match) => join(shipItDir, match.entry)),
  );
}

/**
 * How many REPORTS a bundle carries ledger records for. Retention keeps reports
 * around, so this directory grows without limit on a machine that files often,
 * and a bundle must not scale with a reporter's history. Each file is small and
 * bounded by construction (the writer caps the attempt list), so the count is
 * the only bound needed.
 *
 * Reports rather than files, because a report whose sidecar was unreadable at
 * send time leaves two: the sidecar and a `sent` marker. Counting files would
 * let the cut fall BETWEEN a pair, and adjacency in the sorted listing does not
 * prevent that — nothing aligns a fixed index to a report boundary. The half it
 * would drop is the marker, which for exactly that report is the only readable
 * send record, while keeping the corrupt sidecar that proves nothing. So the
 * unit of eviction is the report, and a pair is kept or dropped whole.
 */
export const MAX_BUNDLED_LEDGER_REPORTS = 25;

/**
 * The per-report send ledger: a small YAML record per report, recording every
 * send attempt with its outcome and reason.
 *
 * Usually that is one file, the report's sidecar. A report whose sidecar could
 * not be read when its send landed leaves a second, `<base>-bugreport.sent.yaml`,
 * holding the send time and the intake reference — for exactly that report the
 * marker IS the send record, since the sidecar beside it is the unreadable one.
 * The `.yaml` allowlist below is what carries it, which is why the marker is
 * named with that extension rather than a bare `.sent`; a test pins the
 * coupling, because narrowing the filter would drop it silently.
 *
 * This is the artifact that answers "did the send fail before, and how" — and
 * the only one that still answers it later, because `desktop.*.log` rotates on
 * a seven-day budget while a sidecar persists beside its zip. Without it, a
 * report about a failed send carries no account of the failure unless the
 * reporter happens to file it the same day, on a machine we can read.
 *
 * Records ONLY: `*.yaml` is an allowlist, not a filter, so the zips sitting
 * beside them in the same directory cannot be swept in. That matters twice —
 * a bundle must not contain other bundles, and the zips are the bulk of the
 * directory.
 *
 * Newest kept, ranked by name: report ids are timestamp-prefixed, so
 * lexicographic order IS chronological order and no `stat` call is needed. A
 * marker shares its report's timestamp prefix, so grouping by that prefix
 * collects each report's files without a second sort.
 */
export function collectBugReportLedgerFiles(bugReportsDir: string): string[] {
  if (!existsSync(bugReportsDir)) return [];
  try {
    const byReport = new Map<string, string[]>();
    for (const name of readdirSync(bugReportsDir)
      .filter((name) => name.endsWith('.yaml'))
      .sort()) {
      // Both of a report's files reduce to the same key, so they group together
      // and the slice below can never keep one without the other.
      const base = name.endsWith(REPORT_SENT_MARKER_SUFFIX)
        ? name.slice(0, -REPORT_SENT_MARKER_SUFFIX.length)
        : name.slice(0, -'.yaml'.length);
      const files = byReport.get(base);
      if (files === undefined) byReport.set(base, [name]);
      else files.push(name);
    }
    // Map preserves insertion order and the names arrived sorted, so the report
    // keys are already oldest-first.
    return [...byReport.values()]
      .slice(-MAX_BUNDLED_LEDGER_REPORTS)
      .flat()
      .map((name) => join(bugReportsDir, name));
  } catch {
    // An unreadable reports dir must cost the ledger, never the report the
    // user is trying to file.
    return [];
  }
}

function collectLogs(
  projectSlug: string | null,
  logsDir: string,
): { files: string[]; excludedByProjectSlug: number } {
  if (!existsSync(logsDir)) return { files: [], excludedByProjectSlug: 0 };

  const files = readdirSync(logsDir)
    .filter((f) => f.endsWith('.log') || /\.log\.\d+$/.test(f))
    .map((f) => join(logsDir, f));

  if (!projectSlug) return { files, excludedByProjectSlug: 0 };

  const taggable = files.filter(isProjectTaggable);
  // Retention is the fail-safe answer for a log we listed but then couldn't
  // read: the likeliest cause is a writer rotating it between the readdir and
  // the open, and an undecidable slug match must not silently discard
  // evidence. Tracked apart from the matches so that retention stays a
  // decision about this one file — counted as a match it would also speak for
  // the whole family, suppressing the keep-everything fallback and discarding
  // the readable siblings it was meant to protect.
  const unreadable: string[] = [];
  const matching = taggable.filter((f) => {
    try {
      return readFileSync(f, 'utf8').includes(`"project":"${projectSlug}"`);
    } catch {
      unreadable.push(f);
      return false;
    }
  });

  if (matching.length === 0) return { files, excludedByProjectSlug: 0 };

  const kept = new Set([...matching, ...unreadable]);
  return {
    files: files.filter((f) => !isProjectTaggable(f) || kept.has(f)),
    excludedByProjectSlug: taggable.length - kept.size,
  };
}

function collectLockDir(cwd: string): { files: string[] } {
  const lockDir = join(cwd, '.ok', 'local');
  if (!existsSync(lockDir)) return { files: [] };

  const candidates = ['server.lock', 'last-spawn-error.log', SERVER_CRASH_LOG];
  const found = candidates.map((f) => join(lockDir, f)).filter((f) => existsSync(f));

  return { files: found };
}

// Server-side diagnostic logs from the runtime pino file sink — including the
// `renderer` subsystem fed by the web client-log ingest (`/api/client-logs`).
// Path + filenames mirror `logsCurrentPath`/`logsPreviousPath` in
// `packages/server/src/telemetry-file-sink.ts`; hardcoded here so the CLI
// bug-report path doesn't pull in the server module graph.
function collectLocalSinkLogs(cwd: string): { files: string[] } {
  const logsDir = join(cwd, '.ok', 'local', 'logs');
  if (!existsSync(logsDir)) return { files: [] };

  const candidates = ['server-current.jsonl', 'server-prev.jsonl'];
  const found = candidates.map((f) => join(logsDir, f)).filter((f) => existsSync(f));

  return { files: found };
}

/**
 * Document names are a Detailed-diagnostics-tier field. This tier's consent
 * copy names "app & system info, recent app logs, and project server logs" and
 * says nothing about the documents a session opened, so this replaces every
 * `docName` / `doc.name` value with a digest before the bytes reach the zip.
 *
 * A digest rather than a fixed marker, following `contentDir` in the manifest,
 * which masks `absolutePath` while keeping `pathSha256` "a stable correlation
 * identifier for the recipient". Triage of the scroll and outline breadcrumbs
 * needs to group a document's marks and read its before/after sequence; it does
 * not need the title. Equal digests mean the same document, here and across
 * bundles.
 *
 * BE PRECISE ABOUT WHAT THIS BUYS, because the tempting sentence is wrong. It is
 * not that the name cannot be recovered. The digest is an unsalted SHA-256 over a
 * short, relative, highly guessable path, truncated to 48 bits, and the party
 * holding it is the one the name is being kept from — so confirming a GUESSED name
 * costs one hash, and a candidate list built once works on every bundle forever.
 * No salt fixes that: one the recipient can see is no obstacle to the recipient,
 * and a secret per-bundle salt would destroy the cross-bundle grouping above. What
 * this delivers is that a bundle no longer HANDS OVER the list — bulk readability
 * is gone, targeted confirmation is not. The stronger property has only one lever,
 * which is not sending the field at this tier at all.
 *
 * NOT gated on `redact`: that flag chooses whether to hunt for secrets in
 * content the user has agreed to send. This is a question of which tier the
 * field belongs to, and the answer does not change when a caller passes
 * `--no-redact`.
 *
 * TWO PASSES, because a document name reaches this tier in more than one shape.
 * The first is key-anchored and authoritative: it finds the field, and its body
 * pattern is the JSON string production — `(?:[^"\\]|\\.)*` consumes an escaped
 * pair whole and so cannot stop on an escaped quote or run past the real
 * terminator. Overshooting would eat the next field; undershooting would ship the
 * tail of the very name this is removing.
 *
 * The second sweeps the names the first pass LEARNED through the rest of the text,
 * because the same name also arrives interpolated into a message body — the
 * renderer's `[syncPromise] <name> resolved...` fires on every successful open,
 * and the server's `[reconcile] delete: <name>` and its siblings reach this tier
 * through `local-logs/`. Both duplicate a name they already pass as a field, which
 * is what makes the sweep sufficient and why fixing it here rather than at ten
 * emit sites loses a triager nothing.
 *
 * Its BOUND, stated rather than hoped: it can only mask a name that appears at
 * least once as a field IN THE SAME FILE. That holds for both sinks today because
 * every one of those call sites passes the name as a field too. A future emitter
 * that interpolates a name it never fields would slip through, and nothing here
 * would notice — which is the argument for eventually dropping the interpolations.
 *
 * Longest-first, so a name that is a prefix of another cannot be rewritten inside
 * it and leave the longer one's tail exposed.
 */
function pseudonymizeDocNames(content: string): { text: string; count: number } {
  let count = 0;
  const digests = new Map<string, string>();
  let text = content.replace(
    /("(?:docName|doc\.name|documentName)"\s*:\s*")((?:[^"\\]|\\.)*)"/g,
    (_match, prefix: string, value: string) => {
      count += 1;
      let digest = digests.get(value);
      if (digest === undefined) {
        digest = `doc#${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
        digests.set(value, digest);
      }
      return `${prefix}${digest}"`;
    },
  );

  for (const [value, digest] of [...digests].sort(([a], [b]) => b.length - a.length)) {
    // `split`/`join` rather than a built regex: a document name is arbitrary user
    // text and may carry regex metacharacters. An empty value is skipped because
    // splitting on '' would wedge a digest between every character.
    if (value.length === 0 || !text.includes(value)) continue;
    const parts = text.split(value);
    count += parts.length - 1;
    text = parts.join(digest);
  }

  return { text, count };
}

function addTextEntry(args: {
  zipfile: ZipFile;
  name: string;
  content: string;
  redact: boolean;
  revealDocNames?: boolean;
  bundleFiles: string[];
  redactions: BundleRedaction[];
}): void {
  // Tier gate first, so it applies on both arms — see `pseudonymizeDocNames`.
  const content = args.revealDocNames ? args.content : pseudonymizeDocNames(args.content).text;
  if (args.redact) {
    const { redacted, patterns, lineCount } = redactContent(content);
    args.zipfile.addBuffer(Buffer.from(redacted, 'utf8'), args.name);
    args.bundleFiles.push(args.name);
    if (patterns.length > 0) {
      args.redactions.push({ file: args.name, lineCount, patterns });
    }
  } else {
    args.zipfile.addBuffer(Buffer.from(content, 'utf8'), args.name);
    args.bundleFiles.push(args.name);
  }
}

function addContentFiles(args: {
  zipfile: ZipFile;
  files: string[];
  prefix: string;
  redact: boolean;
  revealDocNames?: boolean;
  bundleFiles: string[];
  redactions: BundleRedaction[];
  logger?: BundleLogger;
}): void {
  for (const file of args.files) {
    try {
      addTextEntry({
        zipfile: args.zipfile,
        name: `${args.prefix}/${basename(file)}`,
        content: readFileSync(file, 'utf8'),
        redact: args.redact,
        revealDocNames: args.revealDocNames,
        bundleFiles: args.bundleFiles,
        redactions: args.redactions,
      });
    } catch (err) {
      // A file we listed but can't read is dropped rather than aborting the
      // whole report; log it so the omission is diagnosable — the bundled
      // MANIFEST lists only what was written, never what was skipped.
      args.logger?.warn({ file, prefix: args.prefix, err }, 'bug-report: skipped unreadable file');
    }
  }
}

/**
 * Collect the standard bug-report content set and write it as a zip to
 * `outputPath`. Returns the zip path plus a summary mirroring the bundled
 * MANIFEST.json (file inventory + redaction audit).
 */
export async function collectStandardBundle(
  opts: CollectStandardBundleOptions,
): Promise<StandardBundleResult> {
  const { redact, outputPath, logger } = opts;
  const revealDocNames = opts.revealDocNames ?? false;
  const userLogsDir = opts.userLogsDir ?? join(homedir(), '.ok', 'logs');
  const projectSlug = opts.projectDir ? resolveProjectSlug(opts.projectDir, logger) : null;

  mkdirSync(dirname(outputPath), { recursive: true });

  logger?.info({ projectSlug }, 'gathering diagnostic data');

  const sysinfo = collectSysinfo();
  // Always present so a recipient can distinguish "not an Electron host"
  // (null) from a bundle predating the field (absent).
  sysinfo.desktop = opts.desktop ?? null;
  // The interface language the report was filed in. Always present for the same
  // reason, and `null` only for a caller that supplied no reader at all.
  sysinfo.language = opts.language ?? null;
  const { files: logFiles, excludedByProjectSlug: logFilesExcludedByProjectSlug } = collectLogs(
    projectSlug,
    userLogsDir,
  );
  const { files: lockFiles } = opts.projectDir ? collectLockDir(opts.projectDir) : { files: [] };
  const { files: localSinkFiles } = opts.projectDir
    ? collectLocalSinkLogs(opts.projectDir)
    : { files: [] };
  // Not project-scoped: ShipIt updates the whole app bundle, so its logs are
  // host-level evidence regardless of which project the report came from. The
  // scope disclosure below reports them as user-wide for exactly that reason.
  const shipItFiles = opts.shipItLogFiles ?? [];

  logger?.info(
    {
      logFileCount: logFiles.length,
      // The bundled MANIFEST lists only what was written, so without this the
      // narrowing decision leaves no trace a triager could read.
      logFilesExcludedByProjectSlug,
      lockFileCount: lockFiles.length,
      localSinkFileCount: localSinkFiles.length,
      shipItLogFileCount: shipItFiles.length,
    },
    'files collected',
  );

  const redactions: BundleRedaction[] = [];
  const bundleFiles: string[] = [];

  const { ZipFile } = await import('yazl');
  const zipfile = new ZipFile();

  addContentFiles({
    zipfile,
    files: [...logFiles, ...shipItFiles],
    prefix: 'logs',
    redact,
    revealDocNames,
    bundleFiles,
    redactions,
    logger,
  });
  addContentFiles({
    zipfile,
    files: lockFiles,
    prefix: 'lockdir',
    redact,
    revealDocNames,
    bundleFiles,
    redactions,
    logger,
  });
  addContentFiles({
    zipfile,
    files: localSinkFiles,
    prefix: 'local-logs',
    redact,
    revealDocNames,
    bundleFiles,
    redactions,
    logger,
  });
  // The send ledger. Scrubbed like every other content file here: a sidecar
  // carries the reporter's own note, so it is user-authored text, not machine
  // output.
  addContentFiles({
    zipfile,
    files: opts.bugReportLedgerFiles ?? [],
    prefix: REPORT_SIDECAR_BUNDLE_DIR,
    redact,
    revealDocNames,
    bundleFiles,
    redactions,
    logger,
  });

  for (const extra of opts.extraFiles ?? []) {
    try {
      // Raw bytes on purpose: extras are binary payloads (crash minidumps)
      // that the text scrub would corrupt.
      const raw = readFileSync(extra.sourcePath);
      const name = `extra/${extra.zipName ?? basename(extra.sourcePath)}`;
      zipfile.addBuffer(raw, name);
      bundleFiles.push(name);
    } catch (err) {
      // Unlike the best-effort log/lock sources, an extra is an artifact the
      // user explicitly opted into sharing — its absence must be traceable,
      // not silent.
      logger?.warn(
        { sourcePath: extra.sourcePath, err },
        'extra file unreadable; omitted from bundle',
      );
    }
  }

  if (opts.note) {
    addTextEntry({
      zipfile,
      name: 'note.txt',
      content: opts.note,
      redact,
      revealDocNames,
      bundleFiles,
      redactions,
    });
  }

  const sysinfoJson = JSON.stringify(sysinfo, null, 2);
  zipfile.addBuffer(Buffer.from(sysinfoJson, 'utf8'), 'sysinfo.json');
  bundleFiles.push('sysinfo.json');

  const manifest: BundleManifest = {
    generatedAt: new Date().toISOString(),
    disciplineVersion: '1.0.0',
    projectSlug,
    files: bundleFiles,
    redactions,
    sysinfo: sysinfo as Record<string, import('@inkeep/open-knowledge-core').Loggable>,
  };
  zipfile.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), 'MANIFEST.json');

  const totalRedacted = redactions.reduce((sum, r) => sum + r.lineCount, 0);

  // Disclosed independently of project scope, because the thing to disclose is
  // not scope. These are not the app's own logs at all — they are written by
  // the macOS update helper that swaps the app bundle after the app has
  // exited, so an unscoped bundle (where the scope note below correctly stays
  // silent) would otherwise ship a category of data the README never names.
  // Intersected with what was actually written, so a file that turned out to
  // be unreadable is not disclosed as present.
  const shipItEntryNames = new Set(shipItFiles.map((f) => `logs/${basename(f)}`));
  const installerLogEntries = bundleFiles.filter((f) => shipItEntryNames.has(f));

  // Disclosed independently of project scope, for a different reason than the
  // installer log above: a sidecar records the project its own report was filed
  // from, so a bundle filed from one project names every OTHER project this
  // machine has reported from. `collectLogs` narrows the families a slug CAN
  // narrow and reports what it dropped; this family cannot be narrowed that
  // way, because a system-wide report carries no slug at all and is routinely
  // the very record being reported on — filtering by slug would drop exactly
  // the evidence the ledger exists to preserve. So the scope is stated instead.
  // Intersected with what was actually written, so a sidecar that turned out to
  // be unreadable is never disclosed as present.
  const ledgerEntryNames = new Set(
    (opts.bugReportLedgerFiles ?? []).map((f) => `${REPORT_SIDECAR_BUNDLE_DIR}/${basename(f)}`),
  );
  const ledgerEntries = bundleFiles.filter((f) => ledgerEntryNames.has(f));

  // The families the slug cannot narrow are per-machine, per-day singletons, so
  // a project-scoped bundle still carries whatever else the machine was doing
  // that day. Secret scrubbing does not narrow this — it matches credentials,
  // not document titles or content — so the scope has to be stated rather than
  // left to be inferred from the `Project:` header.
  // Only meaningful against a declared project scope: an unscoped bundle
  // narrows nothing and is user-wide throughout, so there is no narrower
  // reading for the note to correct.
  // Installer logs are held out and disclosed above instead: they are not
  // per-day singletons, and listing them here would file them under a sentence
  // that is not true of them.
  const userWideLogEntries = projectSlug
    ? bundleFiles.filter(
        (f) => f.startsWith('logs/') && !isProjectTaggable(f) && !shipItEntryNames.has(f),
      )
    : [];

  const readme = [
    '# Bug Report Bundle',
    '',
    `Generated: ${manifest.generatedAt}`,
    `Project: ${projectSlug ?? '(unscoped)'}`,
    `Discipline version: ${manifest.disciplineVersion}`,
    '',
    '## Contents',
    '',
    ...bundleFiles.map((f) => `- ${f}`),
    '',
    '## Privacy',
    '',
    ...(userWideLogEntries.length > 0
      ? [
          'Scope: some collected logs are user-wide rather than project-scoped.',
          'These are written once per machine per day and can contain activity',
          'from other projects open on this machine, including captured console',
          'output:',
          ...userWideLogEntries.map((f) => `- ${f}`),
          '',
        ]
      : []),
    ...(installerLogEntries.length > 0
      ? [
          'Installer logs: written by the macOS update helper rather than by',
          'OpenKnowledge itself, and machine-wide rather than scoped to any one',
          'project. They record the install and update history of this app on',
          'this machine. Only this app is collected, never other applications',
          'that use the same update mechanism:',
          ...installerLogEntries.map((f) => `- ${f}`),
          '',
        ]
      : []),
    ...(ledgerEntries.length > 0
      ? [
          'Send history: a small record for each bug report previously generated',
          'on this machine — when it was generated, whether sending it',
          'succeeded, and why it failed if it did. This is what makes a failed',
          'send diagnosable at all. It is machine-wide rather than scoped to',
          'this project, so it names the other projects reports were filed',
          'from. It carries no document content:',
          ...ledgerEntries.map((f) => `- ${f}`),
          '',
        ]
      : []),
    ...(redact
      ? [
          'This bundle was auto-redacted before packaging.',
          `Patterns checked: ${SECRET_PATTERN_NAMES.join(', ')}`,
          totalRedacted > 0
            ? `${totalRedacted} line(s) were scrubbed across ${redactions.length} file(s).`
            : 'No redactions were needed.',
          'See MANIFEST.json for the full redaction audit report.',
          '',
          'This bundle is safe to attach to a GitHub issue.',
        ]
      : ['Redaction was disabled for this bundle; file contents are unmodified.']),
  ].join('\n');
  zipfile.addBuffer(Buffer.from(readme, 'utf8'), 'README.md');

  zipfile.end();
  const output = createWriteStream(outputPath);
  zipfile.outputStream.pipe(output);
  await new Promise<void>((resolvePromise, reject) => {
    output.on('close', resolvePromise);
    output.on('error', reject);
  });

  logger?.info(
    { bundlePath: outputPath, fileCount: bundleFiles.length, redactionCount: totalRedacted },
    'bundle written',
  );

  return {
    zipPath: outputPath,
    summary: {
      projectSlug,
      files: bundleFiles,
      redactions,
      redactedLineCount: totalRedacted,
      generatedAt: manifest.generatedAt,
    },
  };
}
