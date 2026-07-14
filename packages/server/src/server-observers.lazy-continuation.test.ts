/**
 * Bridge health checks on CommonMark lazy-continuation docs.
 *
 * A doc whose source carries a lazy continuation (an unindented wrapped line
 * inside a list item, a paragraph glued to a list's last line, a blockquote
 * continuation without the `> ` prefix) parses identically to its canonical
 * form (CommonMark §5.2), but serializes differently — `serialize(parse(md))
 * !== md`, and the difference sits deliberately OUTSIDE the normalizeBridge
 * tolerance set (step 7f keeps list/blockquote continuations divergent so the
 * router's residual-merge keeps protecting the raw bytes; the step-7f
 * pins live next to normalizeBridge).
 *
 * The health checks layered on top of that router must NOT treat this
 * resting canonicalization as a broken bridge: the fragment IS
 * `parse(ytext)` (Y.Text-is-truth, precedent #38), so neither the
 * observer-b watchdog throw/warn nor the split-brain rederive may fire on
 * organic lazy-continuation input. Genuine fragment↔Y.Text divergence
 * (content one side lacks) must keep firing — pinned by the control test.
 *
 * Uses a synthetic Y.Doc (no Hocuspocus), production-order seeding
 * (paired-write intake first, observer attach second) — the same rig as
 * `server-observers.test.ts`.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  MarkdownManager,
  normalizeBridge,
  prependFrontmatter,
  sharedExtensions,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { composeAndWriteRawBody } from './bridge-intake.ts';
import { __resetBridgeWatchdogForTests } from './bridge-watchdog.ts';
import { FILE_WATCHER_ORIGIN } from './external-change.ts';
import { getMetrics, resetMetrics } from './metrics.ts';
import { OBSERVER_SYNC_ORIGIN, setupServerObservers } from './server-observers.ts';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

function canonicalOf(raw: string): string {
  const { frontmatter, body } = stripFrontmatter(raw);
  return prependFrontmatter(frontmatter, mdManager.serialize(mdManager.parseWithFallback(body)));
}

/** Populate XmlFragment with markdown content via updateYFragment. */
function populateFragment(doc: Y.Doc, xmlFragment: Y.XmlFragment, md: string): void {
  const json = mdManager.parse(md);
  const pmNode = schema.nodeFromJSON(json);
  const meta = { mapping: new Map(), isOMark: new Map() };
  updateYFragment(doc, xmlFragment, pmNode, meta);
}

/** Seed a doc production-order: paired-write intake first, attach second. */
function seedThenAttach(raw: string, docName: string) {
  const doc = new Y.Doc();
  const xmlFragment = doc.getXmlFragment('default');
  const ytext = doc.getText('source');
  doc.transact(() => {
    composeAndWriteRawBody(doc, raw, 'file-watcher');
  }, FILE_WATCHER_ORIGIN);
  const cleanup = setupServerObservers({ doc, xmlFragment, ytext, mdManager, schema, docName });
  return { doc, xmlFragment, ytext, cleanup };
}

function serializeFragmentBody(xmlFragment: Y.XmlFragment): string {
  return mdManager.serialize(yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON());
}

/** Run `fn` capturing structured console.warn events with the given names. */
function captureEvents(fn: () => void, ...eventNames: string[]): Record<string, unknown>[] {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    fn();
  } finally {
    console.warn = originalWarn;
  }
  return warnings
    .map((w) => {
      try {
        return JSON.parse(w);
      } catch {
        return null;
      }
    })
    .filter((e): e is Record<string, unknown> => e !== null)
    .filter((e) => eventNames.includes(e.event as string));
}

/** Total split-brain rederive detections — emit-gated counter + suppressed
 *  counter covers every fire even when the per-(site, doc) rate-limiter
 *  closes. */
const totalSplitBrainRederives = (): number =>
  getMetrics().bridgeSplitBrainRederives + getMetrics().bridgeSplitBrainRederivesSuppressed;

// ─── Fixtures: the lazy-continuation family ──────────────────

const FIXTURES = [
  {
    label: 'list in-item continuation',
    raw: '---\ntitle: List continuation fixture\n---\n\n- Also read at session start: operating rules,\nproject status, and input source paths.\n\nBody text stays.\n',
    // The unindented wrapped line must survive verbatim (storage never
    // sanitizes) — canonical form would indent it under the marker.
    preservedSlice: 'operating rules,\nproject status',
  },
  {
    label: 'trailing paragraph absorbed into the last bullet',
    raw: '---\ntitle: Trailing label fixture\n---\n\n**Why not now:**\n- First bullet\n- Second bullet\n- Third bullet\n**Trigger to revisit:** revisit after launch.\n',
    // Canonical form gains a blank separator and indents the absorbed
    // paragraph under the third bullet.
    preservedSlice: '- Third bullet\n**Trigger to revisit:**',
  },
  {
    label: 'nested blockquote lazy continuation',
    // A TOP-LEVEL blockquote lazy continuation is byte-faithful now (the
    // `'lazy'` marker-spacing capture replays it), so it left this family;
    // the NESTED form still canonicalizes because the spacings capture
    // bails after the first line on nested blockquotes.
    raw: '---\ntitle: Blockquote continuation fixture\n---\n\n# Hello\n\n> > Nested quote\nlazy tail.\n\nBody text stays.\n',
    // Canonical form gains the `> > ` prefix on the continuation line.
    preservedSlice: '> > Nested quote\nlazy tail.',
  },
] as const;

