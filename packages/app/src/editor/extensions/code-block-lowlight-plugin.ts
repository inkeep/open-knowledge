/**
 * Lowlight-based ProseMirror decoration plugin for fenced code blocks.
 *
 * Mirrors @tiptap/extension-code-block-lowlight's plugin so we can extend the
 * existing core CodeBlockFidelity (which carries the fence-fidelity attrs)
 * without forking the schema. Only redraws decorations on doc mutations that
 * affect a code block — selection-only transactions reuse the cached set.
 */

import { findChildren } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

interface HastTextNode {
  type: 'text';
  value: string;
}

interface HastElementNode {
  type: 'element';
  tagName?: string;
  properties?: { className?: string[] };
  children: Array<HastTextNode | HastElementNode>;
}

type HastNode = HastTextNode | HastElementNode;

interface LowlightTree {
  children?: HastNode[];
}

export interface LowlightLike {
  highlight(language: string, value: string): LowlightTree;
  highlightAuto(value: string): LowlightTree;
  listLanguages(): string[];
  registered?(name: string): boolean;
}

function parseNodes(
  nodes: HastNode[],
  classes: string[] = [],
): Array<{ text: string; classes: string[] }> {
  return nodes.flatMap((node) => {
    if (node.type === 'text') {
      return [{ text: node.value, classes }];
    }
    const nextClasses = [...classes, ...(node.properties?.className ?? [])];
    return parseNodes(node.children, nextClasses);
  });
}

function getDecorations(opts: {
  doc: PmNode;
  name: string;
  lowlight: LowlightLike;
  defaultLanguage: string | null;
}): DecorationSet {
  const { doc, name, lowlight, defaultLanguage } = opts;
  const decorations: Decoration[] = [];
  // `listLanguages()` allocates a fresh array per call — hoist outside the
  // per-block loop so we pay O(1) lookups instead of O(N) array materializations.
  const registeredLanguages = lowlight.listLanguages();

  findChildren(doc, (node) => node.type.name === name).forEach((block) => {
    let from = block.pos + 1;
    const lang = (block.node.attrs.language || defaultLanguage) as string | null;
    // Plain text path — `language === null` is the picker's explicit "no
    // highlighting" choice. Skip lowlight entirely so we (a) honour the user's
    // intent and (b) avoid the per-keystroke ~38-grammar `highlightAuto` scan
    // over every plain block.
    if (!lang) return;
    const supported = registeredLanguages.includes(lang) || (lowlight.registered?.(lang) ?? false);
    if (!supported) return;
    let tree: LowlightTree;
    try {
      tree = lowlight.highlight(lang, block.node.textContent);
    } catch {
      return;
    }
    const children = (tree.children ?? []) as HastNode[];
    for (const segment of parseNodes(children)) {
      const to = from + segment.text.length;
      if (segment.classes.length > 0) {
        decorations.push(
          Decoration.inline(from, to, {
            class: segment.classes.join(' '),
          }),
        );
      }
      from = to;
    }
  });

  return DecorationSet.create(doc, decorations);
}

export function LowlightPlugin(opts: {
  name: string;
  lowlight: LowlightLike;
  defaultLanguage: string | null;
}): Plugin {
  const { name, lowlight, defaultLanguage } = opts;
  const lowlightPlugin: Plugin = new Plugin({
    key: new PluginKey('codeBlockLowlight'),
    state: {
      init: (_config, { doc }) => getDecorations({ doc, name, lowlight, defaultLanguage }),
      apply: (transaction, decorationSet, oldState, newState) => {
        // Selection-only transactions never need a redecoration — short-circuit
        // before doing two full document tree walks. Remote-peer awareness
        // ticks and local cursor moves both land here.
        if (!transaction.docChanged) {
          return decorationSet.map(transaction.mapping, transaction.doc);
        }
        const oldNodeName = oldState.selection.$head.parent.type.name;
        const newNodeName = newState.selection.$head.parent.type.name;
        const oldNodes = findChildren(oldState.doc, (node) => node.type.name === name);
        const newNodes = findChildren(newState.doc, (node) => node.type.name === name);

        if (
          [oldNodeName, newNodeName].includes(name) ||
          newNodes.length !== oldNodes.length ||
          transaction.steps.some((step) => {
            const s = step as unknown as { from?: number; to?: number };
            if (s.from === undefined || s.to === undefined) return false;
            // Intersection (not containment): a remote-peer keystroke
            // inside a code block produces a step whose [from, to] lies
            // INSIDE the node — containment ("step encloses node") misses
            // those, leaving stale highlight tokens until the next
            // selection-into-block tick. Intersection covers both
            // directions: step inside node OR step encloses node.
            return oldNodes.some(
              (node) =>
                (s.from as number) < node.pos + node.node.nodeSize && (s.to as number) > node.pos,
            );
          })
        ) {
          return getDecorations({ doc: transaction.doc, name, lowlight, defaultLanguage });
        }
        return decorationSet.map(transaction.mapping, transaction.doc);
      },
    },
    props: {
      decorations(state) {
        return lowlightPlugin.getState(state);
      },
    },
  });
  return lowlightPlugin;
}
