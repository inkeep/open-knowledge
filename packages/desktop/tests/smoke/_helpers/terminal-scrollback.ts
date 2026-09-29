export interface ScrollbackExpectation {
  readonly markers: readonly string[];
  readonly linePrefix: string;
  readonly lineCount: number;
}

export type ScrollbackVerdict =
  | { readonly kind: 'complete' }
  | {
      readonly kind: 'lost' | 'unreached';
      readonly pagesRead: number;
      readonly missingMarkers: readonly string[];
      readonly missingLines: readonly string[];
    };

export function numberedScrollLine(linePrefix: string, lineNumber: number): string {
  return `${linePrefix}${String(lineNumber).padStart(3, '0')}`;
}

export interface ScrollbackReader {
  readonly readSettledView: () => Promise<string>;
  readonly pageUpFrom: (settledView: string) => Promise<string>;
  readonly pageDownFrom: (settledView: string) => Promise<string>;
}

export async function readScrollbackUpward(
  { readSettledView, pageUpFrom, pageDownFrom }: ScrollbackReader,
  expectation: ScrollbackExpectation,
  pageLimit: number,
): Promise<ScrollbackVerdict> {
  const expectedLines = Array.from({ length: expectation.lineCount }, (_, index) =>
    numberedScrollLine(expectation.linePrefix, index + 1),
  );
  const pendingMarkers = new Set(expectation.markers);
  const pendingLines = new Set(expectedLines);
  const absorb = (view: string) => {
    for (const marker of pendingMarkers) if (view.includes(marker)) pendingMarkers.delete(marker);
    for (const line of pendingLines) if (view.includes(line)) pendingLines.delete(line);
  };
  const complete = () => pendingMarkers.size === 0 && pendingLines.size === 0;

  let view = await readSettledView();
  let pagesRead = 0;
  let reachedBottom = false;
  while (!reachedBottom && pagesRead < pageLimit) {
    const next = await pageDownFrom(view);
    pagesRead += 1;
    reachedBottom = next === view;
    view = next;
  }
  absorb(view);
  let reachedTop = false;
  while (!complete() && !reachedTop && pagesRead < pageLimit) {
    const next = await pageUpFrom(view);
    pagesRead += 1;
    reachedTop = next === view;
    view = next;
    absorb(view);
  }

  if (complete()) return { kind: 'complete' };
  return {
    kind: reachedTop ? 'lost' : 'unreached',
    pagesRead,
    missingMarkers: expectation.markers.filter((marker) => pendingMarkers.has(marker)),
    missingLines: expectedLines.filter((line) => pendingLines.has(line)),
  };
}
