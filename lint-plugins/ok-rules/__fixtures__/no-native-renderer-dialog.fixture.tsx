import { prompt } from '@/lib/acp/agent-prompt';

declare const consentStore: { confirm: (request: string) => Promise<boolean> };
declare const threadClient: { prompt: (threadId: string, content: string) => void };
declare const dialogHost: { alert: (message: string) => void };

export function positives(): void {
  window.confirm('p1 window member');
  window.alert('p2 window member');
  window.prompt('p3 window member');
  confirm('p4 bare global');
  alert('p5 bare global');
  globalThis.confirm('p6 globalThis member');
  self.confirm('p8 self member');
  self.alert('p9 self member');
  self.prompt('p10 self member');
  if (!window.confirm('p7 negated inside a condition')) return;
}

export async function negatives(): Promise<void> {
  await consentStore.confirm('n1 method on a store');
  threadClient.prompt('thread', 'n2 method on a client');
  dialogHost.alert('n3 method on an injected host');
  prompt('n4 imported binding named like the global');
}

export function localFunction(): boolean {
  function confirm(message: string): boolean {
    return message.length > 0;
  }
  return confirm('n5 local function declaration');
}

export function localParameter(alert: (message: string) => void): void {
  alert('n6 parameter shadows the global');
}

export function localWindow(window: { confirm: (message: string) => boolean }): boolean {
  return window.confirm('n7 parameter named window');
}

export function references(): void {
  const n8 = window.confirm;
  void n8;
}
