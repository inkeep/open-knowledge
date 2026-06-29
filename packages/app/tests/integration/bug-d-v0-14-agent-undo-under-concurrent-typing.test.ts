import { describe, expect, test } from 'bun:test';
import { prependFrontmatter, stripFrontmatter } from '@inkeep/open-knowledge-core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import * as Y from 'yjs';

import { mdManager, schema } from './test-harness';

function syncTextToFragmentLocal(doc: Y.Doc, ytext: Y.Text, xmlFragment: Y.XmlFragment): void {
  const fullText = ytext.toString();
  const { frontmatter, body } = stripFrontmatter(fullText);
  const parsedJson = mdManager.parseWithFallback(body);
  const pmNode = schema.nodeFromJSON(parsedJson);
  const meta = { mapping: new Map(), isOMark: new Map() };
  updateYFragment(doc, xmlFragment, pmNode, meta);

  const canonicalBody = mdManager.serialize(
    yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON(),
  );
  const canonicalFull = prependFrontmatter(frontmatter, canonicalBody);
  if (canonicalFull !== fullText) {
    ytext.delete(0, fullText.length);
    ytext.insert(0, canonicalFull);
  }
}

function serializeFrag(fragment: Y.XmlFragment): string {
  return mdManager.serialize(yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON());
}

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

describe('Bug-D mechanism isolation', () => {
  test('D-iso-1: syncTextToFragment with stale Y.Text destroys XmlFragment content', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('source');
    const xmlFragment = doc.getXmlFragment('default');

    const baseline = '# Baseline\n\noriginal paragraph\n';

    doc.transact(() => {
      ytext.insert(0, baseline);
    }, 'seed-text');
    applyToFragment(doc, xmlFragment, baseline, 'seed-frag');

    const ytextAfterSeed = ytext.toString();
    const fragAfterSeed = serializeFrag(xmlFragment);
    console.log('─── D-iso-1: STEP 1 — baseline seeded ───');
    console.log('  Y.Text:', JSON.stringify(ytextAfterSeed));
    console.log('  XmlFrag:', JSON.stringify(fragAfterSeed));
    expect(ytextAfterSeed).toContain('original paragraph');
    expect(fragAfterSeed).toContain('original paragraph');

    const userMd = '# Baseline\n\noriginal paragraph\n\nuser typed this in WYSIWYG\n';
    applyToFragment(doc, xmlFragment, userMd, 'user-wysiwyg');

    const ytextAfterUserEdit = ytext.toString();
    const fragAfterUserEdit = serializeFrag(xmlFragment);
    console.log('─── D-iso-1: STEP 2 — user typed in XmlFragment only ───');
    console.log('  Y.Text:', JSON.stringify(ytextAfterUserEdit));
    console.log('  XmlFrag:', JSON.stringify(fragAfterUserEdit));
    expect(fragAfterUserEdit).toContain('user typed this in WYSIWYG');
    expect(ytextAfterUserEdit).not.toContain('user typed this in WYSIWYG');

    console.log('─── D-iso-1: STEP 3 — calling syncTextToFragment ───');
    syncTextToFragmentLocal(doc, ytext, xmlFragment);

    const ytextFinal = ytext.toString();
    const fragFinal = serializeFrag(xmlFragment);
    console.log('─── D-iso-1: STEP 4 — after syncTextToFragment ───');
    console.log('  Y.Text:', JSON.stringify(ytextFinal));
    console.log('  XmlFrag:', JSON.stringify(fragFinal));

    const userContentSurvived = fragFinal.includes('user typed this in WYSIWYG');
    console.log(
      '─── D-iso-1: VERDICT — user content survived in XmlFragment:',
      userContentSurvived,
      '───',
    );

    expect(fragFinal).not.toContain('user typed this in WYSIWYG');
    expect(fragFinal).toContain('original paragraph');
  });

  test('D-iso-2: V0-14 flow — post-undo syncTextToFragment destroys new user XmlFragment keystroke', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('source');
    const xmlFragment = doc.getXmlFragment('default');

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

    const um = new Y.UndoManager(ytext, {
      trackedOrigins: new Set(['agent-write']),
      captureTimeout: 0,
    });

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

    um.undo();

    const ytextE = ytext.toString();
    const fragE = serializeFrag(xmlFragment);
    console.log('─── D-iso-2: STEP E — after um.undo() ───');
    console.log('  Y.Text:', JSON.stringify(ytextE));
    console.log('  XmlFrag:', JSON.stringify(fragE));
    expect(ytextE).toContain('user paragraph before agent');
    expect(ytextE).not.toContain('agent contribution');
    expect(fragE).toContain('new user keystroke');

    console.log('─── D-iso-2: STEP F — calling syncTextToFragment post-undo ───');
    syncTextToFragmentLocal(doc, ytext, xmlFragment);

    const ytextF = ytext.toString();
    const fragF = serializeFrag(xmlFragment);
    console.log('─── D-iso-2: STEP F result ───');
    console.log('  Y.Text:', JSON.stringify(ytextF));
    console.log('  XmlFrag:', JSON.stringify(fragF));

    const agentContentGone = !fragF.includes('agent contribution');
    const newKeystrokeSurvived = fragF.includes('new user keystroke');
    const userBeforeSurvived = fragF.includes('user paragraph before agent');

    console.log('─── D-iso-2: VERDICTS ───');
    console.log('  Agent content correctly removed (undo intent):', agentContentGone);
    console.log('  New user keystroke survived:', newKeystrokeSurvived);
    console.log('  User-before-agent survived:', userBeforeSurvived);

    expect(fragF).not.toContain('agent contribution');

    expect(fragF).toContain('user paragraph before agent');

    expect(fragF).not.toContain('new user keystroke');
  });
});
