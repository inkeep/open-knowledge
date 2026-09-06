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
  reapAll(): Promise<void>;
  size(): number;
  getOpenInFlight(docPath: string): Promise<OkSlidesOpenResult> | undefined;
  setOpenInFlight(docPath: string, attempt: Promise<OkSlidesOpenResult>): void;
  clearOpenInFlight(docPath: string): void;
  trackSpawned(docPath: string, process: SlidevProcess): void;
}

export function createSlidesDeckRegistry(): SlidesDeckRegistry {
  const decks = new Map<string, RunningSlidesDeck>();
  const opening = new Map<string, Promise<OkSlidesOpenResult>>();
  const spawned = new Map<string, Set<SlidevProcess>>();
  return {
    get: (docPath) => decks.get(docPath),
    register: (deck) => {
      decks.set(deck.docPath, deck);
    },
    unregister: (docPath) => {
      decks.delete(docPath);
    },
    reapAll: async () => {
      const processes = new Set<SlidevProcess>();
      for (const deck of decks.values()) {
        if (deck.process.isAlive()) processes.add(deck.process);
      }
      for (const spawnedProcesses of spawned.values()) {
        for (const process of spawnedProcesses) {
          if (process.isAlive()) processes.add(process);
        }
      }
      decks.clear();
      spawned.clear();
      opening.clear();
      await Promise.allSettled(Array.from(processes, (process) => process.signal('SIGKILL')));
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
      const processes = spawned.get(docPath) ?? new Set<SlidevProcess>();
      processes.add(process);
      spawned.set(docPath, processes);
      const forget = () => {
        processes.delete(process);
        if (processes.size === 0 && spawned.get(docPath) === processes) {
          spawned.delete(docPath);
        }
      };
      process.onExit(forget);
      if (!process.isAlive()) forget();
    },
  };
}
