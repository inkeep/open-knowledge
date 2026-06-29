interface ApplyThemeAppliedDeps {
  fireThemeApplied: (window: object) => void;
  applyReducedTransparency: (reduced: boolean) => void;
  warn: (line: string) => void;
}

export function applyThemeApplied(
  deps: ApplyThemeAppliedDeps,
  senderWindow: object | null,
  opts: { reducedTransparency?: boolean } | undefined,
): void {
  if (opts?.reducedTransparency !== undefined) {
    deps.applyReducedTransparency(opts.reducedTransparency);
  }
  if (senderWindow !== null) {
    deps.fireThemeApplied(senderWindow);
  } else {
    deps.warn(
      JSON.stringify({
        event: 'theme-applied-no-window-for-sender',
      }),
    );
  }
}