beforeEach(() => {
  __resetBridgeWatchdogForTests();
  resetMetrics();
});

describe('lazy-continuation docs — bridge health checks', () => {
  test('routing precondition: every fixture rests beyond normalizeBridge tolerance', () => {
    // Guards the fix SHAPE, not just the fix: these byte forms must STAY
    // beyond normalizeBridge tolerance so fragment edits keep routing the
    // byte-preserving residual merge (step 7f's deliberate exclusion —
    // widening the normalizer would flip routing toward canonical rewrites
    // and sanitize user bytes on unrelated edits).
    for (const { raw } of FIXTURES) {
      expect(canonicalOf(raw)).not.toBe(raw);
      expect(normalizeBridge(canonicalOf(raw))).not.toBe(normalizeBridge(raw));
    }
  });

  for (const { label, raw, preservedSlice } of FIXTURES) {
    test(`source-mode edit on a ${label} doc absorbs cleanly without a bridge-invariant violation`, () => {
      const { doc, xmlFragment, ytext, cleanup } = seedThenAttach(raw, `lazy-src-${label}`);
      expect(ytext.toString()).toBe(raw);

      const violations = captureEvents(() => {
        // A real Y.Text edit → Observer B full-fires (parse + fragment
        // re-derive + watchdog). Under NODE_ENV=test a watchdog violation
        // THROWS out of this transact — the defect this test pins.
        doc.transact(() => {
          ytext.insert(ytext.length, '\nAppended from source mode.\n');
        });
      }, 'bridge-invariant-violation');

      expect(violations).toHaveLength(0);
      // Observer B absorbed the edit into the fragment…
      expect(serializeFragmentBody(xmlFragment)).toContain('Appended from source mode.');
      // …and Y.Text keeps the user's source form verbatim.
      const finalText = ytext.toString();
      expect(finalText).toContain(preservedSlice);
      expect(finalText).toContain('Appended from source mode.');

      cleanup();
    });

    test(`WYSIWYG edit on a ${label} doc settles without split-brain rederive churn`, () => {
      const { doc, xmlFragment, ytext, cleanup } = seedThenAttach(raw, `lazy-wysiwyg-${label}`);

      const redsBefore = totalSplitBrainRederives();
      const events = captureEvents(() => {
        populateFragment(
          doc,
          xmlFragment,
          `${serializeFragmentBody(xmlFragment)}\nWysiwyg paragraph.\n`,
        );
      }, 'bridge-split-brain-rederive');

      expect(events).toHaveLength(0);
      expect(totalSplitBrainRederives()).toBe(redsBefore);

      // The residual merge spliced the fragment delta into the raw bytes —
      // the lazy continuation survives verbatim alongside the new content.
      const finalText = ytext.toString();
      expect(finalText).toContain(preservedSlice);
      expect(finalText).toContain('Wysiwyg paragraph.');

      cleanup();
    });
  }

  test('control: genuine fragment↔Y.Text divergence still fires the split-brain rederive', () => {
    const { doc, xmlFragment, ytext, cleanup } = seedThenAttach(
      FIXTURES[0].raw,
      'lazy-genuine-divergence',
    );

    // Divergence the observers never saw: a self-origin write skips dispatch
    // and leaves every witness stale, so the fragment now LACKS real Y.Text
    // content — not a serializer canonicalization.
    doc.transact(() => {
      ytext.insert(ytext.length, '\nSmuggled paragraph the fragment lacks.\n');
    }, OBSERVER_SYNC_ORIGIN);

    const redsBefore = totalSplitBrainRederives();
    populateFragment(
      doc,
      xmlFragment,
      `${serializeFragmentBody(xmlFragment)}\nWysiwyg paragraph.\n`,
    );

    // The settlement check must still classify this as split-brain.
    expect(totalSplitBrainRederives()).toBeGreaterThan(redsBefore);
    // Both contents survive in Y.Text (the merge preserves, never drops).
    const finalText = ytext.toString();
    expect(finalText).toContain('Smuggled paragraph the fragment lacks.');
    expect(finalText).toContain('Wysiwyg paragraph.');

    cleanup();
  });
});
