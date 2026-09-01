export interface VisibleCommentScope {
  readonly scope: 'doc' | 'project';
  readonly docName: string;
}

let current: VisibleCommentScope | null = null;

export function setVisibleCommentScope(next: VisibleCommentScope | null): void {
  current = next;
}

export function getVisibleCommentScope(): VisibleCommentScope | null {
  return current;
}
