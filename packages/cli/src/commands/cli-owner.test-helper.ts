interface CliOwner {
  connected?: boolean;
  channel?: { unref(): void };
  once(event: 'disconnect', listener: () => void): unknown;
}

export function watchCliOwner(owner: CliOwner, stop: () => void): void {
  if (!owner.connected) {
    stop();
    return;
  }
  owner.once('disconnect', stop);
  owner.channel?.unref();
}
