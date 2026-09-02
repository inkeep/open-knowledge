import type { OkSlidesOpenResult } from '../shared/ipc-channels.ts';
import type { SlidevProcess } from './slidev-server.ts';
import type { BrowserWindowLike } from './window-manager.ts';

export type SlidesDeckWindow = BrowserWindowLike & { readonly id: number };

export interface RunningSlidesDeck {
  readonly docPath: string;
  readonly port: number;
  readonly process: SlidevProcess;
  readonly window: SlidesDeckWindow;
}

export interface SlidesDeckRegistry {
  get(docPath: string): RunningSlidesDeck | undefined;
  register(deck: RunningSlidesDeck): void;
  unregister(docPath: string): void;
  reapAll(): void;
  size(): number;
  getOpenInFlight(docPath: string): Promise<OkSlidesOpenResult> | undefined;
  setOpenInFlight(docPath: string, attempt: Promise<OkSlidesOpenResult>): void;
  clearOpenInFlight(docPath: string): void;
  trackSpawned(docPath: string, process: SlidevProcess): void;
  untrackSpawned(docPath: string): void;
}

export function createSlidesDeckRegistry(): SlidesDeckRegistry {
  const decks = new Map<string, RunningSlidesDeck>();
  const opening = new Map<string, Promise<OkSlidesOpenResult>>();
  const spawned = new Map<string, SlidevProcess>();
  return {
    get: (docPath) => decks.get(docPath),
    register: (deck) => {
      decks.set(deck.docPath, deck);
    },
    unregister: (docPath) => {
      decks.delete(docPath);
    },
    reapAll: () => {
      for (const deck of decks.values()) deck.process.signal('SIGTERM');
      for (const proc of spawned.values()) proc.signal('SIGTERM');
      decks.clear();
      spawned.clear();
      opening.clear();
    },
    size: () => decks.size,
    getOpenInFlight: (docPath) => opening.get(docPath),
    setOpenInFlight: (docPath, attempt) => {
      opening.set(docPath, attempt);
    },
    clearOpenInFlight: (docPath) => {
      opening.delete(docPath);
    },
    trackSpawned: (docPath, process) => {
      spawned.set(docPath, process);
    },
    untrackSpawned: (docPath) => {
      spawned.delete(docPath);
    },
  };
}
