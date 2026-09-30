import { computeBodyStats, computePlainTextStats, type DocumentStats } from './document-stats';

interface StatsReply {
  id: number;
  stats: DocumentStats;
}

interface PendingRequest {
  text: string;
  plain: boolean;
  resolve: (stats: DocumentStats) => void;
}

function computeHere(text: string, plain: boolean): DocumentStats {
  return plain ? computePlainTextStats(text) : computeBodyStats(text);
}

/* STOP: counting words parses the whole document, which on a book-length file is a long task
   on every pause in typing. It runs in a worker; where there is no worker, or it fails to
   load, the same function runs here, so the counts never depend on which path ran. */
class DocumentStatsRuntime {
  private worker: Worker | null = null;
  private broken = false;
  private nextId = 0;
  private readonly pending = new Map<number, PendingRequest>();

  compute(text: string, plain: boolean): Promise<DocumentStats> {
    const worker = this.ensureWorker();
    if (worker === null) return Promise.resolve(computeHere(text, plain));
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.pending.set(id, { text, plain, resolve });
      worker.postMessage({ id, text, plain });
    });
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.settleHere();
  }

  private ensureWorker(): Worker | null {
    if (this.broken || typeof Worker === 'undefined') return null;
    if (this.worker !== null) return this.worker;
    try {
      this.worker = new Worker(new URL('./document-stats.worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch {
      this.broken = true;
      return null;
    }
    this.worker.onmessage = (event: MessageEvent<StatsReply>) => {
      const request = this.pending.get(event.data.id);
      if (request === undefined) return;
      this.pending.delete(event.data.id);
      request.resolve(event.data.stats);
    };
    this.worker.onerror = () => {
      this.broken = true;
      this.worker?.terminate();
      this.worker = null;
      this.settleHere();
    };
    return this.worker;
  }

  private settleHere(): void {
    for (const [id, request] of this.pending) {
      this.pending.delete(id);
      request.resolve(computeHere(request.text, request.plain));
    }
  }
}

let singleton: DocumentStatsRuntime | null = null;

export function computeDocumentStats(text: string, plain: boolean): Promise<DocumentStats> {
  singleton ??= new DocumentStatsRuntime();
  return singleton.compute(text, plain);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    singleton?.terminate();
    singleton = null;
  });
}
