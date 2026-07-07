/**
 * Advisory-warning relay — shared across the write-path verb tools.
 *
 * A mutating-write success body carries `warnings`: the unified advisory
 * array, discriminated by `kind`. Two families with different remedies ride
 * the one channel — write-integrity entries (`content-divergence`: the
 * converged Y.Text doesn't byte-match what the write composed;
 * `disk-edit-reconciled`: an out-of-band disk edit was folded in before the
 * write landed on top — remedy: re-read) and content-renderability entries
 * (`mermaid-parse-error`: the write landed byte-faithfully but that fence
 * will not render — remedy: fix the fence and re-edit).
 *
 * These helpers parse the array and format its `⚠` text lines so `write`
 * (single + batch), `edit`, and `restore_version` relay advisories
 * identically: one line per integrity entry, one grouped line for render
 * entries.
 */
import {
  type AdvisoryWarning,
  AdvisoryWarningSchema,
  type BrokenLink,
  BrokenLinkSchema,
  type RenderWarning,
  type WriteWarning,
} from '@inkeep/open-knowledge-core';

/**
 * Parse the server's `warnings` field, or undefined when absent/empty.
 * Filters per element rather than all-or-nothing: when a future `kind` joins
 * the union, entries this relay doesn't recognize are dropped individually
 * instead of silently discarding the recognized ones alongside them.
 */
export function parseAdvisoryWarnings(value: unknown): AdvisoryWarning[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const warnings = value.flatMap((entry) => {
    const parsed = AdvisoryWarningSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  return warnings.length > 0 ? warnings : undefined;
}

/**
 * Parse the server's `brokenLinks` field (write-time link validation).
 * Unlike `parseAdvisoryWarnings`, this ALWAYS returns an array (never
 * undefined): `[]` is the meaningful "every outbound link resolves"
 * confirmation write/edit surface in the same response, so the agent never
 * needs a separate `links({ kind: 'dead' })` round-trip.
 */
export function parseBrokenLinks(value: unknown): BrokenLink[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = BrokenLinkSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Full `⚠` lines for broken outbound links (single-doc write + edit). Empty → no lines. */
export function formatBrokenLinkLines(links: BrokenLink[]): string[] {
  if (links.length === 0) return [];
  const header = `⚠ ${links.length} broken outbound link${
    links.length === 1 ? '' : 's'
  } — fix or remove (the write still landed):`;
  return [header, ...links.map((l) => `  • ${formatBrokenLink(l)}`)];
}

/** Brief `⚠` suffix for broken outbound links on a batch per-doc line. Empty → no brief. */
export function formatBrokenLinkBrief(links: BrokenLink[]): string | null {
  if (links.length === 0) return null;
  return `⚠ ${links.length} broken outbound link${
    links.length === 1 ? '' : 's'
  } (see brokenLinks).`;
}

function formatBrokenLink(link: BrokenLink): string {
  return link.resolvedTo
    ? `${link.href} → ${link.resolvedTo} (${link.reason})`
    : `${link.href} (${link.reason})`;
}

function integrityEntries(warnings: AdvisoryWarning[]): WriteWarning[] {
  return warnings.filter(
    (w): w is WriteWarning => w.kind === 'content-divergence' || w.kind === 'disk-edit-reconciled',
  );
}

function renderEntries(warnings: AdvisoryWarning[]): RenderWarning[] {
  return warnings.filter((w): w is RenderWarning => w.kind === 'mermaid-parse-error');
}

/** Full `⚠` lines (single-doc write + edit + restore): per integrity entry, plus one grouped render line. */
export function formatAdvisoryLines(warnings: AdvisoryWarning[]): string[] {
  const lines = integrityEntries(warnings).map(formatIntegrityLine);
  const render = renderEntries(warnings);
  if (render.length > 0) lines.push(formatRenderWarningsLine(render));
  return lines;
}

/** Brief `⚠` suffixes appended to a batch per-doc line. */
export function formatAdvisoryBriefs(warnings: AdvisoryWarning[]): string[] {
  const briefs = integrityEntries(warnings).map(formatIntegrityBrief);
  const render = renderEntries(warnings);
  if (render.length > 0) briefs.push(formatRenderWarningsBrief(render));
  return briefs;
}

/** Full `⚠` line for a write-integrity entry — includes the re-read hint. */
function formatIntegrityLine(d: WriteWarning): string {
  return d.kind === 'content-divergence'
    ? `⚠ Content divergence: ${d.actualBytes} actual bytes vs ${d.intendedBytes} intended (byteDelta=${d.byteDelta}). ${d.hint ?? 'currentState carries the converged content (re-read only if it is truncated).'}`
    : `⚠ ${d.hint ?? 'An out-of-band edit was reconciled into this document before your edit landed on top — re-read for the combined result.'}`;
}

/** Brief `⚠` suffix for a write-integrity entry on a batch per-doc line. */
function formatIntegrityBrief(d: WriteWarning): string {
  return d.kind === 'content-divergence'
    ? `⚠ Content divergence: ${d.actualBytes} actual vs ${d.intendedBytes} intended (byteDelta=${d.byteDelta}).`
    : '⚠ Out-of-band disk edit reconciled before this write — re-read for the combined result.';
}

/**
 * Full `⚠` line for the render family. The single-failure form inlines
 * mermaid's own message so a text-only consumer can fix the fence without
 * reading `warnings`. The server caps render entries at 10 per doc, so a
 * length of 10 reads as "10 or more".
 */
export function formatRenderWarningsLine(warnings: RenderWarning[]): string {
  const first = warnings[0];
  if (warnings.length === 1 && first) {
    const lineRef = first.line !== undefined ? ` (line ${first.line})` : '';
    const locator = first.fenceFirstLine === '' ? '(empty fence)' : `("${first.fenceFirstLine}")`;
    return `⚠ Mermaid fence ${first.fenceIndex} ${locator} will not render${lineRef}: ${firstMessageLine(first.message)} Fix the fence and re-edit.`;
  }
  const count = warnings.length >= 10 ? '10+' : String(warnings.length);
  return `⚠ ${count} mermaid fences will not render — see structuredContent.document.warnings (kind "mermaid-parse-error") for per-fence errors. Fix the fences and re-edit.`;
}

/** Brief `⚠` suffix for the render family on a batch per-doc line. */
export function formatRenderWarningsBrief(warnings: RenderWarning[]): string {
  const count = warnings.length >= 10 ? '10+' : String(warnings.length);
  return `⚠ ${count} mermaid fence${warnings.length === 1 ? '' : 's'} will not render (see warnings).`;
}

function firstMessageLine(message: string): string {
  const line = message.split('\n', 1)[0]?.trim() ?? '';
  return line.endsWith('.') || line.endsWith(':') ? line : `${line}.`;
}
