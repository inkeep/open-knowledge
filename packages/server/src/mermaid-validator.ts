/**
 * Advisory mermaid render-validation for the agent write path.
 *
 * Parses every ` ```mermaid ` fence of a post-write document body with the
 * SAME mermaid version the editor renders with, and reports grammar failures
 * as `RenderWarning[]` so the authoring agent can self-correct in-session.
 * Strictly advisory: no failure mode here may block, fail, or mutate a write
 * — storage never sanitizes; render-time layers do.
 *
 * Mermaid is browser-oriented: its dompurify module singleton binds to the
 * global `window` the first time it evaluates, and several diagram grammars
 * call into it at parse time. The init below installs happy-dom globals just
 * long enough to import mermaid and bind that singleton, then restores the
 * original globals — the server's `typeof document === 'undefined'`
 * environment guards hold before and after init, and all subsequent parses
 * (including lazy per-diagram-type chunk loads) run with clean globals.
 *
 * Global install/restore uses property-descriptor save/restore, NOT
 * `Object.assign` + `delete`: on Node 19+ some targets (`navigator`) are
 * getter-only own properties of `globalThis` — assign throws, and a plain
 * delete would permanently remove the Node built-in. Node is the primary
 * production runtime (npm CLI bin, desktop ELECTRON_RUN_AS_NODE spawn).
 */

import { detectFmRegion, type RenderWarning } from '@inkeep/open-knowledge-core';
import { getLogger } from './logger.ts';

const log = getLogger('mermaid-validator');

/** Per-fence input caps: byte size poorly proxies jison parse cost on its own. */
const MAX_FENCE_BYTES = 100_000;
const MAX_FENCE_LINES = 2_000;
/** Total fences parsed per document; caps latency added to write responses. */
const MAX_FENCES_PARSED = 20;
/**
 * Total wall-clock budget across a document's fences, checked BETWEEN parses.
 * A timer cannot preempt a synchronous jison parse mid-flight (the event loop
 * only regains control when the parse returns), so a single pathological
 * fence still blocks once — Worker isolation is the recorded escalation for
 * that. This budget bounds the aggregate: once exceeded, remaining fences
 * are skipped.
 */
const TOTAL_PARSE_BUDGET_MS = 2_000;
/** Response-size bound: at most this many warning entries per document. */
const MAX_WARNINGS = 10;
/** Mermaid's own message, first lines only, bounded for the wire. */
const MAX_MESSAGE_CHARS = 500;
/** Fence locator field cap — diagram type headers are short; anything longer truncates cleanly. */
const MAX_FIRST_LINE_CHARS = 200;

interface MermaidFence {
  /** First non-empty line of the fence body (locator aid; '' for empty fences). */
  firstLine: string;
  body: string;
}

type MermaidParseApi = {
  parse(text: string): Promise<unknown>;
};

type MermaidImporter = () => Promise<MermaidParseApi | null>;

let initPromise: Promise<MermaidParseApi | null> | null = null;
let importerOverride: MermaidImporter | null = null;

/** Test seam: replace the heavyweight mermaid import (pass null to restore). */
export function setMermaidImporterForTests(importer: MermaidImporter | null): void {
  importerOverride = importer;
  initPromise = null;
}

/**
 * Extract mermaid fences from a markdown body. CommonMark fence subset that
 * mirrors what the md pipeline promotes to the Mermaid view: an opening
 * fence of >=3 backticks or tildes (<=3 spaces indent) whose info-string
 * language token is exactly `mermaid`, closed by a same-character run of at
 * least the opening length (or EOF — CommonMark treats an unclosed fence as
 * running to the end, and the renderer receives it the same way).
 *
 * Deliberate sibling of `createCodeFenceTracker`
 * (`packages/core/src/utils/code-fence-tracker.ts`): the tracker is a boolean
 * inside-fence predicate shared by outline/asset consumers and extracts
 * neither language nor body, so this scanner owns its own boundary matching
 * rather than widening that shared contract. If either side's CommonMark §4.5
 * boundary rules change (fence chars, run lengths, indent, CRLF handling),
 * re-align the other. The canonical "is this fence mermaid" decision the
 * renderer uses is mdast `code.lang === 'mermaid'` (`mermaid-promoter.ts`);
 * the exact `mermaid` info-string token below mirrors it.
 */
