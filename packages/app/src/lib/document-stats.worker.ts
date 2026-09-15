import { computeBodyStats, computePlainTextStats } from './document-stats';

interface StatsRequest {
  id: number;
  text: string;
  plain: boolean;
}

type WorkerScope = {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: StatsRequest }) => void) | null;
};
const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const { id, text, plain } = event.data;
  scope.postMessage({ id, stats: plain ? computePlainTextStats(text) : computeBodyStats(text) });
};
