// FIXTURE — drives `no-uninstall-forbidden-import.test.ts` via shell-out to
// `biome check`. Not part of the main lint (lives outside the lint command's
// path list).
//
// Thirteen positive cases (deliberate violations — plugin must fire): one per
// forbidden specifier across every import shape (named / default / namespace /
// type / side-effect / subpath) plus a dynamic import. Paired with negative
// cases (clean usage that must NOT fire), including the allowed core package and
// the plain markdown-render prosemirror/@tiptap libs. Exact-equality (`toBe(13)`)
// in the test catches both false-negative regressions (drop below 13) and
// false-positive widenings (above 13).

// === Positive cases — must fire ===

import { DocumentContext } from '@/editor/DocumentContext'; // editor, named
import '@/editor/provider-pool'; // editor, side-effect
import { HocuspocusProvider } from '@hocuspocus/provider'; // hocuspocus, named
import type { AuthRejectionReason } from '@inkeep/open-knowledge-server'; // server, type-only
import { ySyncPlugin } from '@tiptap/y-tiptap'; // CRDT binding, named
import { yCollab } from 'y-codemirror.next'; // CRDT, named
import { IndexeddbPersistence } from 'y-indexeddb'; // CRDT, named
import yProsemirror from 'y-prosemirror'; // CRDT, default
import { Awareness } from 'y-protocols/awareness'; // CRDT, subpath
import * as Y from 'yjs'; // CRDT, namespace
import '@tiptap/extension-collaboration'; // CRDT extension, side-effect
import { CollaborationCursor } from '@tiptap/extension-collaboration-cursor'; // CRDT extension, named

// === Negative cases — must NOT fire ===

import type { UninstallScreenSpec } from '@inkeep/open-knowledge-core'; // shared types — allowed
import { UNINSTALL_FEEDBACK_REASONS } from '@inkeep/open-knowledge-core'; // shared constants — allowed
import { getSchema } from '@tiptap/core'; // plain markdown-render tiptap — not collab
import { EditorView } from 'prosemirror-view'; // plain markdown-render prosemirror — not collab
import React from 'react'; // allowed
import notYjs from 'yjs-not-real'; // must NOT prefix-match the exact `yjs` package
import { Button } from '@/components/ui/button'; // shadcn primitive — allowed
import { i18n } from '@/lib/i18n'; // allowed

// (13) Dynamic import — the eager-load invariant forbids any dynamic import
// under src/uninstall, regardless of the target.
export async function lazyThing() {
  return import('./some-local-module');
}

// Reference every binding so unused-import diagnostics don't crowd the output the
// test greps. The references are inert — this file is never executed.
export const used = [
  DocumentContext,
  HocuspocusProvider,
  Y,
  Awareness,
  yProsemirror,
  yCollab,
  IndexeddbPersistence,
  ySyncPlugin,
  CollaborationCursor,
  Button,
  UNINSTALL_FEEDBACK_REASONS,
  getSchema,
  EditorView,
  React,
  notYjs,
  i18n,
];
export type UsedType = AuthRejectionReason | UninstallScreenSpec;
