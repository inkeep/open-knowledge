import { type Extension, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import type * as Y from 'yjs';
import {
  evictStaleEntries,
  FLASH_DEBOUNCE_MS,
  FLASH_DURATION_MS,
  hasNewEntries,
} from './flash-shared';

const addFlash = StateEffect.define<{ from: number; to: number }>();

const removeFlash = StateEffect.define<null>();

const flashDecoration = Decoration.line({ class: 'agent-flash' });

const flashField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    decorations = decorations.map(tr.changes);

    for (const effect of tr.effects) {
      if (effect.is(addFlash)) {
        const { from, to } = effect.value;
        const builder: Array<ReturnType<typeof flashDecoration.range>> = [];
        for (let pos = from; pos <= to; ) {
          const line = tr.state.doc.lineAt(pos);
          builder.push(flashDecoration.range(line.from));
          pos = line.to + 1;
        }
        decorations = decorations.update({ add: builder, sort: true });
      } else if (effect.is(removeFlash)) {
        decorations = Decoration.none;
      }
    }
    return decorations;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function createAgentFlashSourceExtension(doc: Y.Doc): Extension {
  const activityMap = doc.getMap('agent-flash');

  const flashViewPlugin = ViewPlugin.define((view) => {
    let lastFlashTime = 0;
    let lastSeenTimestamp = Date.now();
    let pendingTimeout: ReturnType<typeof setTimeout> | null = null;
    let flashRemoveTimeout: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;

    function flashAllLines() {
      const docLength = view.state.doc.length;
      if (docLength === 0) return;
      if (destroyed) return;
      view.dispatch({
        effects: addFlash.of({ from: 0, to: docLength }),
      });
      if (flashRemoveTimeout) clearTimeout(flashRemoveTimeout);
      flashRemoveTimeout = setTimeout(() => {
        flashRemoveTimeout = null;
        if (destroyed) return;
        view.dispatch({
          effects: removeFlash.of(null),
        });
      }, FLASH_DURATION_MS);
    }

    const activityObserver = (_event: Y.YMapEvent<unknown>) => {
      evictStaleEntries(activityMap);

      if (!hasNewEntries(activityMap, lastSeenTimestamp)) return;

      lastSeenTimestamp = Date.now();

      const now = Date.now();
      if (now - lastFlashTime < FLASH_DEBOUNCE_MS) {
        if (!pendingTimeout) {
          const delay = FLASH_DEBOUNCE_MS - (now - lastFlashTime);
          pendingTimeout = setTimeout(() => {
            pendingTimeout = null;
            lastFlashTime = Date.now();
            flashAllLines();
          }, delay);
        }
        return;
      }

      lastFlashTime = now;
      flashAllLines();
    };

    activityMap.observe(activityObserver);

    const visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        if (hasNewEntries(activityMap, lastSeenTimestamp)) {
          lastSeenTimestamp = Date.now();
          lastFlashTime = Date.now();
          flashAllLines();
        }
      } else {
        lastSeenTimestamp = Date.now();
      }
    };

    document.addEventListener('visibilitychange', visibilityHandler);

    return {
      update(_update: ViewUpdate) {},
      destroy() {
        destroyed = true;
        activityMap.unobserve(activityObserver);
        document.removeEventListener('visibilitychange', visibilityHandler);
        if (pendingTimeout) {
          clearTimeout(pendingTimeout);
          pendingTimeout = null;
        }
        if (flashRemoveTimeout) {
          clearTimeout(flashRemoveTimeout);
          flashRemoveTimeout = null;
        }
      },
    };
  });

  return [flashField, flashViewPlugin];
}
