let lastGlobalUserKeystrokeMs = 0;

export function getLastUserKeystroke(): number {
  return lastGlobalUserKeystrokeMs;
}

export function markUserTyping(): void {
  lastGlobalUserKeystrokeMs = Date.now();
}