export function extractMermaidFences(body: string): MermaidFence[] {
  const fences: MermaidFence[] = [];
  const lines = body.split('\n');
  // CRLF tolerance (matches createCodeFenceTracker): splitting on '\n' leaves
  // a trailing '\r' that would defeat the closing fence's `$` anchor.
  const fenceLine = (line: string) => (line.endsWith('\r') ? line.slice(0, -1) : line);
  let i = 0;
  while (i < lines.length) {
    const line = fenceLine(lines[i] ?? '');
    const open = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/);
    if (!open) {
      i++;
      continue;
    }
    const marker = open[1] ?? '';
    const fenceChar = marker[0] ?? '`';
    // CommonMark: a backtick fence's info string may not contain backticks.
    if (fenceChar === '`' && line.slice(line.indexOf(marker) + marker.length).includes('`')) {
      i++;
      continue;
    }
    const lang = open[2] ?? '';
    const closeRe = new RegExp(`^ {0,3}\\${fenceChar}{${marker.length},}[ \t]*$`);
    const bodyLines: string[] = [];
    let j = i + 1;
    while (j < lines.length && !closeRe.test(fenceLine(lines[j] ?? ''))) {
      bodyLines.push(lines[j] ?? '');
      j++;
    }
    if (lang === 'mermaid') {
      const body = bodyLines.join('\n');
      const firstLine = (bodyLines.find((l) => l.trim().length > 0)?.trim() ?? '').slice(
        0,
        MAX_FIRST_LINE_CHARS,
      );
      fences.push({ firstLine, body });
    }
    // Skip past the closing fence line when one exists; at EOF, j === lines.length.
    i = j + 1;
  }
  return fences;
}

