/**
 * Network-layer sync control for deterministic CRDT race testing.
 *
 * Provides a WebSocket wrapper that supports pause/resume of inbound message
 * delivery. When paused, inbound messages are queued and delivered FIFO on
 * resume. Outbound is always passthrough.
 *
 * Minimal surface for v1: pauseInbound/resumeInbound only.
 * Future extensions (delaySync, dropInbound, inspectSyncQueue) land when a
 * concrete test motivates them.
 */

type MessageCallback = (event: MessageEvent) => void;

export class ControllableWebSocket {
  private inner: WebSocket;
  private paused = false;
  private inboundQueue: MessageEvent[] = [];
  private onMessageHandler: MessageCallback | null = null;
  private addedMessageListeners: MessageCallback[] = [];

  constructor(url: string | URL, protocols?: string | string[]) {
    this.inner = new WebSocket(url, protocols);

    // Intercept all inbound messages from the real WebSocket
    this.inner.onmessage = (event: MessageEvent) => {
      this.handleInbound(event);
    };
  }

  private handleInbound(event: MessageEvent): void {
    if (this.paused) {
      this.inboundQueue.push(event);
    } else {
      this.deliverMessage(event);
    }
  }

  private deliverMessage(event: MessageEvent): void {
    // Deliver to onmessage handler
    this.onMessageHandler?.(event);
    // Deliver to all addEventListener('message', ...) handlers
    for (const listener of this.addedMessageListeners) {
      listener(event);
    }
  }

  pauseInbound(): void {
    this.paused = true;
  }

  resumeInbound(): void {
    this.paused = false;
    while (this.inboundQueue.length > 0) {
      const msg = this.inboundQueue.shift();
      if (msg) this.deliverMessage(msg);
    }
  }

  // ─── WebSocket interface passthrough ───

  get url(): string {
    return this.inner.url;
  }
  get readyState(): number {
    return this.inner.readyState;
  }
  get bufferedAmount(): number {
    return this.inner.bufferedAmount;
  }
  get extensions(): string {
    return this.inner.extensions;
  }
  get protocol(): string {
    return this.inner.protocol;
  }
  get binaryType(): BinaryType {
    return this.inner.binaryType;
  }
  set binaryType(value: BinaryType) {
    this.inner.binaryType = value;
  }

  get onopen(): ((this: WebSocket, ev: Event) => unknown) | null {
    return this.inner.onopen;
  }
  set onopen(handler: ((this: WebSocket, ev: Event) => unknown) | null) {
    this.inner.onopen = handler;
  }

  get onclose(): ((this: WebSocket, ev: CloseEvent) => unknown) | null {
    return this.inner.onclose;
  }
  set onclose(handler: ((this: WebSocket, ev: CloseEvent) => unknown) | null) {
    this.inner.onclose = handler;
  }

  get onerror(): ((this: WebSocket, ev: Event) => unknown) | null {
    return this.inner.onerror;
  }
  set onerror(handler: ((this: WebSocket, ev: Event) => unknown) | null) {
    this.inner.onerror = handler;
  }

  get onmessage(): ((this: WebSocket, ev: MessageEvent) => unknown) | null {
    return this.onMessageHandler as ((this: WebSocket, ev: MessageEvent) => unknown) | null;
  }
  set onmessage(handler: ((this: WebSocket, ev: MessageEvent) => unknown) | null) {
    this.onMessageHandler = handler as MessageCallback | null;
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.inner.send(data);
  }

  close(code?: number, reason?: string): void {
    this.inner.close(code, reason);
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (type === 'message') {
      // Track message listeners so we can replay queued messages through them
      const cb: MessageCallback =
        typeof listener === 'function'
          ? (listener as MessageCallback)
          : (event: MessageEvent) => (listener as EventListenerObject).handleEvent(event);
      this.addedMessageListeners.push(cb);
    } else {
      this.inner.addEventListener(type, listener, options);
    }
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void {
    if (type === 'message') {
      const cb = typeof listener === 'function' ? (listener as MessageCallback) : null;
      if (cb) {
        const idx = this.addedMessageListeners.indexOf(cb);
        if (idx >= 0) this.addedMessageListeners.splice(idx, 1);
      }
    } else {
      this.inner.removeEventListener(type, listener, options);
    }
  }

  dispatchEvent(event: Event): boolean {
    return this.inner.dispatchEvent(event);
  }

  // WebSocket constants
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
}
