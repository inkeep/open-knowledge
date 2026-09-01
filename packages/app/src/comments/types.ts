type CommentStatus = 'open' | 'resolved' | 'orphaned';

interface CommentAnchor {
  quote: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
}

type CommentTarget =
  | { kind: 'body' }
  | {
      kind: 'property';
      key: string;
      path: readonly (string | number)[];
    };

export interface CommentThread {
  id: string;
  docName: string;
  target: CommentTarget;
  anchor: CommentAnchor | null;
  status: CommentStatus;
  body: string;
  createdAt: number;
  updatedAt: number;
  queued: boolean;
}
