/**
 * SKIP-GUARDED: UNSKIP when the per-agent UM + agent-undo handler is wired.
 *
 * These tests assert that the post-undo rebuild preserves user's concurrent
 * XmlFragment content: the naive rebuild-from-Y.Text pattern
 * (syncTextToFragment) destroys concurrent user XmlFragment content on the
 * undo path — identical stomp shape to the forward-write path.
 *
 * The fix deleted
 * syncTextToFragment and documented the XmlFragment-authoritative fix
 * pattern (applyAgentMarkdownWrite, precedent #10); the undo handler is
 * implemented using that pattern. See:
 *   - applyAgentMarkdownWrite in agent-sessions.ts as the pickup template
 *
 * Test 1: Pure mechanism — syncTextToFragment with stale Y.Text
 *   destroys XmlFragment content.
 * Test 2: realistic flow — post-undo syncTextToFragment
 *   destroys new user XmlFragment keystroke.
 */

import { describe, expect, test } from 'bun:test';
import { prependFrontmatter, stripFrontmatter } from '@inkeep/open-knowledge-core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import * as Y from 'yjs';

import { mdManager, schema } from './test-harness';

// ─────────────────────────────────────────────────────────────
// Local replica of syncTextToFragment (agent-sessions.ts)
//
// We replicate this rather than importing the real one because the
// real function takes a Hocuspocus `Document` (extends Y.Doc with
// .name, awareness, etc.). The core logic is identical — read Y.Text,
// parse, updateYFragment, enforce canonical round-trip.
// ─────────────────────────────────────────────────────────────

function syncTextToFragmentLocal(doc: Y.Doc, ytext: Y.Text, xmlFragment: Y.XmlFragment): void {
  const fullText = ytext.toString();
  const { frontmatter, body } = stripFrontmatter(fullText);
  const parsedJson = mdManager.parseWithFallback(body);
  const pmNode = schema.nodeFromJSON(parsedJson);
  const meta = { mapping: new Map(), isOMark: new Map() };
  updateYFragment(doc, xmlFragment, pmNode, meta);

  // Enforce bridge invariant: ytext must be byte-equal to canonical serialization.
  const canonicalBody = mdManager.serialize(
    yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON(),
  );
  const canonicalFull = prependFrontmatter(frontmatter, canonicalBody);
  if (canonicalFull !== fullText) {
    ytext.delete(0, fullText.length);
    ytext.insert(0, canonicalFull);
  }
}

/** Serialize XmlFragment → markdown string. */
function serializeFrag(fragment: Y.XmlFragment): string {
  return mdManager.serialize(yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON());
}

/** Apply markdown content to XmlFragment via updateYFragment. */
function applyToFragment(
  doc: Y.Doc,
  xmlFragment: Y.XmlFragment,
  md: string,
  origin?: string,
): void {
  const parsed = mdManager.parse(md);
  const pmNode = schema.nodeFromJSON(parsed);
  doc.transact(() => {
    const meta = { mapping: new Map(), isOMark: new Map() };
    updateYFragment(doc, xmlFragment, pmNode, meta);
  }, origin);
}

// ═════════════════════════════════════════════════════════════
// Test 1: PURE MECHANISM — syncTextToFragment with stale Y.Text
// ═════════════════════════════════════════════════════════════