async function initMermaid(): Promise<MermaidParseApi | null> {
  if (importerOverride) return importerOverride();
  const { Window } = await import('happy-dom');
  const win = new Window({ url: 'http://localhost/' });
  const overrides: Record<string, unknown> = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    location: win.location,
    DOMParser: win.DOMParser,
    Element: win.Element,
    Node: win.Node,
    SVGElement: win.SVGElement,
    HTMLElement: win.HTMLElement,
    MutationObserver: win.MutationObserver,
  };
  const saved = new Map<string, PropertyDescriptor | undefined>();
  try {
    for (const [key, value] of Object.entries(overrides)) {
      saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
    const mermaid = (await import('mermaid')).default;
    mermaid.initialize({
      startOnLoad: false,
      // Parity with the editor's renderer config so accept/reject agree.
      securityLevel: 'strict',
      suppressErrorRendering: true,
    });
    // One throwaway parse binds the dompurify singleton to the transient
    // window; per-diagram-type chunks lazy-load fine after restore.
    await mermaid.parse('graph LR\n A-->B');
    return mermaid;
  } finally {
    for (const [key, desc] of saved) {
      if (desc) {
        Object.defineProperty(globalThis, key, desc);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
}

function getMermaid(docName: string): Promise<MermaidParseApi | null> {
  initPromise ??= initMermaid().catch((err) => {
    // Memoized permanent no-op for this process: writes are never affected
    // by validator availability. The doc that happened to trigger init aids
    // triage of platform-specific failures.
    log.warn(
      { err, 'doc.name': docName },
      'mermaid validator unavailable — render validation disabled for this process',
    );
    return null;
  });
  return initPromise;
}

function extractLineNumber(message: string): number | undefined {
  const match = message.match(/Parse error on line (\d+)/);
  if (!match?.[1]) return undefined;
  const line = Number(match[1]);
  return Number.isSafeInteger(line) && line > 0 ? line : undefined;
}

/**
 * Validate every mermaid fence of a post-write document snapshot. Returns
 * warning entries for fences that will fail to render, or undefined when
 * there is nothing to say (no fences, all valid, or validator unavailable).
 * Never throws.
 */
export async function validateMermaidFences(
  ytextSnapshot: string,
  docName: string,
): Promise<RenderWarning[] | undefined> {
  try {
    // Cheap pre-check before any scanning or lazy init.
    if (!ytextSnapshot.includes('mermaid')) return undefined;
    const { body } = detectFmRegion(ytextSnapshot);
    const fences = extractMermaidFences(body);
    if (fences.length === 0) return undefined;

    const initStartedAt = performance.now();
    const mermaid = await getMermaid(docName);
    if (mermaid === null) return undefined;
    // Budget measures parse time only — init is one-time and can exceed the
    // budget on a cold start (e.g. slow machines), which would otherwise
    // exhaust the 2s budget before the first fence is parsed.
    const parseStartedAt = performance.now();

    const warnings: RenderWarning[] = [];
    let parsed = 0;
    for (let i = 0; i < fences.length && warnings.length < MAX_WARNINGS; i++) {
      if (parsed >= MAX_FENCES_PARSED) break;
      if (performance.now() - parseStartedAt > TOTAL_PARSE_BUDGET_MS) {
        log.debug(
          { 'doc.name': docName, skippedFrom: i + 1, fences: fences.length },
          'mermaid validation budget exceeded — remaining fences skipped',
        );
        break;
      }
      const fence = fences[i];
      if (fence === undefined) continue;
      if (fence.body.length > MAX_FENCE_BYTES || fence.body.split('\n').length > MAX_FENCE_LINES) {
        log.debug(
          { 'doc.name': docName, fenceIndex: i + 1 },
          'mermaid fence over validation caps — skipped',
        );
        continue;
      }
      try {
        parsed++;
        await mermaid.parse(fence.body);
      } catch (err) {
        // TypeError marks an environment failure (a diagram type needing DOM
        // APIs the transient init did not provide) — not a grammar verdict.
        // Everything else mermaid throws here means the renderer will show
        // the error chrome instead of a diagram, so it IS a warning.
        if (err instanceof TypeError) {
          log.debug(
            { err, 'doc.name': docName, fenceIndex: i + 1 },
            'mermaid validation skipped fence — environment failure',
          );
          continue;
        }
        const rawMessage = err instanceof Error ? err.message : String(err);
        const message = rawMessage.slice(0, MAX_MESSAGE_CHARS);
        const line = extractLineNumber(rawMessage);
        warnings.push({
          kind: 'mermaid-parse-error',
          fenceIndex: i + 1,
          fenceFirstLine: fence.firstLine,
          message,
          ...(line !== undefined ? { line } : {}),
        });
      }
    }
    // Latency attribution: validation rides the write-response path, so a
    // slow parse must be traceable to this module rather than showing up
    // only as unexplained write latency. Includes one-time init when this
    // call triggered it (initStartedAt).
    const durationMs = Math.round(performance.now() - initStartedAt);
    if (warnings.length === 0) {
      if (durationMs > 250) {
        log.debug(
          { 'doc.name': docName, durationMs, fences: fences.length },
          'mermaid validation slow (no warnings)',
        );
      }
      return undefined;
    }
    log.debug(
      { 'doc.name': docName, count: warnings.length, durationMs },
      'mermaid render warnings emitted',
    );
    return warnings;
  } catch (err) {
    // Advisory contract: validation can never fail the write path.
    log.warn({ err, 'doc.name': docName }, 'mermaid validation errored unexpectedly — skipped');
    return undefined;
  }
}
