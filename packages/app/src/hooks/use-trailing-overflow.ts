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
  slack: number;
  measureTrailingWidth: (elements: TrailingOverflowElements) => number;
  measureAvailableWidth: (
    elements: TrailingOverflowElements,
    latchedTrailingWidth: number,
  ) => number;
}

export function useTrailingOverflow({
  header,
  leading,
  trailing,
  centre = null,
  signature,
  slack,
  measureTrailingWidth,
  measureAvailableWidth,
}: TrailingOverflowOptions): boolean {
  const [overflowed, setOverflowed] = useState(false);
  const overflowedRef = useRef(false);
  const measuredSignatureRef = useRef<string | null>(null);
  const latchedTrailingWidthRef = useRef(0);
  const measureRef = useRef({ measureTrailingWidth, measureAvailableWidth });

  useLayoutEffect(() => {
    measureRef.current = { measureTrailingWidth, measureAvailableWidth };
  });

  useLayoutEffect(() => {
    if (!header || !leading || !trailing) return;

    if (measuredSignatureRef.current !== signature) {
      measuredSignatureRef.current = signature;
      overflowedRef.current = false;
      latchedTrailingWidthRef.current = 0;
    }

    const update = () => {
      if (header.offsetWidth <= 0) return;
      const elements = { header, leading, trailing };
      if (!overflowedRef.current) {
        latchedTrailingWidthRef.current = measureRef.current.measureTrailingWidth(elements);
      }
      const available = measureRef.current.measureAvailableWidth(
        elements,
        latchedTrailingWidthRef.current,
      );
      const next = latchedTrailingWidthRef.current + slack > available;
      overflowedRef.current = next;
      setOverflowed(next);
    };
    update();

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(header);
    observer?.observe(leading);
    observer?.observe(trailing);
    if (centre) observer?.observe(centre);
    return () => observer?.disconnect();
  }, [header, leading, trailing, centre, signature, slack]);

  return overflowed;
}
