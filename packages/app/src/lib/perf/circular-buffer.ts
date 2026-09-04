export class CircularBuffer<T> {
  private readonly capacity: number;
  private readonly slots: Array<T | undefined>;
  private head = 0;
  private size = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`CircularBuffer capacity must be a positive integer (got ${capacity})`);
    }
    this.capacity = capacity;
    this.slots = new Array<T | undefined>(capacity);
  }

  push(item: T): void {
    this.slots[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }

  toArray(): T[] {
    const out: T[] = new Array<T>(this.size);
    if (this.size < this.capacity) {
      for (let i = 0; i < this.size; i += 1) {
        out[i] = this.slots[i] as T;
      }
    } else {
      for (let i = 0; i < this.capacity; i += 1) {
        out[i] = this.slots[(this.head + i) % this.capacity] as T;
      }
    }
    return out;
  }

  get length(): number {
    return this.size;
  }

  clear(): void {
    for (let i = 0; i < this.capacity; i += 1) this.slots[i] = undefined;
    this.head = 0;
    this.size = 0;
  }
}