describe('Bug-D mechanism isolation', () => {
  test('D-iso-1: syncTextToFragment with stale Y.Text destroys XmlFragment content', () => {
    // ── Setup: fresh Y.Doc, seed both sides to a baseline ──
    const doc = new Y.Doc();
    const ytext = doc.getText('source');
    const xmlFragment = doc.getXmlFragment('default');

    const baseline = '# Baseline\n\noriginal paragraph\n';

    doc.transact(() => {
      ytext.insert(0, baseline);
    }, 'seed-text');
    applyToFragment(doc, xmlFragment, baseline, 'seed-frag');

    // Verify both sides match at baseline.
    const ytextAfterSeed = ytext.toString();
    const fragAfterSeed = serializeFrag(xmlFragment);
    console.log('─── D-iso-1: STEP 1 — baseline seeded ───');
    console.log('  Y.Text:', JSON.stringify(ytextAfterSeed));
    console.log('  XmlFrag:', JSON.stringify(fragAfterSeed));
    expect(ytextAfterSeed).toContain('original paragraph');
    expect(fragAfterSeed).toContain('original paragraph');

    // ── Diverge: mutate XmlFragment ONLY (simulates user typing in WYSIWYG) ──
    // No Observer A, no Y.Text update. This is the pre-Observer-A-debounce window.
    const userMd = '# Baseline\n\noriginal paragraph\n\nuser typed this in WYSIWYG\n';
    applyToFragment(doc, xmlFragment, userMd, 'user-wysiwyg');

    const ytextAfterUserEdit = ytext.toString();
    const fragAfterUserEdit = serializeFrag(xmlFragment);
    console.log('─── D-iso-1: STEP 2 — user typed in XmlFragment only ───');
    console.log('  Y.Text:', JSON.stringify(ytextAfterUserEdit));
    console.log('  XmlFrag:', JSON.stringify(fragAfterUserEdit));
    expect(fragAfterUserEdit).toContain('user typed this in WYSIWYG');
    expect(ytextAfterUserEdit).not.toContain('user typed this in WYSIWYG');

    // ── Call syncTextToFragment (the mechanism under test) ──
    // This reads Y.Text (still at baseline), parses, and rebuilds XmlFragment.
    console.log('─── D-iso-1: STEP 3 — calling syncTextToFragment ───');
    syncTextToFragmentLocal(doc, ytext, xmlFragment);

    const ytextFinal = ytext.toString();
    const fragFinal = serializeFrag(xmlFragment);
    console.log('─── D-iso-1: STEP 4 — after syncTextToFragment ───');
    console.log('  Y.Text:', JSON.stringify(ytextFinal));
    console.log('  XmlFrag:', JSON.stringify(fragFinal));

    // ── VERDICT ──
    const userContentSurvived = fragFinal.includes('user typed this in WYSIWYG');
    console.log(
      '─── D-iso-1: VERDICT — user content survived in XmlFragment:',
      userContentSurvived,
      '───',
    );

    // If the mechanism is real: XmlFragment was rebuilt from Y.Text (baseline
    // only), so "user typed this in WYSIWYG" is gone.
    // The test PASSES if the user content is destroyed (confirming the bug).
    expect(fragFinal).not.toContain('user typed this in WYSIWYG');
    expect(fragFinal).toContain('original paragraph');
  });

  // ═══════════════════════════════════════════════════════════
  // Test 2: REALISTIC FLOW — undo after agent write
  //         destroys concurrent user's new XmlFragment keystroke
  // ═══════════════════════════════════════════════════════════

  test('D-iso-2: V0-14 flow — post-undo syncTextToFragment destroys new user XmlFragment keystroke', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('source');
    const xmlFragment = doc.getXmlFragment('default');

    // ── Step A: Seed both sides to user's pre-existing content ──
    // This represents the state AFTER Observer A has synced — both sides
    // have the user's content. No divergence yet.
    const userBeforeAgent = '# Document\n\nuser paragraph before agent\n';

    doc.transact(() => {
      ytext.insert(0, userBeforeAgent);
    }, 'seed-text');
    applyToFragment(doc, xmlFragment, userBeforeAgent, 'seed-frag');

    const ytextA = ytext.toString();
    const fragA = serializeFrag(xmlFragment);
    console.log('─── D-iso-2: STEP A — user content synced to both sides ───');
    console.log('  Y.Text:', JSON.stringify(ytextA));
    console.log('  XmlFrag:', JSON.stringify(fragA));
    expect(ytextA).toContain('user paragraph before agent');
    expect(fragA).toContain('user paragraph before agent');

    // ── Step B: Create UndoManager BEFORE agent write ──
    // Tracks 'agent-write' origin.
    const um = new Y.UndoManager(ytext, {
      trackedOrigins: new Set(['agent-write']),
      captureTimeout: 0,
    });

    // ── Step C: Agent writes to Y.Text + syncTextToFragment (production flow) ──
    // In production, agent write + syncTextToFragment happen inside one transact():
    //   dc.document.transact(() => { ytext.insert(...); syncTextToFragment(...); }, AGENT_WRITE_ORIGIN)
    // We replicate this exactly.
    doc.transact(() => {
      const currentText = ytext.toString();
      const insertAt = currentText.length;
      const separator = currentText.trim() ? '\n\n' : '';
      ytext.insert(insertAt, `${separator}agent contribution\n`);
      syncTextToFragmentLocal(doc, ytext, xmlFragment);
    }, 'agent-write');

    const ytextC = ytext.toString();
    const fragC = serializeFrag(xmlFragment);
    console.log('─── D-iso-2: STEP C — agent wrote + syncTextToFragment ───');
    console.log('  Y.Text:', JSON.stringify(ytextC));
    console.log('  XmlFrag:', JSON.stringify(fragC));
    expect(ytextC).toContain('agent contribution');
    expect(fragC).toContain('agent contribution');
    expect(ytextC).toContain('user paragraph before agent');
    expect(fragC).toContain('user paragraph before agent');

    // ── Step D: THE RACE — user types a NEW keystroke in XmlFragment only ──
    // This simulates the window where the user is typing in WYSIWYG and
    // Observer A's 50ms debounce hasn't fired yet.
    // After this: XmlFragment has user-before + agent + new-user-chars,
    //             Y.Text has user-before + agent (no new-user-chars).
    const fullWithNewKeystroke =
      '# Document\n\nuser paragraph before agent\n\nagent contribution\n\nnew user keystroke\n';
    applyToFragment(doc, xmlFragment, fullWithNewKeystroke, 'user-wysiwyg');

    const ytextD = ytext.toString();
    const fragD = serializeFrag(xmlFragment);
    console.log('─── D-iso-2: STEP D — new user keystroke in XmlFragment only ───');
    console.log('  Y.Text:', JSON.stringify(ytextD));
    console.log('  XmlFrag:', JSON.stringify(fragD));
    expect(fragD).toContain('new user keystroke');
    expect(ytextD).not.toContain('new user keystroke');

    // ── Step E: invokes um.undo() — reverts agent's Y.Text items ──
    um.undo();

    const ytextE = ytext.toString();
    const fragE = serializeFrag(xmlFragment);
    console.log('─── D-iso-2: STEP E — after um.undo() ───');
    console.log('  Y.Text:', JSON.stringify(ytextE));
    console.log('  XmlFrag:', JSON.stringify(fragE));
    // Y.Text should be back to user-before-agent (agent content reverted).
    expect(ytextE).toContain('user paragraph before agent');
    expect(ytextE).not.toContain('agent contribution');
    // XmlFragment should still have everything (undo only touched Y.Text).
    expect(fragE).toContain('new user keystroke');

    // ── Step F: calls syncTextToFragment after undo ──
    // Per STOP rule: "Always call syncTextToFragment() after um.undo()."
    // This is the Bug-D trigger.
    console.log('─── D-iso-2: STEP F — calling syncTextToFragment post-undo ───');
    syncTextToFragmentLocal(doc, ytext, xmlFragment);

    const ytextF = ytext.toString();
    const fragF = serializeFrag(xmlFragment);
    console.log('─── D-iso-2: STEP F result ───');
    console.log('  Y.Text:', JSON.stringify(ytextF));
    console.log('  XmlFrag:', JSON.stringify(fragF));

    // ── VERDICTS ──
    const agentContentGone = !fragF.includes('agent contribution');
    const newKeystrokeSurvived = fragF.includes('new user keystroke');
    const userBeforeSurvived = fragF.includes('user paragraph before agent');

    console.log('─── D-iso-2: VERDICTS ───');
    console.log('  Agent content correctly removed (undo intent):', agentContentGone);
    console.log('  New user keystroke survived:', newKeystrokeSurvived);
    console.log('  User-before-agent survived:', userBeforeSurvived);

    // Agent content should be gone (that's the undo intent — CORRECT behavior).
    expect(fragF).not.toContain('agent contribution');

    // User-before-agent should survive (it's in Y.Text).
    expect(fragF).toContain('user paragraph before agent');

    // ── THE QUESTION ──
    // "new user keystroke" was typed in XmlFragment AFTER the agent write.
    // It has nothing to do with the undo. But syncTextToFragment reads Y.Text
    // (which doesn't have it) and rebuilds XmlFragment → new keystroke DESTROYED.
    //
    // If the bug is real: this assertion PASSES (content is destroyed).
    // If the bug is not real: this assertion FAILS (content survives).
    expect(fragF).not.toContain('new user keystroke');
  });
});
