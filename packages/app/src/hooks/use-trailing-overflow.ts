import { useLayoutEffect, useRef, useState } from 'react';

interface TrailingOverflowElements {
  readonly header: HTMLElement;
  readonly leading: HTMLElement;
  readonly trailing: HTMLElement;
}

export interface TrailingOverflowOptions {
  header: HTMLElement | null;
  leading: HTMLElement | null;
  trailing: HTMLElement | null;
  centre?: HTMLElement | null;
  signature: string;
  deferRemeasure: boolean;
  slack: number;
  measureTrailingWidth: (elements: TrailingOverflowElements) => number;
  measureAvailableWidth: (
    elements: TrailingOverflowElements,
    latchedTrailingWidth: number,
  ) => number;
}

export interface TrailingOverflow {
  readonly overflowed: boolean;
  readonly remeasuring: boolean;
}

export function useTrailingOverflow({
  header,
  leading,
  trailing,
  centre = null,
  signature,
  deferRemeasure,
  slack,
  measureTrailingWidth,
  measureAvailableWidth,
}: TrailingOverflowOptions): TrailingOverflow {
  const [fit, setFit] = useState({ signature, overflowed: false });
  const remeasuring = fit.overflowed && !deferRemeasure && fit.signature !== signature;
  const overflowed = fit.overflowed && !remeasuring;
  const latchedTrailingWidthRef = useRef(0);
  const updateRef = useRef(() => {});

  useLayoutEffect(() => {
    if (!header || !leading || !trailing) return;

    updateRef.current = () => {
      if (header.offsetWidth <= 0) return;
      const elements = { header, leading, trailing };
      if (!overflowed) {
        latchedTrailingWidthRef.current = measureTrailingWidth(elements);
      }
      const available = measureAvailableWidth(elements, latchedTrailingWidthRef.current);
      const next = latchedTrailingWidthRef.current + slack > available;
      setFit((previous) => {
        const measuredSignature = overflowed ? previous.signature : signature;
        return previous.overflowed === next && previous.signature === measuredSignature
          ? previous
          : { signature: measuredSignature, overflowed: next };
      });
    };
    updateRef.current();
  });

  useLayoutEffect(() => {
    if (!header || !leading || !trailing) return;

    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => updateRef.current());
    observer?.observe(header);
    observer?.observe(leading);
    observer?.observe(trailing);
    if (centre) observer?.observe(centre);
    return () => observer?.disconnect();
  }, [header, leading, trailing, centre]);

  return { overflowed, remeasuring };
}
